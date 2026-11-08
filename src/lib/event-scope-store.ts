import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IEventScope, IEventScopesState } from '@/types/worker-event';

// The one file of worker event scopes (ADR-0043 §1), under one process-wide lock.

const g = globalThis as unknown as { __ptEventScopesLock?: Promise<void> };
if (!g.__ptEventScopesLock) g.__ptEventScopesLock = Promise.resolve();

export const eventScopesFile = (): string => path.join(os.homedir(), '.purplemux', 'event-scopes.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptEventScopesLock!;
  g.__ptEventScopesLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isScope = (value: unknown): value is IEventScope => {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.workspaceId === 'string' && typeof s.tabId === 'string' && typeof s.epic === 'string'
    && Array.isArray(s.dependsOn) && Number.isSafeInteger(s.attempt);
};

/** Absent file = no scopes; a file that is not `{ scopes: [...] }` is refused, not read as empty. */
export const readEventScopes = async (): Promise<IEventScopesState> => {
  const file = eventScopesFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { scopes: [] };
    throw err;
  }
  const scopes = (JSON.parse(raw) as { scopes?: unknown } | null)?.scopes;
  if (!Array.isArray(scopes) || !scopes.every(isScope)) {
    throw new Error(`${file} is malformed; event scopes are refused until it is repaired or moved aside`);
  }
  return { scopes };
};

const writeEventScopes = async (state: IEventScopesState): Promise<void> => {
  const file = eventScopesFile();
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

export const mutateEventScopes = async <T>(
  fn: (state: IEventScopesState) => Promise<{ state: IEventScopesState; value: T }> | { state: IEventScopesState; value: T },
): Promise<T> =>
  withLock(async () => {
    const before = await readEventScopes();
    const { state, value } = await fn(before);
    if (state !== before) await writeEventScopes(state);
    return value;
  });
