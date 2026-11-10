import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { WINDOWED_INBOX_KINDS, WINDOW_DEFERRAL, WINDOW_EXEMPT_INBOX_KINDS } from '@/lib/coordinator-window';
import { humanRetryRefusal } from '@/lib/human-actions';
import { renderInboxLine, type IInboxFields } from '@/lib/inbox-templates';
import type { IInboxItem, IInboxState, THumanRetryRefusal, TInboxErrorCode, TInboxKind } from '@/types/inbox';

export class InboxError extends Error {
  constructor(readonly code: TInboxErrorCode, message: string, readonly reason: THumanRetryRefusal | null = null) {
    super(message);
  }
}

export const INBOX_MAX_REFUSALS = 30;
export const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BACKOFF_MS = [10_000, 30_000, 120_000, 300_000];
/** A recoverable hold is probed again this long after its last attempt, or earlier on a wake. */
export const HELD_REPROBE_MS = 300_000;

/** 10 s → 30 s → 2 min → 5 min, then 5 min: the wait after the nth refusal. */
export const backoffAfter = (refusals: number): number =>
  BACKOFF_MS[Math.min(Math.max(refusals, 1), BACKOFF_MS.length) - 1];

// ─── pure state transitions ──────────────────────────────────────────────

export interface IEnqueueRequest<K extends TInboxKind = TInboxKind> {
  kind: K;
  targetWorkspaceId: string;
  targetTabId: string;
  dedupeKey: string;
  fields: IInboxFields[K];
  /** Drop the item, never type it, once this time passes (IInboxItem.staleAt). */
  staleAt?: number;
}

const TARGET_WORKSPACE = /^ws-[A-Za-z0-9_-]{1,32}$/;
const TARGET_TAB = /^tab-[A-Za-z0-9_-]{1,32}$/;

export const enqueueInState = <K extends TInboxKind>(
  state: IInboxState,
  req: IEnqueueRequest<K>,
  now: number,
  newId: () => string,
): { state: IInboxState; item: IInboxItem; created: boolean } => {
  if (!TARGET_WORKSPACE.test(req.targetWorkspaceId) || !TARGET_TAB.test(req.targetTabId)) {
    throw new InboxError('inbox-field-invalid', 'inbox target must be a workspace id and a tab id');
  }
  if (typeof req.dedupeKey !== 'string' || !req.dedupeKey || req.dedupeKey.length > 200) {
    throw new InboxError('inbox-field-invalid', 'inbox dedupeKey must be 1-200 characters');
  }
  const { line } = renderInboxLine(req.kind, req.fields);
  // Per target: one key may be queued once for each recipient (a broadcast).
  const existing = state.items.find((i) => i.state === 'queued' && i.dedupeKey === req.dedupeKey
    && i.targetWorkspaceId === req.targetWorkspaceId && i.targetTabId === req.targetTabId);
  if (existing) return { state, item: existing, created: false };
  const item: IInboxItem = {
    id: newId(),
    kind: req.kind,
    targetWorkspaceId: req.targetWorkspaceId,
    targetTabId: req.targetTabId,
    dedupeKey: req.dedupeKey,
    line,
    createdAt: now,
    notBefore: now,
    attempts: 0,
    lastAttemptAt: null,
    lastRefusal: null,
    state: 'queued',
    deliveredAt: null,
    heldReason: null,
    droppedReason: null,
    expiresAt: now + INBOX_MAX_AGE_MS,
    staleAt: typeof req.staleAt === 'number' && Number.isFinite(req.staleAt) ? req.staleAt : null,
    transitionAt: now,
  };
  return { state: { items: [...state.items, item] }, item, created: true };
};

const replace = (state: IInboxState, id: string, fn: (item: IInboxItem) => IInboxItem): IInboxState => ({
  items: state.items.map((i) => (i.id === id ? fn(i) : i)),
});

const hold = (item: IInboxItem, reason: string, now: number): IInboxItem =>
  ({ ...item, state: 'held', heldReason: reason, transitionAt: item.state === 'held' ? item.transitionAt : now });

const REFUSAL_BUDGET_HOLD = / \(\d+ refusals\)$/;
/**
 * A held `resume` was escalated to the orchestrator, which may resume the tab by hand, and it has
 * no paste-time preflight to catch that; a held `mission` row is closed, so its preflight would
 * only reject the item.
 */
const RECOVERABLE_KINDS: ReadonlySet<TInboxKind> = new Set<TInboxKind>(['note', 'watch', 'deploy']);

