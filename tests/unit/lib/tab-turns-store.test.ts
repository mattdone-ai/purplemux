import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/ledger';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITabTurn } from '@/types/effects';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const WS = 'ws-a';

let dir: string;
let file: string;
let store: LedgerStore;

const turn = (extra: Partial<ITabTurn> = {}): ITabTurn => ({
  workspaceId: WS, tabId: 'tab-o', provider: 'claude', startedAt: T0, endedAt: T0 + MIN, toolCalls: 2, ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-tab-turns-'));
  file = path.join(dir, 'ledger.sqlite');
  store = new LedgerStore(file);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tab_turns (story 15, ADR-0035 §7)', () => {
  it('stamps measuredSince once, from the first turn, and keeps it across a reopen', () => {
    expect(store.tabTurns.measuredSince()).toBeNull();
    store.tabTurns.record(turn({ startedAt: null, endedAt: T0 + 5 * MIN, toolCalls: null }));
    store.tabTurns.record(turn({ startedAt: T0, endedAt: T0 + MIN }));
    expect(store.tabTurns.measuredSince()).toBe(T0 + 5 * MIN);
    store.close();
    store = new LedgerStore(file);
    expect(store.tabTurns.measuredSince()).toBe(T0 + 5 * MIN);
  });

  it('reads a workspace\'s turns by end, and keeps a null start and count as null', () => {
    store.tabTurns.record(turn({ endedAt: T0 + 3 * MIN }));
    store.tabTurns.record(turn({ endedAt: T0 + MIN, startedAt: null, toolCalls: null, tabId: 'tab-p' }));
    store.tabTurns.record(turn({ workspaceId: 'ws-b', endedAt: T0 + 2 * MIN }));
    expect(store.tabTurns.endedSince(WS, T0 + MIN)).toEqual([
      turn({ endedAt: T0 + MIN, startedAt: null, toolCalls: null, tabId: 'tab-p' }), turn({ endedAt: T0 + 3 * MIN }),
    ]);
    expect(store.tabTurns.endedSince(WS, T0 + 2 * MIN)).toHaveLength(1);
  });

  it('adds a late tool call to a counted turn, never to an unmeasured one', () => {
    const counted = store.tabTurns.record(turn({ toolCalls: 0 }));
    const unmeasured = store.tabTurns.record(turn({ tabId: 'tab-p', toolCalls: null }));
    store.tabTurns.addToolCall(counted);
    store.tabTurns.addToolCall(unmeasured);
    expect(store.tabTurns.endedSince(WS, 0).map((t) => t.toolCalls)).toEqual([1, null]);
  });

  it('is kept 30 days, as tab_events', async () => {
    const now = T0 + 40 * DAY_MS;
    store.tabTurns.record(turn({ endedAt: now - 31 * DAY_MS }));
    store.tabTurns.record(turn({ endedAt: now - 29 * DAY_MS }));
    const result = await store.runRetention(now);
    expect(result.tabTurns).toBe(1);
    expect(store.tabTurns.endedSince(WS, 0)).toHaveLength(1);
  });
});

describe('tab_events.rule and the delivery read', () => {
  it('keeps a flag\'s rule and reads only delivered, non-log events in the window, oldest delivery first', () => {
    const base = { workspaceId: WS, tabId: 'tab-o', text: 'x' };
    store.tabEvents.append({ ...base, at: T0, class: 'digest', kind: 'alarm', rule: 'not-armed', deliveredAt: T0 + 2 * MIN });
    store.tabEvents.append({ ...base, at: T0, class: 'urgent', kind: 'needs-input', deliveredAt: T0 + MIN });
    store.tabEvents.append({ ...base, at: T0, class: 'log', kind: 'heartbeat' });
    store.tabEvents.append({ ...base, at: T0, class: 'digest', kind: 'stuck' });
    store.tabEvents.append({ ...base, at: T0, class: 'urgent', kind: 'stalled', deliveredAt: T0 + 9 * MIN });
    expect(store.tabEvents.deliveries(WS, T0, T0 + 5 * MIN).map(({ kind, rule, deliveredAt }) => [kind, rule, deliveredAt])).toEqual([
      ['needs-input', null, T0 + MIN], ['alarm', 'not-armed', T0 + 2 * MIN],
    ]);
    expect(store.tabEvents.list(WS, { since: 0, limit: 10 })[0].rule).toBe('not-armed');
  });
});
