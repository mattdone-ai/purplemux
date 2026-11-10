import fs from 'fs/promises';
import { listCodexSessionFiles, readCodexSessionHead } from '@/lib/codex-session-list';
import { entrySearchText, isSearchableEntry, type TSearchableEntryType, type TToolTextLookup } from '@/lib/entry-text';
import { isAllowedJsonlPath } from '@/lib/path-validation';
import { listAllGrokSessions } from '@/lib/providers/grok/session-store';
import { readSearchDocs, writeSearchDocs, type ISearchDoc } from '@/lib/search-cache';
import { extractJsonlDocsFromContent, type TSearchProvider } from '@/lib/search-extract';
import { buildSessionKey } from '@/lib/session-key';
import { listClaudeTranscripts } from '@/lib/session-resolver';
import { codexSessionIdFromJsonlPath } from '@/lib/session-parser-codex';
import {
  globalScope,
  listSessionScopes,
  scopeForCwd,
  sessionScopeFor,
  type ISessionScope,
} from '@/lib/session-scope';
import type { ITimelineEntry } from '@/types/timeline';

export const SEARCH_PROVIDERS = ['claude', 'codex', 'grok'] as const;

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 200;
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 100;
export const SNIPPET_MAX_LENGTH = 200;

/**
 * Ceiling on hits collected in one scan. Sources are visited newest-first, so
 * the cap drops the oldest sessions rather than an arbitrary set, and the
 * response says `truncated` when it fires.
 */
export const MAX_SCAN_HITS = 1000;

/**
 * Work budget for one scan, in bytes-read-equivalent, so a query stays inside
 * the latency budget on a corpus that has outgrown it. Measured on host-b
 * (2.2 GB of transcripts): reading runs at ~210 MB/s and parsing at ~55 MB/s,
 * so a parsed session is charged `PARSE_COST_FACTOR` times its size and a
 * session already in the text cache is charged nothing. A scan that stops on
 * this budget reports `truncated`, and sources are visited newest-first, so
 * what it drops is the oldest end of the archive.
 */
export const MAX_SCAN_COST = 384 * 1024 * 1024;

const PARSE_COST_FACTOR = 4;

const SOURCE_CONCURRENCY = 8;
const ELLIPSIS = '…';

export interface ISearchHit {
  sessionKey: string;
  seq: number;
  entryId: string;
  type: TSearchableEntryType;
  timestamp: number;
  snippet: string;
  workspaceId: string;
  workspaceName: string;
}

/** A hit plus the session ordering key; the wire hit carries neither. */
export interface IRankedHit extends ISearchHit {
  lastActivityMs: number;
}

export interface ISearchResponse {
  hits: ISearchHit[];
  total: number;
  truncated: boolean;
}

export interface ISearchRequest {
  terms: string[];
  workspaceId: string | null;
  provider: TSearchProvider | null;
  limit: number;
  offset: number;
}

export const parseSearchTerms = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).filter(Boolean);

/** Case-insensitive, every term present — the same rule the on-device index applies. */
export const matchText = (text: string, terms: string[]): boolean => {
  if (terms.length === 0) return false;
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

export const matchEntry = (
  entry: ITimelineEntry,
  terms: string[],
  toolText?: TToolTextLookup,
): boolean => isSearchableEntry(entry) && matchText(entrySearchText(entry, toolText), terms);

const firstMatch = (text: string, terms: string[]): { index: number; length: number } => {
  const haystack = text.toLowerCase();
  let index = -1;
  let length = 0;

  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at < 0) continue;
    if (index === -1 || at < index) {
      index = at;
      length = term.length;
    }
  }

  return index === -1 ? { index: 0, length: 0 } : { index, length };
};

/**
 * A window of at most `SNIPPET_MAX_LENGTH` characters — ellipses included —
 * centred on the earliest matching term. Whitespace is collapsed after the
 * window is cut so the offsets stay those of the stored text.
 */