/**
 * Held only because its refusal budget ran out, and not yet 24 h old: every refusal names a
 * condition a later look may clear, so the dispatcher keeps probing it slowly. A paste that threw
 * or stranded is never recoverable — typing it again could double it.
 */
export const isRecoverableHold = (item: IInboxItem, now: number): boolean =>
  item.state === 'held' && RECOVERABLE_KINDS.has(item.kind) && REFUSAL_BUDGET_HOLD.test(item.heldReason ?? '') && now < item.expiresAt;

/** Queued, or a recoverable hold: the item may still be typed. */
const awaitsDelivery = (item: IInboxItem, now: number): boolean =>
  item.state === 'queued' || isRecoverableHold(item, now);

/** One refusal: back off, or hold after the 30th refusal or past 24 h. A recoverable hold stays held. */
export const refuseInState = (state: IInboxState, id: string, reason: string, now: number): IInboxState =>
  replace(state, id, (item) => {
    if (!awaitsDelivery(item, now)) return item;
    const attempts = item.attempts + 1;
    const refused = { ...item, attempts, lastAttemptAt: now, lastRefusal: reason, notBefore: now + backoffAfter(attempts) };
    if (attempts >= INBOX_MAX_REFUSALS) return hold(refused, `${reason} (${attempts} refusals)`, now);
    if (now >= item.expiresAt) return hold(refused, `${reason} (undelivered after 24 h)`, now);
    return refused;
  });

/**
 * F6 change 3: the coordinator window defers the item to `until` (ruling, change 2): `notBefore` moves, the reason is
 * kept as `lastRefusal`, and `attempts` is unchanged, so a deferral never spends the 30-refusal budget and never holds
 * a GO. The 24 h rule is unchanged.
 */
export const deferInState = (state: IInboxState, id: string, until: number, reason: string, now: number): IInboxState =>
  replace(state, id, (item) => {
    if (!awaitsDelivery(item, now)) return item;
    const deferred = { ...item, lastAttemptAt: now, lastRefusal: reason, notBefore: until };
    if (now >= item.expiresAt) return hold(deferred, `${reason} (undelivered after 24 h)`, now);
    return deferred;
  });

export const deliverInState = (state: IInboxState, id: string, now: number): IInboxState =>
  replace(state, id, (item) => (awaitsDelivery(item, now)
    ? { ...item, state: 'delivered', deliveredAt: now, lastAttemptAt: now, transitionAt: now }
    : item));

export const holdInState = (state: IInboxState, id: string, reason: string, now: number): IInboxState =>
  replace(state, id, (item) => (awaitsDelivery(item, now) ? hold({ ...item, lastAttemptAt: now }, reason, now) : item));

export const dropForTabInState = (
  state: IInboxState,
  workspaceId: string,
  tabId: string,
  reason: string,
  now: number,
): { state: IInboxState; dropped: IInboxItem[] } => {
  const dropped: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if (item.targetWorkspaceId !== workspaceId || item.targetTabId !== tabId) return item;
    if (item.state !== 'queued' && item.state !== 'held') return item;
    const next: IInboxItem = { ...item, state: 'dropped', droppedReason: reason, transitionAt: now };
    dropped.push(next);
    return next;
  });
  return { state: { items }, dropped };
};

/**
 * Queued or held items past their `staleAt` are dropped (their line is no longer true); queued items
 * past 24 h become held; terminal items 7 days after their last transition are pruned. The same state
 * object comes back when nothing changed, so a quiet tick writes nothing.
 */
export const sweepInState = (state: IInboxState, now: number): IInboxState => {
  let changed = false;
  const items: IInboxItem[] = [];
  for (const item of state.items) {
    if (item.state !== 'queued' && now - item.transitionAt >= INBOX_RETENTION_MS) {
      changed = true;
      continue;
    }
    if ((item.state === 'queued' || item.state === 'held') && typeof item.staleAt === 'number' && now >= item.staleAt) {
      changed = true;
      items.push({ ...item, state: 'dropped', droppedReason: 'stale', transitionAt: now });
      continue;
    }
    if (item.state === 'queued' && now >= item.expiresAt) {
      changed = true;
      items.push(hold(item, `${item.lastRefusal ?? 'never ready'} (undelivered after 24 h)`, now));
      continue;
    }
    items.push(item);
  }
  return changed ? { items } : state;
};

/**
 * Withdraw one item still waiting to be typed — queued, or held for a manual retry — because its
 * owner no longer wants it typed (an API-error resume whose episode closed; a note routed to
 * another tab). A delivered or dropped item is untouched.
 */
