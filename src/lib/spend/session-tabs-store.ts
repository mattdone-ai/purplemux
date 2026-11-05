import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { spendFloor, utcDay } from '@/lib/spend/spend-model';
import type { TSpendProvider } from '@/types/spend';

const STORE_FILE = path.join(os.homedir(), '.purplemux', 'session-tabs.json');
// A hook reports the same session many times a turn; a binding that is already
// known and fresh needs no write.
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
// A refused file stays refused until someone repairs it; without a back-off every
// hook save would re-read it and warn.
const REFUSED_RETRY_MS = 60 * 1000;

const log = createLogger('session-tabs');

export interface ISessionTabBinding {
  workspaceId: string;
  tabId: string;
  /** The tab's name at the last recorded sighting: the seat of a tab closed since (harness-flow-loop 04). */
  tabName?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ISessionTabsData {
  version: 1;
  bindings: Record<string, ISessionTabBinding>;
}

export interface ISessionTabSighting {
  providerId: TSpendProvider;
  sessionId: string;
  workspaceId: string;
  tabId: string;
  tabName?: string;
  seenAt: number;
}

export class SessionTabsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTabsStoreError';
  }
}

const g = globalThis as unknown as {
  __ptSessionTabsLock?: Promise<void>;
  __ptSessionTabsSeen?: Map<string, ISessionTabBinding>;
  __ptSessionTabsRefusedAt?: number;
};
if (!g.__ptSessionTabsLock) g.__ptSessionTabsLock = Promise.resolve();
if (!g.__ptSessionTabsSeen) g.__ptSessionTabsSeen = new Map();
const seen = g.__ptSessionTabsSeen;

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = g.__ptSessionTabsLock!;
  g.__ptSessionTabsLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

export const bindingKey = (providerId: TSpendProvider, sessionId: string): string => `${providerId}:${sessionId}`;

const isBinding = (value: unknown): value is ISessionTabBinding => {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return typeof b.workspaceId === 'string' && typeof b.tabId === 'string'
    && (b.tabName === undefined || typeof b.tabName === 'string')
    && Number.isFinite(b.firstSeenAt) && Number.isFinite(b.lastSeenAt);
};

const readData = async (): Promise<ISessionTabsData> => {
  let raw: string;
  try {
    raw = await fs.readFile(STORE_FILE, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: {} };
    throw new SessionTabsStoreError(`session-tabs.json unreadable: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionTabsStoreError('session-tabs.json unreadable: the file is not JSON');
  }
  const data = parsed as Partial<ISessionTabsData> | null;
  if (!data || data.version !== 1 || !data.bindings || typeof data.bindings !== 'object' || Array.isArray(data.bindings)) {
    throw new SessionTabsStoreError('session-tabs.json unreadable: expected {version: 1, bindings: {...}}');
  }
  const bad = Object.entries(data.bindings).find(([, binding]) => !isBinding(binding));
  if (bad) throw new SessionTabsStoreError(`session-tabs.json unreadable: binding ${bad[0]} is malformed`);
  return { version: 1, bindings: data.bindings };
};

const writeData = async (data: ISessionTabsData): Promise<void> => {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, STORE_FILE);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
};

/** A binding last seen before the spend floor attributes nothing spend still serves (ADR-0030 §3). */
const beforeFloor = (seenAt: number, now: number): boolean => utcDay(seenAt) < spendFloor(now);

const prune = (data: ISessionTabsData, now: number): boolean => {
  let pruned = false;
  for (const [key, binding] of Object.entries(data.bindings)) {
    if (beforeFloor(binding.lastSeenAt, now)) {
      delete data.bindings[key];
      pruned = true;
    }
  }
  return pruned;
};

const apply = (data: ISessionTabsData, sighting: ISessionTabSighting): boolean => {
  const key = bindingKey(sighting.providerId, sighting.sessionId);
  const current = Object.hasOwn(data.bindings, key) ? data.bindings[key] : undefined;
  if (current && current.workspaceId === sighting.workspaceId && current.tabId === sighting.tabId) {
    if (sighting.seenAt <= current.lastSeenAt) return false;
    current.lastSeenAt = sighting.seenAt;
    if (sighting.tabName) current.tabName = sighting.tabName;
    return true;
  }
  // A session moves to another tab only on a newer sighting (a resume in another tab).
  if (current && sighting.seenAt < current.lastSeenAt) return false;
  data.bindings[key] = {
    workspaceId: sighting.workspaceId,
    tabId: sighting.tabId,
    ...(sighting.tabName ? { tabName: sighting.tabName } : {}),
    firstSeenAt: sighting.seenAt,
    lastSeenAt: sighting.seenAt,
  };
  return true;
};

/** Every binding, keyed `<provider>:<sessionId>`. A malformed file throws; it is never read as empty. */
export const readSessionTabs = async (): Promise<Record<string, ISessionTabBinding>> => (await readData()).bindings;

/** A clock moved back before the refusal ends the back-off. */
const refusedRecently = (now: number): boolean => {
  const refusedAt = g.__ptSessionTabsRefusedAt;
  return refusedAt !== undefined && now >= refusedAt && now - refusedAt < REFUSED_RETRY_MS;
};

/**
 * Record that a tab runs an agent session. A refused file is logged here and read again after
 * REFUSED_RETRY_MS; callers on the hook path must still catch a write failure, which never fails them.
 */
export const recordSessionTab = async (sighting: Omit<ISessionTabSighting, 'seenAt'>, now = Date.now()): Promise<void> => {
  const key = bindingKey(sighting.providerId, sighting.sessionId);
  const known = seen.get(key);
  if (known && known.workspaceId === sighting.workspaceId && known.tabId === sighting.tabId
    && (!sighting.tabName || known.tabName === sighting.tabName) && now - known.lastSeenAt < TOUCH_INTERVAL_MS) return;
  if (refusedRecently(now)) return;
  await withLock(async () => {
    if (refusedRecently(now)) return;
    let data: ISessionTabsData;
    try {
      data = await readData();
    } catch (error) {
      if (!(error instanceof SessionTabsStoreError)) throw error;
      g.__ptSessionTabsRefusedAt = now;
      log.warn(`bindings not recorded for ${REFUSED_RETRY_MS / 1000} s: ${STORE_FILE}: ${error.message}`);
      return;
    }
    delete g.__ptSessionTabsRefusedAt;
    const changed = apply(data, { ...sighting, seenAt: now });
    if (prune(data, now) || changed) await writeData(data);
    const stored = data.bindings[key];
    if (stored) seen.set(key, { ...stored });
  });
};

/** Add what session history and the layouts already know; a newer stored sighting wins. */
export const seedSessionTabs = async (sightings: ISessionTabSighting[], now = Date.now()): Promise<number> =>
  withLock(async () => {
    const data = await readData();
    let changed = 0;
    for (const sighting of sightings) {
      if (beforeFloor(sighting.seenAt, now)) continue;
      if (apply(data, sighting)) changed += 1;
    }
    if (prune(data, now) || changed > 0) await writeData(data);
    return changed;
  });
