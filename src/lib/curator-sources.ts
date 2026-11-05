import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';
import type { ILabelledItem, ITwinLocator } from '@/lib/curator-store';
import { readMessageHistory } from '@/lib/message-history-store';
import { TURN_TAIL_CHARS } from '@/lib/turn-end';

// Where a labelled id's text lives (AC 4): the sets hold ids, and the text is read here at evaluation time.
//   owner message  `<workspaceId>/<historyEntryId>`             -> that workspace's message-history.json
//   turn ending    `<workspaceId>/<sessionId>/<assistantUuid>`  -> that workspace's Claude transcript
//   MC ask         `<workspaceId>/mc/<itemId>`                  -> the Mission Control item an agent opened
// A turn ending's text is what the watchdog reads at a stop: the entry's last text block, trimmed, last 600 chars.
// An owner message also carries `alt`, its transcript twin (consult 16-promote-gate, ruling 3): the history trims at 500
// entries a workspace, so the text is found there again once its history entry is gone.

const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]+$/;
const SESSION_ID = /^[0-9a-f-]{36}$/;

export const workspacesRoot = (): string => path.join(os.homedir(), '.purplemux', 'workspaces');

export interface ITranscriptTurnEnd {
  id: string;
  at: number;
  text: string;
}

interface IAssistantEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { stop_reason?: string | null; content?: unknown };
}

/** The last non-empty text block of an assistant entry, trimmed, or null. */
export const assistantText = (entry: IAssistantEntry): string | null => {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i] as { type?: string; text?: string };
    if (block.type === 'text' && block.text?.trim()) return block.text.trim();
  }
  return null;
};

export const turnTail = (text: string): string => text.slice(-TURN_TAIL_CHARS);

/** Every transcript of a workspace's Claude home: `<projects>/<dir>/<sessionId>.jsonl`. */
export const workspaceTranscripts = async (workspaceId: string): Promise<string[]> => {
  if (!WORKSPACE_ID.test(workspaceId)) return [];
  const projects = path.join(workspacesRoot(), workspaceId, 'claude-home', 'projects');
  const dirs = await fs.readdir(projects, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const dir of dirs.filter((d) => d.isDirectory())) {
    const names = await fs.readdir(path.join(projects, dir.name)).catch(() => [] as string[]);
    for (const name of names) {
      if (name.endsWith('.jsonl') && SESSION_ID.test(name.slice(0, -6))) files.push(path.join(projects, dir.name, name));
    }
  }
  return files.sort();
};

/** The turn endings of one transcript: main-thread assistant entries that stopped on `end_turn` with text. */
export const transcriptTurnEnds = async (workspaceId: string, file: string): Promise<ITranscriptTurnEnd[]> => {
  const sessionId = path.basename(file, '.jsonl');
  const out: ITranscriptTurnEnd[] = [];
  const lines = createInterface({ input: createReadStream(file, 'utf-8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"end_turn"')) continue;
    let entry: IAssistantEntry;
    try {
      entry = JSON.parse(line) as IAssistantEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain || entry.message?.stop_reason !== 'end_turn' || !entry.uuid) continue;
    const text = assistantText(entry);
    if (!text) continue;
    out.push({ id: `${workspaceId}/${sessionId}/${entry.uuid}`, at: Date.parse(entry.timestamp ?? '') || 0, text: turnTail(text) });
  }
  return out;
};

/** An agent's ask as the owner reads it: the decision line, then the context, cut like a turn ending. */
export const missionAskText = (questionJson: string): string | null => {
  try {
    const q = JSON.parse(questionJson) as { decision?: unknown; title?: unknown; context?: unknown };
    const head = typeof q.decision === 'string' && q.decision.trim() ? q.decision : typeof q.title === 'string' ? q.title : '';
    const text = [head.trim(), typeof q.context === 'string' ? q.context.trim() : ''].filter(Boolean).join('\n');
    return text ? text.slice(0, TURN_TAIL_CHARS) : null;
  } catch {
    return null;
  }
};

export const missionControlFile = (): string => path.join(os.homedir(), '.purplemux', 'mission-control.sqlite');

/** Read-only: the evaluation never writes Mission Control, and a reader beside the server's WAL writer is safe. */
export const readMissionAsks = (ids: readonly string[] | null): Array<{ id: string; workspaceId: string; humanNeed: string | null; text: string; createdAt: number }> => {
  let db: Database.Database;
  try {
    db = new Database(missionControlFile(), { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(`SELECT id, workspace_id, question_json, created_at, json_extract(human_review_json, '$.humanNeed') AS need
      FROM attention_items ORDER BY created_at, id`).all() as Array<{ id: string; workspace_id: string; question_json: string; created_at: number; need: string | null }>;
    const wanted = ids ? new Set(ids) : null;
    // The curator's own spot-check items are never an agent's ask (review r2 F6).
    return rows.filter((row) => !row.id.startsWith('curator-spot-check-') && (!wanted || wanted.has(row.id))).flatMap((row) => {
      const text = missionAskText(row.question_json);
      return text ? [{ id: row.id, workspaceId: row.workspace_id, humanNeed: row.need, text, createdAt: row.created_at }] : [];
    });
  } finally {
    db.close();
  }
};

interface IUserEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

/** A main-thread user entry's typed text, or null for a tool result or an entry with no text. */
export const userText = (entry: IUserEntry): string | null => {
  if (entry.type !== 'user' || entry.isSidechain) return null;
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content) || content.some((b) => (b as { type?: string }).type === 'tool_result')) return null;
  const text = content.flatMap((b) => ((b as { type?: string; text?: string }).type === 'text' ? [(b as { text: string }).text] : [])).join('\n');
  return text.trim() ? text : null;
};

