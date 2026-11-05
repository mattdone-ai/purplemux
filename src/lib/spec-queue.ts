import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// The workspace spec queue (ADR-HFL-05 decision 7): product rules the owner stated in chat, filed by the curator with
// their message id, for the next slice contract (ADR-HFL-07). One lock per host serialises the appends.

const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]{1,32}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;

const g = globalThis as unknown as { __ptSpecQueueLock?: Promise<void> };
if (!g.__ptSpecQueueLock) g.__ptSpecQueueLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptSpecQueueLock!;
  g.__ptSpecQueueLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

export const specQueuePath = (workspaceId: string): string =>
  path.join(os.homedir(), '.purplemux', 'workspaces', workspaceId, 'spec-queue.md');

const header = (workspaceId: string): string => `# Spec queue: ${workspaceId}

Product rules the owner stated in chat, filed by the curator with their message id (ADR-HFL-05 decision 7). The next
slice contract (ADR-HFL-07) reads them; a rule taken into a contract is struck through here by hand.
`;

const entryHeading = (entryId: string): string => `## ${entryId}`;

export const renderEntry = (workspaceId: string, entryId: string, at: number, text: string): string => [
  entryHeading(entryId),
  `- at: ${new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
  `- source: owner message ${workspaceId}/${entryId}`,
  '',
  ...text.split('\n').map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>')),
].join('\n');

/** Append one rule; an entry already queued (same message id) is left as it is. False when it was already there. */
export const appendProductRule = (workspaceId: string, entryId: string, at: number, text: string): Promise<boolean> =>
  withLock(async () => {
    if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`spec queue: ${JSON.stringify(workspaceId)} is not a workspace id`);
    if (!ENTRY_ID.test(entryId)) throw new Error('spec queue: the message id is not an id');
    const file = specQueuePath(workspaceId);
    let current: string;
    try {
      current = await fs.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      current = header(workspaceId);
    }
    if (current.split('\n').includes(entryHeading(entryId))) return false;
    const body = `${current.replace(/\n*$/, '\n')}\n${renderEntry(workspaceId, entryId, at, text)}\n`;
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(tmp, body, { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return true;
  });