export const makeSnippet = (text: string, terms: string[]): string => {
  if (text.length <= SNIPPET_MAX_LENGTH) return text.replace(/\s+/g, ' ').trim();

  const { index, length } = firstMatch(text, terms);
  const pad = Math.max(0, Math.floor((SNIPPET_MAX_LENGTH - length) / 2));
  let start = Math.max(0, index - pad);
  const end = Math.min(text.length, start + SNIPPET_MAX_LENGTH);
  start = Math.max(0, end - SNIPPET_MAX_LENGTH);

  const lead = start > 0 ? ELLIPSIS : '';
  const tail = end < text.length ? ELLIPSIS : '';
  const body = text.slice(start, end - lead.length - tail.length);

  return `${lead}${body.replace(/\s+/g, ' ').trim()}${tail}`;
};

/**
 * Newest session first, then forward through that session. Sessions with the
 * same activity time break on the session key so a client paging with `offset`
 * walks a stable order.
 */
export const rankHits = (hits: IRankedHit[]): IRankedHit[] =>
  [...hits].sort((a, b) => (
    b.lastActivityMs - a.lastActivityMs
    || (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0)
    || a.seq - b.seq
  ));

interface ISourceLoader {
  jsonlPath: string;
  provider: TSearchProvider;
}

interface ISearchSource {
  cacheId: string;
  fingerprint: string;
  /** Bytes a cold read of this source costs, whatever store it lives in. */
  sizeBytes: number;
  sessionKey: string;
  workspaceId: string;
  workspaceName: string;
  lastActivityMs: number;
  loader: ISourceLoader;
}

const claudeSources = async (scopes: ISessionScope[]): Promise<ISearchSource[]> => {
  const perScope = await Promise.all(scopes.map(async (scope) => {
    const transcripts = await listClaudeTranscripts(scope.workspaceId);
    const sources = await Promise.all(transcripts.map(async ({ sessionId, jsonlPath }): Promise<ISearchSource | null> => {
      if (!isAllowedJsonlPath(jsonlPath)) return null;
      let stat;
      try {
        stat = await fs.stat(jsonlPath);
      } catch {
        return null;
      }
      return {
        cacheId: jsonlPath,
        fingerprint: `${stat.mtimeMs}:${stat.size}`,
        sizeBytes: stat.size,
        sessionKey: buildSessionKey({
          provider: 'claude',
          workspaceId: sessionScopeFor({ provider: 'claude', scopes, workspaceId: scope.id }).workspaceId,
          sessionId,
        }),
        workspaceId: scope.id,
        workspaceName: scope.name,
        lastActivityMs: stat.mtimeMs,
        loader: { jsonlPath, provider: 'claude' },
      };
    }));
    return sources.filter((source): source is ISearchSource => source !== null);
  }));

  return perScope.flat();
};

/**
 * Codex and grok key their stores by working directory, not by workspace, so a
 * hit is REPORTED under the workspace that lists its cwd. One that matches none
 * is reported under the global scope — the same place its transcript is
 * reachable from. The sessionKey is a separate question, answered for every
 * route by `sessionScopeFor`.
 */
const codexSources = async (
  scopes: ISessionScope[],
  requestedScope: ISessionScope | null,
): Promise<ISearchSource[]> => {
  const files = await listCodexSessionFiles();

  const sources = await Promise.all(files.map(async (jsonlPath): Promise<ISearchSource | null> => {
    if (!isAllowedJsonlPath(jsonlPath)) return null;
    let stat;
    try {
      stat = await fs.stat(jsonlPath);
    } catch {
      return null;
    }

    const head = await readCodexSessionHead(jsonlPath);
    const scope = scopeForCwd(scopes, head.cwd) ?? globalScope();
    if (requestedScope && scope.id !== requestedScope.id) return null;

    const sessionId = head.sessionId ?? codexSessionIdFromJsonlPath(jsonlPath);
    if (!sessionId) return null;

    return {
      cacheId: jsonlPath,
      fingerprint: `${stat.mtimeMs}:${stat.size}`,
      sizeBytes: stat.size,
      sessionKey: buildSessionKey({
        provider: 'codex',
        workspaceId: sessionScopeFor({ provider: 'codex', scopes, cwd: head.cwd }).workspaceId,
        sessionId,
      }),
      workspaceId: scope.id,
      workspaceName: scope.name,
      lastActivityMs: stat.mtimeMs,
      loader: { jsonlPath, provider: 'codex' },
    };
  }));

  return sources.filter((source): source is ISearchSource => source !== null);
};

