import type { TInboxKind } from '@/types/inbox';

// One fixed template per notice kind (ADR-0012). `deliverPrompt` submits the
// line as a user turn, so the line carries NO caller-supplied text: only
// server-made ids, server-resolved workspace and tab ids, server-computed
// times and counts, and — for a watch, which goes only to the tab that
// registered it — that tab's own validated target. An epic slug is not typed:
// any tab may hold `epic:<words>`, so it is read with `note show`.
// A field that fails its grammar is refused, never cleaned up: cleaning is how
// a subject would leak through one character class at a time.

export class InboxFieldError extends Error {
  readonly code = 'inbox-field-invalid' as const;
}

const GRAMMAR = {
  noteId: /^n-[A-Za-z0-9_-]{4,32}$/,
  watchId: /^w-[A-Za-z0-9_-]{4,32}$/,
  deployId: /^d-[A-Za-z0-9_-]{4,32}$/,
  resumeId: /^r-[A-Za-z0-9_-]{4,32}$/,
  sha: /^[0-9a-f]{7,40}$/,
  // Server-made only: a UUID (answer ids) or a deterministic `<prefix>-<32 hex>`.
  // Producer-chosen Mission Control item ids ("question-1") are text, not ids.
  missionId: /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]{1,16}-[0-9a-f]{32})$/,
  workspaceId: /^ws-[A-Za-z0-9_-]{1,32}$/,
  tabId: /^tab-[A-Za-z0-9_-]{1,32}$/,
  // owner/repo#123, owner/repo@ref, a lease name (lease-policy grammar), or aws-sso:<profile> (ADR-0041).
  watchTarget: /^(?:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:#\d{1,7}|@[A-Za-z0-9_./-]{1,100})|[a-z][a-z0-9-]{1,31}:[a-z0-9._/@#:+-]{1,200}|aws-sso:[A-Za-z0-9._-]{1,64})$/,
} as const;

type TGrammar = keyof typeof GRAMMAR;

const field = (name: string, value: unknown, grammar: TGrammar): string => {
  if (typeof value !== 'string' || !GRAMMAR[grammar].test(value)) {
    throw new InboxFieldError(`inbox field ${name} does not match its grammar (${grammar})`);
  }
  return value;
};

const time = (name: string, value: unknown): string => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 8.64e15) {
    throw new InboxFieldError(`inbox field ${name} must be an epoch-ms integer`);
  }
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const count = (name: string, value: unknown): string => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new InboxFieldError(`inbox field ${name} must be a whole number`);
  }
  return String(value);
};

/** Which note notice this is (ADR-0013). A server enum, never caller text. */
// No `acked` event (F6): an ack types nothing into the sender, who reads the state with `purplemux note list`.
// `undelivered` (G7) goes to the sender at 15 min when the line has not reached the recipient's composer.
// `bounced` goes to the sender at once when the note has no live recipient.
export type TNoteEvent = 'delivered' | 'reminder' | 'unacked' | 'undelivered' | 'expired' | 'bounced';
const NOTE_EVENTS: readonly TNoteEvent[] = ['delivered', 'reminder', 'unacked', 'undelivered', 'expired', 'bounced'];

/** Why a note has no live recipient: the server's routing reasons, and the words a bounced line types for each. */
export const NOTE_BOUNCE_REASONS = {
  'target-epic-unowned': 'nobody live holds its epic',
  'target-coordinator-unavailable': 'its target workspace has no live orchestrator',
} as const;
export type TNoteBounceReason = keyof typeof NOTE_BOUNCE_REASONS;

export const isNoteBounceReason = (value: unknown): value is TNoteBounceReason =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(NOTE_BOUNCE_REASONS, value);

/**
 * The words after "from" in a note line, and the note view's `fromLabel` (ADR-0013, ADR-0029): one
 * owner of the vocabulary. The inputs are server-made: the stored sender ids and the admission mode.
 * It checks no grammar; the inbox template checks its fields before it calls this.
 */
export const noteFromWords = (from: {
  workspaceId: string | null;
  tabId: string | null;
  human: boolean;
  owner: boolean;
}): string => {
  if (from.human) return 'human';
  if (from.workspaceId === null) return 'admin';
  const party = `${from.workspaceId}/${from.tabId === null ? 'workspace' : from.tabId}`;
  return from.owner ? `owner (${party})` : party;
};

/**
 * `fromWorkspaceId: null` is an admin-token or human sender; `fromHuman` disambiguates them.
 * `fromOwner` marks a note sent under an owner grant (ADR-0029); it needs a sender workspace.
 * `fromTabId: null` is a workspace token with no tab.
 * `event` defaults to `delivered`; `reminder` goes to the recipient, `unacked`, `undelivered`, `expired` and `bounced`
 * to the sender. `reason` is required on `bounced` alone.
 */
