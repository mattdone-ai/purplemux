import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveConstraint } from '@/lib/constraint';
import type { IPulseDeps } from '@/lib/pulse-service';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { PULSE_READ_DEADLINE_MS, computePulse, readPulse, resetPulseForTests, waitingForOwner } = await import('@/lib/pulse-service');

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 6, 30, 0);
const EMPTY_LEDGER = { movement: [], eventSince: false, openWork: 0, oldest: null };

const deps = (over: Partial<IPulseDeps> = {}): IPulseDeps => ({
  workspaces: async () => [{ id: 'ws-a', name: 'alpha', directories: [] }],
  epicLeases: async () => [],
  epicInfo: async (slug) => ({ slug, outputDir: null, repos: [], v2Dirs: [] }),
  hasV2: async () => false,
  ledger: async () => EMPTY_LEDGER,
  openItems: async () => [],
  answerTimes: async () => [],
  agentTabs: async () => [],
  finder: async () => deriveConstraint({ intervals: [], items: [], lastProducer: {}, firstEventAt: null, tabWakes: null, ownerIssueSource: null }, null, null, null, NOW - 10_000),
  ...over,
});

beforeEach(() => resetPulseForTests());

describe('pulse service', () => {
  it('works before the ledger has producers: MC answers alone move it, and busy tabs are the WIP', async () => {
    const pulse = await computePulse('ws-a', NOW, deps({
      answerTimes: async () => [NOW - 10 * 60_000],
      agentTabs: async () => [{ tabId: 't1', name: 'hfl-12', state: 'busy', since: NOW - 3 * HOUR }],
      openItems: async () => [{ id: 'mc-1', title: 'Pick a port', createdAt: NOW - 5 * HOUR }],
    }));
    expect(pulse.sources.find((s) => s.id === 'ledger')).toMatchObject({ state: 'unknown', reason: 'the ledger holds no work-item event for this workspace in 7 days' });
    expect(pulse.sources.find((s) => s.id === 'answers')).toMatchObject({ state: 'ok', count: 1 });
    expect(pulse.sources.find((s) => s.id === 'commits')).toMatchObject({ state: 'unknown', reason: "no repository in this workspace's scope" });
    expect(pulse.scope).toEqual({ basis: 'directories', epics: [] });
    expect(pulse.hours?.at(-1)?.total).toBe(1);
    expect(pulse.wip).toMatchObject({ count: 2, basis: 'agent-tabs', sources: { ledger: 'no-events', agentTabs: 'measured', missionControl: 'measured' } });
    expect(pulse.priority).toEqual({ basis: 'unknown', needsYou: 1, text: 'constraint unknown (the ledger holds no event for this workspace) · needs you: 1' });
    expect(pulse.staleSince).toBeNull();
  });

  it('a stall names the oldest counted item', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-service-'));
    fs.mkdirSync(path.join(dir, '.v2'));
    fs.writeFileSync(path.join(dir, '.v2', 'landings.log'), `${new Date(NOW - 4 * HOUR).toISOString().replace(/\.\d+Z$/, 'Z')}\tLANDED\tkit\tabc\n`);
    try {
      const pulse = await computePulse('ws-a', NOW, deps({
        workspaces: async () => [{ id: 'ws-a', name: 'alpha', directories: [dir] }],
        hasV2: async (d) => d === dir,
        openItems: async () => [{ id: 'mc-1', title: 'Pick a port', createdAt: NOW - 5 * HOUR }],
      }));
      expect(pulse.sources.find((s) => s.id === 'landed')).toMatchObject({ state: 'ok', count: 1 });
      expect(pulse.stall).toMatchObject({ state: 'stalled', oldestStuck: { kind: 'mc-item', id: 'mc-1' } });
      expect(pulse.stall.reason).toMatch(/^no movement for 4 h · oldest stuck: Mission Control: Pick a port · not measured: /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a measured ledger is the only WIP basis and its movement counts', async () => {
    const pulse = await computePulse('ws-a', NOW, deps({
      ledger: async () => ({ movement: [NOW - 60_000], eventSince: true, openWork: 2,
        oldest: { itemKey: 'range:a:1', itemType: 'range', waitReason: 'not-armed', since: NOW - 9 * HOUR } }),
      agentTabs: async () => [{ tabId: 't1', name: 'w', state: 'busy', since: NOW }],
    }));
    expect(pulse.wip).toMatchObject({ count: 2, basis: 'ledger' });
    expect(pulse.sources.find((s) => s.id === 'ledger')).toMatchObject({ state: 'ok', count: 1 });
  });

  it('every failed read is that source unknown, never zero, and never a failed pulse', async () => {
    const boom = async (): Promise<never> => { throw new Error('disk gone'); };
    const pulse = await computePulse('ws-a', NOW, deps({ workspaces: boom, ledger: boom, openItems: boom, answerTimes: boom, agentTabs: boom, finder: boom }));
    expect(pulse.sources.every((s) => s.state === 'unknown' && s.count === null)).toBe(true);
    expect(pulse.sources.find((s) => s.id === 'gates')?.reason).toBe('scope unreadable: disk gone');
    expect(pulse.hours).toBeNull();
    expect(pulse.wip).toMatchObject({ count: null, basis: 'none' });
    expect(pulse.stall.state).toBe('not-measured');
    expect(pulse.priority.text).toBe('constraint unknown (finder unreadable) · needs you: unknown (Mission Control unreadable)');
  });

  it('a finder answer older than 120 s makes the pulse say stale since its time', async () => {
    const old = NOW - 5 * 60_000;
    const pulse = await computePulse('ws-a', NOW, deps({ finder: async () => deriveConstraint(null, null, null, null, old) }));
    expect(pulse.staleSince).toBe(old);
  });

  it('caches for 60 s and shares one derive between concurrent reads', async () => {
    const answerTimes = vi.fn(async () => [NOW - 60_000]);
    const d = deps({ answerTimes });
    const [a, b] = await Promise.all([readPulse('ws-a', NOW, d), readPulse('ws-a', NOW, d)]);
    expect(a).toBe(b);
    expect(answerTimes).toHaveBeenCalledTimes(1);
    expect(await readPulse('ws-a', NOW + 59_000, d)).toBe(a);
    expect(answerTimes).toHaveBeenCalledTimes(1);
    expect((await readPulse('ws-a', NOW + 60_000, d)).generatedAt).toBe(NOW + 60_000);
    expect(answerTimes).toHaveBeenCalledTimes(2);
  });

  it('a stall needs a file-born source: with only MC answers read, a quiet workspace is not measured, never stalled (round 2, F4)', async () => {
    const pulse = await computePulse('ws-a', NOW, deps({
      answerTimes: async () => [NOW - 4 * HOUR],
      openItems: async () => [{ id: 'mc-1', title: 'Pick a port', createdAt: NOW - 5 * HOUR }],
    }));
    expect(pulse.stall.state).toBe('not-measured');
  });
});

describe('an orchestrator waiting for the owner (architect CONCERN C2)', () => {
  it('a pane prompt, or a current NEEDS-DECISION or BLOCKED turn end, is waiting; busy or a stale marker is not', () => {
    const at = NOW - 3 * HOUR;
    expect(waitingForOwner({ cliState: 'needs-input', lastEvent: { name: 'notification', at, seq: 4 }, turnEnd: null,
      lastAssistantMessage: 'Two options.\nPick the port: 8022 or 8122?' })).toEqual({ since: at, question: 'Pick the port: 8022 or 8122?' });
    const marker = { kind: 'turn-marker' as const, at, seq: 7, marker: ['NEEDS-DECISION: keep the QA PrivateLink?'] };
    expect(waitingForOwner({ cliState: 'idle', lastEvent: { name: 'stop', at, seq: 7 }, turnEnd: marker, lastAssistantMessage: null }))
      .toEqual({ since: at, question: 'NEEDS-DECISION: keep the QA PrivateLink?' });
    expect(waitingForOwner({ cliState: 'idle', lastEvent: { name: 'prompt-submit', at, seq: 8 }, turnEnd: marker, lastAssistantMessage: null })).toBeNull();
    expect(waitingForOwner({ cliState: 'idle', lastEvent: { name: 'stop', at, seq: 7 }, turnEnd: { ...marker, marker: ['DONE: shipped'] }, lastAssistantMessage: null })).toBeNull();
    expect(waitingForOwner({ cliState: 'busy', lastEvent: { name: 'prompt-submit', at, seq: 9 }, turnEnd: null, lastAssistantMessage: null })).toBeNull();
  });

  it('with no other movement, the workspace is stuck naming the orchestrator and its question, not grey idle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-c2-'));
    fs.mkdirSync(path.join(dir, '.v2'));
    fs.writeFileSync(path.join(dir, '.v2', 'landings.log'), `${new Date(NOW - 5 * HOUR).toISOString().replace(/\.\d+Z$/, 'Z')}\tLANDED\tkit\tabc\n`);
    try {
      const pulse = await computePulse('ws-a', NOW, deps({
        workspaces: async () => [{ id: 'ws-a', name: 'alpha', directories: [dir] }],
        hasV2: async (d) => d === dir,
        agentTabs: async () => [{ tabId: 'tab-o', name: 'hfl-orchestrator', state: 'needs-input', since: NOW - 3 * HOUR,
          role: 'orchestrator', question: 'NEEDS-DECISION: keep the QA PrivateLink?' }],
      }));
      expect(pulse.wip.count).toBe(1);
      expect(pulse.stall).toMatchObject({ state: 'stalled', oldestStuck: { kind: 'agent-tab', id: 'tab-o' } });
      expect(pulse.stall.reason).toMatch(/^no movement for 5 h · oldest stuck: orchestrator hfl-orchestrator waiting for you: NEEDS-DECISION: keep the QA PrivateLink\?/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pulse deadlines (round 2, F5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a read that never settles is that source unknown "read timed out" after 10 s; the rest still answer', async () => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => undefined);
    const pending = computePulse('ws-a', NOW, deps({ answerTimes: never, ledger: never }));
    await vi.advanceTimersByTimeAsync(PULSE_READ_DEADLINE_MS + 1);
    const pulse = await pending;
    expect(PULSE_READ_DEADLINE_MS).toBe(10_000);
    expect(pulse.sources.find((s) => s.id === 'answers')).toMatchObject({ state: 'unknown', reason: 'Mission Control unreadable' });
    expect(pulse.sources.find((s) => s.id === 'ledger')).toMatchObject({ state: 'unknown', reason: 'ledger unreadable' });
    expect(pulse.wip.sources.ledger).toBe('unreadable');
  });

  it('a derive still running at the deadline is not shared with the next reader', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const slowScope = async () => {
      calls += 1;
      // Each step is bounded, but the scope read and the source reads run in turn: up to two deadlines.
      await new Promise((resolve) => setTimeout(resolve, PULSE_READ_DEADLINE_MS - 1));
      return [{ id: 'ws-a', name: 'alpha', directories: [] }];
    };
    const d = deps({ workspaces: slowScope, answerTimes: () => new Promise<never>(() => undefined) });
    const first = readPulse('ws-a', NOW, d);
    await vi.advanceTimersByTimeAsync(PULSE_READ_DEADLINE_MS + 1);
    const second = readPulse('ws-a', NOW, d);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(3 * PULSE_READ_DEADLINE_MS);
    await Promise.all([first, second]);
  });
});