export const withdrawInState = (state: IInboxState, id: string, reason: string, now: number): IInboxState => {
  const item = state.items.find((i) => i.id === id);
  if (!item || (item.state !== 'queued' && item.state !== 'held')) return state;
  return replace(state, id, (i) => ({ ...i, state: 'dropped', droppedReason: reason, transitionAt: now }));
};

/** Withdraw a waiting (queued or held) item by id; true when it was still waiting. */
export const withdrawNotice = async (id: string, reason: string): Promise<boolean> =>
  mutateInbox((state) => {
    const next = withdrawInState(state, id, reason, Date.now());
    return { state: next, value: next !== state };
  });

/** Drop the queued and held items of every tab `isGone` confirms closed (the boot pass). */
export const dropGoneTargetsInState = (
  state: IInboxState,
  isGone: (workspaceId: string, tabId: string) => boolean,
  now: number,
): { state: IInboxState; dropped: IInboxItem[] } => {
  const dropped: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if ((item.state !== 'queued' && item.state !== 'held') || !isGone(item.targetWorkspaceId, item.targetTabId)) return item;
    const next: IInboxItem = { ...item, state: 'dropped', droppedReason: 'target-tab-closed', transitionAt: now };
    dropped.push(next);
    return next;
  });
  return { state: dropped.length ? { items } : state, dropped };
};

/** A held item goes back to the queue once per call, with a fresh budget. */
export const retryInState = (state: IInboxState, id: string, now: number): { state: IInboxState; item: IInboxItem } => {
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new InboxError('inbox-not-found', `inbox item ${id} not found`);
  if (item.state !== 'held') throw new InboxError('inbox-not-held', `inbox item ${id} is ${item.state}, not held`);
  const newer = state.items.find((i) => i.id !== id && i.state === 'queued' && i.dedupeKey === item.dedupeKey
    && i.targetWorkspaceId === item.targetWorkspaceId && i.targetTabId === item.targetTabId);
  if (newer) throw new InboxError('inbox-not-held', `a newer notice with this key is already queued: ${newer.id}`);
  const next: IInboxItem = {
    ...item,
    state: 'queued',
    attempts: 0,
    notBefore: now,
    heldReason: null,
    expiresAt: now + INBOX_MAX_AGE_MS,
    transitionAt: now,
  };
  return { state: replace(state, id, () => next), item: next };
};

// The predicate is defined beside the web form's bounds so the panel can import it without fs.
export { humanRetryRefusal };

/** `retryInState` for a human session: the same transition, refused for a hold `humanRetryRefusal` names. */
export const retryHumanInState = (state: IInboxState, id: string, now: number): { state: IInboxState; item: IInboxItem } => {
  const item = state.items.find((i) => i.id === id);
  const refusal = item?.state === 'held' ? humanRetryRefusal(item) : null;
  if (refusal) throw new InboxError('inbox-not-retryable', `inbox item ${id} is held ${item!.heldReason}; a retry is refused`, refusal);
  return retryInState(state, id, now);
};

/**
 * The next item per target tab, oldest first, a recoverable hold included: due by its backoff (a
 * hold: `HELD_REPROBE_MS` after its last attempt), or woken early by `wake`.
 */
export const dueItems = (state: IInboxState, now: number, wake: (item: IInboxItem) => boolean): IInboxItem[] => {
  const byTab = new Map<string, IInboxItem>();
  const waiting = state.items.filter((i) => awaitsDelivery(i, now)).sort((a, b) => a.createdAt - b.createdAt);
  for (const item of waiting) {
    const key = `${item.targetWorkspaceId}/${item.targetTabId}`;
    const head = byTab.get(key);
    // Per tab, strictly in order: a later notice never overtakes a waiting one, with one exception (F6 ruling,
    // change 6): a kind that skips a coordinator's window overtakes a head that waits only on that window.
    if (head === undefined) byTab.set(key, item);
    else if (waitsOnlyOnWindow(head) && WINDOW_EXEMPT_INBOX_KINDS.has(item.kind) && !WINDOW_EXEMPT_INBOX_KINDS.has(head.kind)) byTab.set(key, item);
  }
  const dueAt = (item: IInboxItem) => (item.state === 'held' ? (item.lastAttemptAt ?? item.transitionAt) + HELD_REPROBE_MS : item.notBefore);
  return [...byTab.values()].filter((item) => dueAt(item) <= now || wake(item));
};