export interface INoteFields { noteId: string; fromWorkspaceId: string | null; fromTabId: string | null;
  fromHuman?: boolean; fromOwner?: boolean; sentAt: number; event?: TNoteEvent; reason?: TNoteBounceReason }
/** What a watch notice reports (ADR-0015). Every value is a server enum or a grammar-checked id. */
export type TWatchNotice = 'merged' | 'closed' | 'head-moved' | 'checks-settled' | 'moved' | 'free' | 'signed-in' | 'failing' | 'expired';
const WATCH_NOTICES: readonly TWatchNotice[] = ['merged', 'closed', 'head-moved', 'checks-settled', 'moved', 'free', 'signed-in', 'failing', 'expired'];
const WATCH_FAILURES = ['http-404', 'http-403', 'timeout', 'auth', 'gh-missing', 'sso-config', 'other'] as const;
const WATCH_UNTILS = ['merged', 'closed', 'head-moved', 'checks-settled', 'moved', 'free', 'signed-in'] as const;

/**
 * `sha` is the head (or ref) now, `fromSha` the baseline; `green`/`red` count settled checks;
 * `code` is a failing notice's server-classified token; `until` the condition an expired watch waited for;
 * `expiresAt` the SSO token's own expiry on a `signed-in` notice (ADR-0041).
 */
export interface IWatchFields {
  watchId: string;
  target: string;
  notice: TWatchNotice;
  sha?: string;
  fromSha?: string;
  green?: number;
  red?: number;
  /** Successful checks only; neutral and skipped checks do not prove a CI dependency cleared. */
  successful?: number;
  code?: (typeof WATCH_FAILURES)[number];
  until?: (typeof WATCH_UNTILS)[number];
  expiresAt?: number;
}
export interface IDeployFields { deployId: string; restartAt: number; inMinutes: number }
/**
 * Mission Control (story 12). `answer` (the default): an answer is waiting; the ack command is pulled with
 * `mission answers`. `bootstrap`: a reconcile request; its steps are pulled with `mission bootstrap`.
 * `bootstrapKey` is server-made (`boot-<32 hex>`), never the caller's bootstrap id.
 */
export type IMissionFields =
  | { event?: 'answer'; answerId: string; workspaceId: string; readyAt: number }
  | { event: 'bootstrap'; bootstrapKey: string; workspaceId: string };
export interface IResumeFields { resumeId: string }

export interface IInboxFields {
  note: INoteFields;
  watch: IWatchFields;
  deploy: IDeployFields;
  mission: IMissionFields;
  resume: IResumeFields;
}

/** The checked id and the sender words every note line starts with (ADR-0013). */
const noteHead = (f: INoteFields): { id: string; from: string; owner: boolean } => {
  const id = field('noteId', f.noteId, 'noteId');
  if (f.fromHuman !== undefined && typeof f.fromHuman !== 'boolean') {
    throw new InboxFieldError('inbox field fromHuman must be boolean');
  }
  if (f.fromOwner !== undefined && typeof f.fromOwner !== 'boolean') {
    throw new InboxFieldError('inbox field fromOwner must be boolean');
  }
  const human = f.fromHuman === true;
  const owner = !human && f.fromOwner === true;
  if (owner && f.fromWorkspaceId === null) throw new InboxFieldError('inbox field fromOwner needs fromWorkspaceId');
  const checked = human || f.fromWorkspaceId === null
    ? { workspaceId: f.fromWorkspaceId, tabId: f.fromTabId }
    : {
      workspaceId: field('fromWorkspaceId', f.fromWorkspaceId, 'workspaceId'),
      tabId: f.fromTabId === null ? null : field('fromTabId', f.fromTabId, 'tabId'),
    };
  return { id, from: noteFromWords({ ...checked, human, owner }), owner };
};

type TRenderer<K extends TInboxKind> = (fields: IInboxFields[K]) => { recordId: string; line: string };

