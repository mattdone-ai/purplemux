import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '@/lib/ledger';
import { LEDGER_RETENTION_FIRST_RUN_MS, startLedgerRetention, stopLedgerRetention } from '@/lib/ledger-retention';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput } from '@/types/ledger';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);

const ev = (id: string, at: number, key: string, kind: ILedgerEventInput['kind'], reason: ILedgerEventInput['wait_reason'] = null): ILedgerEventInput => ({
  event_id: id, at, item_type: 'range', item_key: key, kind, wait_reason: reason,
});

describe('the daily ledger retention job (AC 8, fake clock)', () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    // setImmediate stays real: the pass yields through it between chunks; the clock and the schedule are faked.
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-retention-'));
    store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
  });

  afterEach(() => {
    stopLedgerRetention();
    vi.useRealTimers();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs 10 min after start and then every 24 h, deleting what has passed 92 days on each pass', async () => {
    const runs = vi.spyOn(store, 'runRetention');
    store.append('ws-a', 'v2', [ev('old0', T0 - 93 * DAY_MS, 'range:a:1', 'open'), ev('old1', T0 - 93 * DAY_MS, 'range:a:1', 'wait', 'not-armed'),
      ev('old2', T0 - 93 * DAY_MS + 60_000, 'range:a:1', 'close')], T0);
    store.append('ws-a', 'v2', [ev('mid0', T0 - 90.5 * DAY_MS, 'range:b:1', 'open'), ev('mid1', T0 - 90.5 * DAY_MS, 'range:b:1', 'wait', 'owner'),
      ev('mid2', T0 - 90.5 * DAY_MS + 60_000, 'range:b:1', 'clear')], T0);
    store.append('ws-a', 'v2', [ev('new0', T0 - DAY_MS, 'range:c:1', 'open'), ev('new1', T0 - DAY_MS, 'range:c:1', 'wait', 'owner')], T0);
    startLedgerRetention({ store: () => store });
    startLedgerRetention({ store: () => store });

    await vi.advanceTimersByTimeAsync(LEDGER_RETENTION_FIRST_RUN_MS - 1);
    expect(runs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(runs).toHaveBeenLastCalledWith(T0 + LEDGER_RETENTION_FIRST_RUN_MS);
    await runs.mock.results.at(-1)!.value;
    expect(store.counts()).toMatchObject({ events: 5, intervals: 1, items: 2 });

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(runs).toHaveBeenCalledTimes(2);
    await runs.mock.results.at(-1)!.value;
    expect(store.counts()).toMatchObject({ events: 5, intervals: 1 });

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(runs).toHaveBeenCalledTimes(3);
    expect(runs).toHaveBeenLastCalledWith(T0 + LEDGER_RETENTION_FIRST_RUN_MS + 2 * DAY_MS);
    await runs.mock.results.at(-1)!.value;
    expect(store.counts()).toMatchObject({ events: 2, intervals: 0, items: 2 });
    expect(store.items('ws-a', {}, Date.now()).items.map((item) => item.itemKey)).toEqual(['range:b:1', 'range:c:1']);
  });

  it('keeps running after a failed pass and stops when told', async () => {
    const runs = vi.spyOn(store, 'runRetention').mockImplementationOnce(async () => { throw new Error('disk full'); });
    startLedgerRetention({ store: () => store, firstRunAfterMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(runs).toHaveBeenCalledTimes(2);
    stopLedgerRetention();
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(runs).toHaveBeenCalledTimes(2);
  });
});