export interface ITranscriptUserEntry {
  ref: string;
  at: number;
  text: string;
  /** Filled on first use by findTwin. */
  collapsed?: string;
}

export const transcriptUserEntries = async (workspaceId: string, file: string): Promise<ITranscriptUserEntry[]> => {
  const sessionId = path.basename(file, '.jsonl');
  const out: ITranscriptUserEntry[] = [];
  const lines = createInterface({ input: createReadStream(file, 'utf-8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"type":"user"') || line.includes('"tool_result"')) continue;
    let entry: IUserEntry;
    try {
      entry = JSON.parse(line) as IUserEntry;
    } catch {
      continue;
    }
    const text = userText(entry);
    if (text && entry.uuid) out.push({ ref: `${workspaceId}/${sessionId}/${entry.uuid}`, at: Date.parse(entry.timestamp ?? '') || 0, text });
  }
  return out;
};

export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const sha16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Where an owner message occurs in the transcripts: an entry equal to it first, then one holding it, then one holding
 * it after whitespace collapse; among the matches, the entry nearest the message's send time. null when none holds it.
 */
export const findTwin = (message: string, sentAt: number, entries: readonly ITranscriptUserEntry[]): ITwinLocator | null => {
  const nearest = (hits: ITranscriptUserEntry[]): ITranscriptUserEntry | undefined =>
    [...hits].sort((a, b) => Math.abs(a.at - sentAt) - Math.abs(b.at - sentAt))[0];
  const holding = entries.filter((entry) => entry.text.includes(message));
  const raw = nearest(holding.filter((entry) => entry.text === message)) ?? nearest(holding);
  if (raw) return { ref: raw.ref, start: raw.text.indexOf(message), length: message.length, mode: 'raw', sha: sha16(message) };
  const wanted = collapse(message);
  if (!wanted) return null;
  const folded = nearest(entries.filter((entry) => (entry.collapsed ??= collapse(entry.text)).includes(wanted)));
  return folded
    ? { ref: folded.ref, start: folded.collapsed!.indexOf(wanted), length: wanted.length, mode: 'collapsed', sha: sha16(wanted) }
    : null;
};

const findTranscript = async (workspaceId: string, sessionId: string): Promise<string | null> =>
  (await workspaceTranscripts(workspaceId)).find((file) => path.basename(file, '.jsonl') === sessionId) ?? null;

const twinText = async (alt: ITwinLocator, cache: Map<string, Map<string, string>>): Promise<string | null> => {
  const [workspaceId, sessionId, uuid] = alt.ref.split('/');
  if (!WORKSPACE_ID.test(workspaceId ?? '') || !SESSION_ID.test(sessionId ?? '') || !uuid) return null;
  const key = `users:${workspaceId}/${sessionId}`;
  if (!cache.has(key)) {
    const file = await findTranscript(workspaceId, sessionId);
    cache.set(key, new Map(file ? (await transcriptUserEntries(workspaceId, file)).map((e) => [e.ref, e.text]) : []));
  }
  const text = cache.get(key)!.get(alt.ref);
  if (text === undefined) return null;
  const slice = (alt.mode === 'collapsed' ? collapse(text) : text).slice(alt.start, alt.start + alt.length);
  return sha16(slice) === alt.sha ? slice : null;
};

/**
 * The text behind a labelled item, or null when it can no longer be read: the history entry by id, else (owner
 * messages) its transcript twin, verified by hash; a turn ending or an MC ask by its one source. Reads are cached
 * per call site through `cache`.
 */
export const resolveLabelledText = async (
  item: string | Pick<ILabelledItem, 'id' | 'alt'>,
  cache: Map<string, Map<string, string>> = new Map(),
): Promise<string | null> => {
  const { id, alt } = typeof item === 'string' ? { id: item, alt: undefined } : item;
  const parts = id.split('/');
  const [workspaceId] = parts;
  if (!WORKSPACE_ID.test(workspaceId)) return null;
  if (parts.length === 2) {
    const key = `history:${workspaceId}`;
    if (!cache.has(key)) cache.set(key, new Map((await readMessageHistory(workspaceId)).map((entry) => [entry.id, entry.message])));
    return cache.get(key)!.get(parts[1]) ?? (alt ? twinText(alt, cache) : null);
  }
  if (parts.length === 3 && parts[1] === 'mc') {
    const key = 'mission-control';
    if (!cache.has(key)) cache.set(key, new Map(readMissionAsks(null).map((ask) => [`${ask.workspaceId}/mc/${ask.id}`, ask.text])));
    return cache.get(key)!.get(id) ?? null;
  }
  if (parts.length !== 3 || !SESSION_ID.test(parts[1])) return null;
  const key = `transcript:${workspaceId}/${parts[1]}`;
  if (!cache.has(key)) {
    const file = await findTranscript(workspaceId, parts[1]);
    cache.set(key, new Map(file ? (await transcriptTurnEnds(workspaceId, file)).map((turn) => [turn.id, turn.text]) : []));
  }
  return cache.get(key)!.get(id) ?? null;
};