const TEMPLATES: { [K in TInboxKind]: TRenderer<K> } = {
  note: (f) => {
    const { id, from } = noteHead(f);
    const event = f.event ?? 'delivered';
    if (!NOTE_EVENTS.includes(event)) throw new InboxFieldError('inbox field event is not a note event');
    const at = time('sentAt', f.sentAt);
    const read = `purplemux note show ${id}`;
    const bounced = () => {
      if (!isNoteBounceReason(f.reason)) throw new InboxFieldError('inbox field reason is not a bounce reason');
      return `[purplemux note ${id}] you sent it at ${at}; it bounced (${f.reason}): ${NOTE_BOUNCE_REASONS[f.reason]}`
        + ` — it waits for a recipient until it expires; ${read}`;
    };
    if (event === 'bounced') return { recordId: id, line: bounced() };
    const line = {
      delivered: `[purplemux note ${id}] from ${from} at ${at} — ${read}, then purplemux note ack ${id}`,
      reminder: `[purplemux note ${id}] from ${from} at ${at} is still unacked — ${read}, then purplemux note ack ${id}`,
      unacked: `[purplemux note ${id}] you sent it at ${at}; it is still unacked after 60 min — ${read}`,
      undelivered: `[purplemux note ${id}] you sent it at ${at}; it has not reached its recipient's composer after 15 min — ${read}`,
      expired: `[purplemux note ${id}] you sent it at ${at}; it expired unacked — ${read}`,
    }[event];
    return { recordId: id, line };
  },
  watch: (f) => {
    const id = field('watchId', f.watchId, 'watchId');
    const target = field('target', f.target, 'watchTarget');
    if (!WATCH_NOTICES.includes(f.notice)) throw new InboxFieldError('inbox field notice is not a watch notice');
    const sha = (name: 'sha' | 'fromSha') => field(name, f[name], 'sha').slice(0, 8);
    const oneOf = <T extends string>(name: string, value: unknown, allowed: readonly T[]): T => {
      if (!allowed.includes(value as T)) throw new InboxFieldError(`inbox field ${name} is not one of its values`);
      return value as T;
    };
    const cleared = ' — watch cleared';
    const text = {
      merged: () => `${target} is MERGED (${sha('sha')})${cleared}`,
      closed: () => `${target} is CLOSED without a merge (${sha('sha')})${cleared}`,
      'head-moved': () => `${target} head moved ${sha('fromSha')} -> ${sha('sha')}${cleared}`,
      'checks-settled': () => `${target} checks settled at ${sha('sha')}: ${count('green', f.green)} green, ${count('red', f.red)} red${cleared}`,
      moved: () => `${target} moved ${sha('fromSha')} -> ${sha('sha')}${cleared}`,
      free: () => `${target} is free${cleared}`,
      'signed-in': () => `${target} is signed in: its SSO token is valid until ${time('expiresAt', f.expiresAt)}; retry the step that needed it${cleared}`,
      failing: () => `${target} is failing: ${oneOf('code', f.code, WATCH_FAILURES)} — purplemux watch list shows the error; still trying until it expires`,
      expired: () => `${target} expired without ${oneOf('until', f.until, WATCH_UNTILS)}${cleared}`,
    }[f.notice]();
    return { recordId: id, line: `[purplemux watch ${id}] ${text}` };
  },
  deploy: (f) => {
    const id = field('deployId', f.deployId, 'deployId');
    // Story 13: when, how soon, and what to do. The reason is pulled with `deploy status`.
    const at = time('restartAt', f.restartAt);
    const minutes = count('inMinutes', f.inMinutes);
    return { recordId: id, line: `[purplemux deploy ${id}] purplemux restarts at ~${at} (in ${minutes} min) — details: purplemux deploy status ${id}; reach a checkpoint; tabs survive, in-flight hook events do not` };
  },
  mission: (f) => {
    if (f.event === 'bootstrap') {
      const key = field('bootstrapKey', f.bootstrapKey, 'missionId');
      return { recordId: key, line: `[purplemux mission ${key}] Mission Control asks this orchestrator to reconcile — read: purplemux mission bootstrap -w ${field('workspaceId', f.workspaceId, 'workspaceId')}` };
    }
    if (f.event !== undefined && f.event !== 'answer') throw new InboxFieldError('inbox field event is not a mission event');
    const id = field('answerId', f.answerId, 'missionId');
    return { recordId: id, line: `[purplemux mission ${id}] an answer is ready at ${time('readyAt', f.readyAt)} — purplemux mission answers -w ${field('workspaceId', f.workspaceId, 'workspaceId')}; ack it with the command shown there after applying it` };
  },
  // ADR-0018 amendment (story 26): the text is fixed; only the id varies.
  resume: (f) => {
    const id = field('resumeId', f.resumeId, 'resumeId');
    return { recordId: id, line: `[purplemux resume ${id}] the last turn ended on an API error — continue from where it was cut off` };
  },
};

export const renderInboxLine = <K extends TInboxKind>(kind: K, fields: IInboxFields[K]): { recordId: string; line: string } => {
  const render = TEMPLATES[kind] as TRenderer<K> | undefined;
  if (!render || !Object.hasOwn(TEMPLATES, kind)) throw new InboxFieldError(`unknown inbox kind ${String(kind)}`);
  if (typeof fields !== 'object' || fields === null) throw new InboxFieldError('inbox fields must be an object');
  return render(fields);
};

/**
 * The one line `note point` types (G7): the note grammar, server fields only, and "owner decision" only for a note
 * sent under an owner grant, since a coordinator's admission says nothing about who decided.
 */
export const renderNotePointerLine = (f: INoteFields): string => {
  const { id, from, owner } = noteHead(f);
  const at = time('sentAt', f.sentAt);
  const what = owner ? 'carries an owner decision' : 'needs action now';
  return `[purplemux note ${id}] from ${from} at ${at} ${what}: run purplemux note show ${id} now, then purplemux note ack ${id}`;
};

export const INBOX_KINDS = Object.keys(TEMPLATES) as TInboxKind[];