/**
 * grok isolates by `GROK_HOME`, so a session's workspace is the home it sits
 * under — not its cwd. The hit is still REPORTED under the workspace that lists
 * that cwd when the session is unscoped, which is where its transcript is
 * reachable from.
 *
 * That leaves a known asymmetry, kept deliberately: an ad-hoc session in
 * `~/.grok` whose cwd falls inside workspace W is returned by a
 * `workspaceId=W` SEARCH while its `sessionKey` stays `grok:global:<id>`, so
 * `sessions-v2?workspaceId=W` — which lists by home — never shows it. Scoping
 * the key by cwd instead would give grok a second workspace derivation, and
 * `sessionScopeFor` is deliberately the only one.
 */
const grokSources = async (
  scopes: ISessionScope[],
  requestedScope: ISessionScope | null,
): Promise<ISearchSource[]> => {
  const refs = await listAllGrokSessions();

  const sources = await Promise.all(refs.map(async (ref): Promise<ISearchSource | null> => {
    if (!isAllowedJsonlPath(ref.jsonlPath)) return null;
    let stat;
    try {
      stat = await fs.stat(ref.jsonlPath);
    } catch {
      return null;
    }

    const owner = ref.workspaceId
      ? scopes.find((scope) => scope.id === ref.workspaceId)
      : scopeForCwd(scopes, ref.cwd);
    const scope = owner ?? globalScope();
    if (requestedScope && scope.id !== requestedScope.id) return null;

    return {
      cacheId: ref.jsonlPath,
      fingerprint: `${stat.mtimeMs}:${stat.size}`,
      sizeBytes: stat.size,
      sessionKey: buildSessionKey({
        provider: 'grok',
        workspaceId: sessionScopeFor({ provider: 'grok', scopes, workspaceId: ref.workspaceId }).workspaceId,
        sessionId: ref.sessionId,
      }),
      workspaceId: scope.id,
      workspaceName: scope.name,
      lastActivityMs: stat.mtimeMs,
      loader: { jsonlPath: ref.jsonlPath, provider: 'grok' },
    };
  }));

  return sources.filter((source): source is ISearchSource => source !== null);
};

export interface ISearchSourceSummary {
  sessionKey: string;
  workspaceId: string;
  sizeBytes: number;
}

/** The sources one request would scan — exported so the cost accounting is testable. */
export const collectSearchSources = async (request: ISearchRequest): Promise<ISearchSourceSummary[]> =>
  (await collectSources(request)).map(({ sessionKey, workspaceId, sizeBytes }) => ({
    sessionKey,
    workspaceId,
    sizeBytes,
  }));

const collectSources = async (request: ISearchRequest): Promise<ISearchSource[]> => {
  const scopes = await listSessionScopes();
  const requestedScope = request.workspaceId
    ? scopes.find((scope) => scope.id === request.workspaceId) ?? null
    : null;
  if (request.workspaceId && !requestedScope) return [];

  const claudeScopes = requestedScope ? [requestedScope] : scopes;
  const wants = (provider: TSearchProvider) => request.provider === null || request.provider === provider;

  const [claude, codex, grok] = await Promise.all([
    wants('claude') ? claudeSources(claudeScopes) : Promise.resolve([]),
    wants('codex') ? codexSources(scopes, requestedScope) : Promise.resolve([]),
    wants('grok') ? grokSources(scopes, requestedScope) : Promise.resolve([]),
  ]);

  return [...claude, ...codex, ...grok].sort((a, b) => (
    b.lastActivityMs - a.lastActivityMs
    || (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0)
  ));
};

/**
 * Characters whose JSON encoding can differ from the term as typed — a quote or
 * a backslash is escaped in the record, and punctuation may sit either side of
 * whitespace a writer chose to emit. A term holding one of these skips the raw
 * pre-filter and is answered by parsing, which is slower but exact.
 */