/** Queued and last deferred by the coordinator window: nothing but the window holds it back. */
export const waitsOnlyOnWindow = (item: IInboxItem): boolean =>
  item.state === 'queued' && (item.lastRefusal ?? '').startsWith(WINDOW_DEFERRAL);

/**
 * Per target tab, when its oldest item of a windowed kind that waits only on the window, or not yet tried, was created
 * (F6 ruling, change 3: the digest and this item take the next window in age order).
 */
export const windowHeads = (state: IInboxState, now: number): Map<string, number> => {
  const heads = new Map<string, number>();
  for (const item of state.items) {
    if (!awaitsDelivery(item, now) || !(WINDOWED_INBOX_KINDS as readonly string[]).includes(item.kind)) continue;
    if (item.lastRefusal && !waitsOnlyOnWindow(item)) continue;
    const key = `${item.targetWorkspaceId}/${item.targetTabId}`;
    const known = heads.get(key);
    if (known === undefined || item.createdAt < known) heads.set(key, item.createdAt);
  }
  return heads;
};

// ─── I/O ─────────────────────────────────────────────────────────────────

type TInboxHeldListener = (item: IInboxItem) => void;

const g = globalThis as unknown as { __ptInboxLock?: Promise<void>; __ptInboxHeldListeners?: Set<TInboxHeldListener> };
if (!g.__ptInboxLock) g.__ptInboxLock = Promise.resolve();
if (!g.__ptInboxHeldListeners) g.__ptInboxHeldListeners = new Set();

/**
 * Told once per item that becomes `held`, after the write, whatever held it (a
 * refusal budget, 24 h, an uncertain paste). The owning feature escalates.
 */
export const onInboxHeld = (listener: TInboxHeldListener): (() => void) => {
  g.__ptInboxHeldListeners!.add(listener);
  return () => { g.__ptInboxHeldListeners!.delete(listener); };
};

const notifyHeld = (before: IInboxState, after: IInboxState): void => {
  const wasHeld = new Set(before.items.filter((i) => i.state === 'held').map((i) => i.id));
  for (const item of after.items) {
    if (item.state !== 'held' || wasHeld.has(item.id)) continue;
    for (const listener of [...g.__ptInboxHeldListeners!]) {
      try {
        listener(item);
      } catch {
        // a listener's failure never undoes the write
      }
    }
  }
};

export const inboxFile = (): string => path.join(os.homedir(), '.purplemux', 'inbox.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptInboxLock!;
  g.__ptInboxLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isItem = (value: unknown): value is IInboxItem => {
  if (!value || typeof value !== 'object') return false;
  const i = value as Record<string, unknown>;
  return typeof i.id === 'string' && typeof i.kind === 'string' && typeof i.line === 'string'
    && typeof i.targetWorkspaceId === 'string' && typeof i.targetTabId === 'string' && typeof i.state === 'string';
};

/** Absent file = empty inbox; a file that is not `{ items: [...] }` is refused, not read as empty. */
export const readInboxState = async (): Promise<IInboxState> => {
  const file = inboxFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] };
    throw err;
  }
  const items = (JSON.parse(raw) as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(`${file} has no "items" array; the inbox is refused until it is repaired or moved aside`);
  // A malformed entry is refused, not skipped: the next write would erase it for good.
  const bad = items.findIndex((item) => !isItem(item));
  if (bad !== -1) throw new Error(`${file} item ${bad} is malformed; the inbox is refused until it is repaired or moved aside`);
  return { items: items as IInboxItem[] };
};

const writeInboxState = async (state: IInboxState): Promise<void> => {
  const file = inboxFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Read, transform, write under the one inbox lock. */
export const mutateInbox = async <T>(fn: (state: IInboxState) => { state: IInboxState; value: T }): Promise<T> =>
  withLock(async () => {
    const before = await readInboxState();
    const { state, value } = fn(before);
    if (state !== before) {
      await writeInboxState(state);
      notifyHeld(before, state);
    }
    return value;
  });

export const newInboxId = (): string => `i-${nanoid(10)}`;

/**
 * The ONLY entry point for a server-originated notice. The owning feature has
 * already decided the sender may notify this tab; the inbox renders the line
 * from the kind's fixed template and queues it. A `dedupeKey` still queued
 * returns the existing item.
 */
export const enqueueNotice = async <K extends TInboxKind>(req: IEnqueueRequest<K>): Promise<{ item: IInboxItem; created: boolean }> =>
  mutateInbox((state) => {
    const result = enqueueInState(state, req, Date.now(), newInboxId);
    return { state: result.state, value: { item: result.item, created: result.created } };
  });
