import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FLOW_HISTORY, parseFlowSnapshot } from '@/lib/flow';
import type { IFlowRecord, IFlowSnapshot } from '@/types/flow';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const NOW = Date.parse('2026-10-26T12:00:00Z');

const snapshot = (length = 1): IFlowSnapshot => {
  const result = parseFlowSnapshot({
    schemaVersion: 1, generatedAt: NOW, source: 'v2-flow',
    queues: [{ name: 'landing', capacity: null, items: Array.from({ length }, (_, index) => ({
      id: `lane-${index}`, label: null, since: NOW - (index + 1) * 60_000, state: 'queued', pinned: false, holder: null })) }],
    locks: [{ name: 'landing', heldBy: 'lane-0', since: NOW - 60_000 }], meters: [], flags: [],
  }, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.snapshot;
};

const dir = () => path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-1');
const file = () => path.join(dir(), 'flow.json');
const store = () => import('@/lib/flow-store');

describe('flow store', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptFlowReadCache;
    delete (globalThis as Record<string, unknown>).__ptFlowLocks;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-flow-store-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads nothing before the first publish', async () => {
    const { readFlow } = await store();
    expect(await readFlow('ws-1')).toBeNull();
  });

  it('keeps the newest snapshot and appends one server-derived row per publish, private to the owner', async () => {
    const { publishFlow, readFlow } = await store();
    const first = await publishFlow('ws-1', snapshot(2), NOW);
    expect(first).toMatchObject({ historyReset: false, record: { workspaceId: 'ws-1', receivedAt: NOW } });
    await publishFlow('ws-1', snapshot(3), NOW + 1_000);
    const record = await readFlow('ws-1');
    expect(record?.snapshot).toEqual(snapshot(3));
    expect(record?.history).toEqual([
      { at: NOW, queues: { landing: 2 }, oldest: { landing: NOW - 120_000 }, locks: { landing: true }, meters: {} },
      { at: NOW + 1_000, queues: { landing: 3 }, oldest: { landing: NOW - 180_000 }, locks: { landing: true }, meters: {} },
    ]);
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
    await expect(fs.access(`${file()}.tmp`)).rejects.toThrow();
    const raw = await fs.readFile(file(), 'utf-8');
    expect(JSON.parse(raw)).toEqual(record);
    expect((await publishFlow('ws-1', snapshot(), NOW + 2_000)).bytes).toBe(Buffer.byteLength(await fs.readFile(file(), 'utf-8')));
  });

  it('keeps the newest 2000 history rows over 2001 publishes, oldest dropped first', async () => {
    const { publishFlow, readFlow } = await store();
    for (let index = 0; index <= MAX_FLOW_HISTORY; index += 1) await publishFlow('ws-1', snapshot(), NOW + index);
    const history = (await readFlow('ws-1'))!.history;
    expect(history).toHaveLength(MAX_FLOW_HISTORY);
    expect(history[0].at).toBe(NOW + 1);
    expect(history.at(-1)?.at).toBe(NOW + MAX_FLOW_HISTORY);
  }, 60_000);

  it('serializes concurrent publishes so every row lands', async () => {
    const { publishFlow, readFlow } = await store();
    await Promise.all(Array.from({ length: 8 }, (_, index) => publishFlow('ws-1', snapshot(), NOW + index)));
    const record = await readFlow('ws-1');
    expect(record?.history.map((row) => row.at)).toEqual(Array.from({ length: 8 }, (_, index) => NOW + index));
    expect(record?.receivedAt).toBe(NOW + 7);
  });

  it('serves a repeated read from the cache and re-reads a changed file', async () => {
    const { publishFlow, readFlow } = await store();
    await publishFlow('ws-1', snapshot(), NOW);
    const once = await readFlow('ws-1');
    expect(await readFlow('ws-1')).toBe(once);
    const changed: IFlowRecord = { ...once!, receivedAt: NOW + 12_345 };
    const before = await fs.stat(file());
    await fs.writeFile(file(), JSON.stringify(changed));
    // Same size (both receivedAt values have 13 digits), so only the mtime tells the change apart. Two writes
    // can share one mtime tick (10 ms on a 100 Hz kernel, coarser on some filesystems), so the test moves the
    // mtime itself: what it pins is that a changed mtime invalidates the cache, not the host's clock grain.
    expect((await fs.stat(file())).size).toBe(before.size);
    await fs.utimes(file(), before.atime, new Date(before.mtimeMs + 5_000));
    expect((await readFlow('ws-1'))?.receivedAt).toBe(NOW + 12_345);
  });

  it('reports a damaged file instead of reading it as absent', async () => {
    const { FlowStoreError, readFlow } = await store();
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(), '{"workspaceId":"ws-1"');
    await expect(readFlow('ws-1')).rejects.toBeInstanceOf(FlowStoreError);
    await expect(readFlow('ws-1')).rejects.toThrow('flow storage unreadable: the file is not JSON');
    const record: IFlowRecord = { workspaceId: 'ws-1', receivedAt: NOW, snapshot: snapshot(), history: [] };
    await fs.writeFile(file(), JSON.stringify({ ...record, snapshot: { ...record.snapshot, source: '' } }));
    await expect(readFlow('ws-1')).rejects.toThrow(/^flow storage unreadable: snapshot\.source: /);
    await fs.writeFile(file(), JSON.stringify({ ...record, workspaceId: 'ws-other' }));
    await expect(readFlow('ws-1')).rejects.toThrow(/workspaceId/);
  });

  it('moves a damaged file aside on the next publish, then starts a fresh history', async () => {
    const { publishFlow, readFlow } = await store();
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(), 'not json');
    const result = await publishFlow('ws-1', snapshot(), NOW);
    expect(result.historyReset).toBe(true);
    expect(result.record.history).toHaveLength(1);
    expect(await fs.readFile(`${file()}.corrupt-${NOW}`, 'utf-8')).toBe('not json');
    expect((await readFlow('ws-1'))?.history).toHaveLength(1);
    expect((await publishFlow('ws-1', snapshot(), NOW + 1)).historyReset).toBe(false);
  });

  it('leaves the damaged file in place when the write after keeping it aside fails', async () => {
    const { FlowStoreError, publishFlow, readFlow } = await store();
    await fs.mkdir(path.join(`${file()}.tmp`, 'blocker'), { recursive: true });
    await fs.writeFile(file(), 'not json');
    const failure = await publishFlow('ws-1', snapshot(), NOW).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'flow-write-failed' });
    expect(await fs.readFile(`${file()}.corrupt-${NOW}`, 'utf-8')).toBe('not json');
    expect(await fs.readFile(file(), 'utf-8')).toBe('not json');
    const read = await readFlow('ws-1').catch((error: unknown) => error);
    expect(read).toBeInstanceOf(FlowStoreError);
    expect(read).toMatchObject({ damaged: true });
  });

  it('answers flow-write-failed for a write that fails and keeps the previous record', async () => {
    const { FlowStoreError, publishFlow, readFlow } = await store();
    await publishFlow('ws-1', snapshot(2), NOW);
    const before = await fs.readFile(file(), 'utf-8');
    await fs.mkdir(path.join(`${file()}.tmp`, 'blocker'), { recursive: true });
    const failure = await publishFlow('ws-1', snapshot(3), NOW + 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FlowStoreError);
    expect(failure).toMatchObject({ code: 'flow-write-failed', damaged: false, message: 'flow storage write failed (write): EISDIR' });
    expect(await fs.readFile(file(), 'utf-8')).toBe(before);
    expect((await readFlow('ws-1'))?.snapshot).toEqual(snapshot(2));
  });

  it('never moves aside a file it could not read', async () => {
    const { FlowStoreError, publishFlow, readFlow } = await store();
    await fs.mkdir(file(), { recursive: true });
    await expect(readFlow('ws-1')).rejects.toThrow('flow storage unreadable: EISDIR');
    const failure = await publishFlow('ws-1', snapshot(), NOW).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FlowStoreError);
    expect((await fs.stat(file())).isDirectory()).toBe(true);
    await expect(fs.access(`${file()}.corrupt-${NOW}`)).rejects.toThrow();
  });
});