const RAW_UNSAFE_TERM = /["\\{}:,\s\u0000-\u001f]/;

const escapeRegExp = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether the raw transcript can be tested for the query without parsing it.
 *
 * Parsing dominates a cold scan — a corpus of a few gigabytes costs tens of
 * seconds — while testing the bytes costs a read the page cache usually
 * satisfies. A session whose raw text lacks a term cannot hold an entry with
 * it, so the ones that survive are the only ones worth parsing.
 */
export const canPrefilterRaw = (terms: string[]): boolean =>
  terms.every((term) => !RAW_UNSAFE_TERM.test(term));

export const rawContainsAll = (content: string, terms: string[]): boolean =>
  terms.every((term) => new RegExp(escapeRegExp(term), 'i').test(content));

const loadDocs = async (source: ISearchSource, terms: string[]): Promise<ISearchDoc[] | null> => {
  const { jsonlPath, provider } = source.loader;
  const content = await fs.readFile(jsonlPath, 'utf-8');
  if (canPrefilterRaw(terms) && !rawContainsAll(content, terms)) return null;
  return extractJsonlDocsFromContent(content, jsonlPath, provider);
};

interface IScannedSource {
  hits: IRankedHit[];
  /** What this source cost, in the units of `MAX_SCAN_COST`. */
  cost: number;
}

/**
 * Cached extraction, or a fresh one. Neither a source the pre-filter ruled out
 * nor one that failed to read is cached: the first was never extracted and the
 * next query may well match it, and the second would pin an empty result under
 * a fingerprint that is still valid.
 */
const docsFor = async (
  source: ISearchSource,
  terms: string[],
): Promise<{ docs: ISearchDoc[]; cost: number }> => {
  const cached = readSearchDocs(source.cacheId, source.fingerprint);
  if (cached) return { docs: cached, cost: 0 };

  let docs: ISearchDoc[] | null;
  try {
    docs = await loadDocs(source, terms);
  } catch {
    return { docs: [], cost: source.sizeBytes };
  }

  if (docs === null) return { docs: [], cost: source.sizeBytes };
  writeSearchDocs(source.cacheId, source.fingerprint, docs);
  return { docs, cost: source.sizeBytes * PARSE_COST_FACTOR };
};

const scanSource = async (source: ISearchSource, terms: string[]): Promise<IScannedSource> => {
  const { docs, cost } = await docsFor(source, terms);
  const hits: IRankedHit[] = [];

  for (const doc of docs) {
    if (!matchText(doc.text, terms)) continue;
    hits.push({
      sessionKey: source.sessionKey,
      seq: doc.seq,
      entryId: doc.entryId,
      type: doc.type,
      timestamp: doc.timestamp,
      snippet: makeSnippet(doc.text, terms),
      workspaceId: source.workspaceId,
      workspaceName: source.workspaceName,
      lastActivityMs: source.lastActivityMs,
    });
  }

  return { hits, cost };
};

const toWireHit = ({ lastActivityMs: _lastActivityMs, ...hit }: IRankedHit): ISearchHit => hit;

/**
 * Streaming scan over every transcript in scope. Stateless by design: hits are
 * addressed by `(sessionKey, seq)`, never by path, so the scan can be replaced
 * by an FTS index later without touching the response contract or the client.
 *
 * Sources are visited newest-first and hits rank the same way, so a scan that
 * stops on `MAX_SCAN_HITS` or `MAX_SCAN_COST` drops the oldest end of the
 * archive and never reorders what it already found. A later request that gets
 * further — the text cache makes each pass cheaper — appends older hits after
 * the ones a client already paged, which is what keeps `offset` deterministic
 * across requests.
 */
export const searchTimeline = async (request: ISearchRequest): Promise<ISearchResponse> => {
  if (request.terms.length === 0) return { hits: [], total: 0, truncated: false };

  const sources = await collectSources(request);
  const hits: IRankedHit[] = [];
  let capped = false;
  let cost = 0;

  for (let index = 0; index < sources.length && !capped; index += SOURCE_CONCURRENCY) {
    const batch = sources.slice(index, index + SOURCE_CONCURRENCY);
    const scanned = await Promise.all(batch.map((source) => scanSource(source, request.terms)));
    for (const group of scanned) {
      hits.push(...group.hits);
      cost += group.cost;
    }
    capped = hits.length >= MAX_SCAN_HITS || cost >= MAX_SCAN_COST;
  }

  const ranked = rankHits(hits);
  const page = ranked.slice(request.offset, request.offset + request.limit);

  return {
    hits: page.map(toWireHit),
    total: ranked.length,
    // Budget-stopped, per ADR-0006 — NOT "more pages exist", which `total`
    // already tells the client.
    truncated: capped,
  };
};
