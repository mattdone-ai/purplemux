import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_RECORD_MS,
  ContextLifecycle,
  FIRST_MESSAGE_TTL_MS,
  ROTATION_DEADLINE_MS,
  checkFailedMessage,
  fleetRotateAtFrom,
  isHandoffReady,
  parseRotateAtTokens,
  parseTabRotateAt,
  resumeMessage,
  rotateMessage,
  seatItemKey,
  seatThreshold,
  type IContextLifecycleDeps,
  type TRestartOutcome,
} from '@/lib/context-lifecycle';
import type { ISeatTab } from '@/types/context-lifecycle';
import type { ILedgerEventInput, TLedgerAttrValue } from '@/types/ledger';

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0, 400);
const PATH = '/home/u/.purplemux/workspaces/ws-a/seats/orch/handoff.md';

const handoffText = (stamp: string, resume = '/v2-orchestrate') => [
  `# Handoff: orch · updated ${stamp}`, '',
  '## Role', '/v2-orchestrate', '',
  '## In flight', 'none', '',
  '## Open questions', 'none', '',
  '## Standing rules', '- Pin the identity on every gh write. (source: lane ledger ORCH-1027 2026-11-03T02:58:09Z)', '',
  '## Decisions in the last 24 h', '', '## Do not', '- nothing', '',
  '## Resume command', resume, '',
].join('\n');

interface IHarness {
  life: ContextLifecycle;
  clock: { now: number };
  seat: ISeatTab;
  sent: Array<{ text: string; ready: boolean }>;
  restarts: string[];
  first: string[];
  events: ILedgerEventInput[];
  files: Map<string, string>;
  ready: { value: boolean };
  restartOutcome: { value: TRestartOutcome };
  item: { value: { state: string | null; attrs: Record<string, TLedgerAttrValue> } | null };
  canRotateCalls: string[];
  session: { value: string | null };
  firstReady: { value: boolean };
  released: number[];
}

const harness = (overrides: Partial<ISeatTab> = {}, depsOverride: Partial<IContextLifecycleDeps> = {}): IHarness => {
  const clock = { now: T0 };
  const seat: ISeatTab = { workspaceId: 'ws-a', tabId: 'tab-orch', tabName: 'orch', handoffPath: PATH, rotateAt: null, ...overrides };
  const h = {
    clock, seat, sent: [], restarts: [], first: [], events: [], files: new Map<string, string>(), ready: { value: true },
    restartOutcome: { value: { ok: true } as TRestartOutcome }, item: { value: null }, canRotateCalls: [],
    session: { value: 'sess-1' }, firstReady: { value: true }, released: [],
  } as unknown as IHarness;
  h.life = new ContextLifecycle({
    now: () => clock.now,
    seat: (tabId) => (tabId === seat.tabId ? seat : null),
    seats: () => [seat],
    fleetRotateAt: () => 300_000,
    sessionId: () => h.session.value,
    canRotate: async (tabId) => {
      h.canRotateCalls.push(tabId);
      return h.ready.value;
    },
    atPrompt: () => h.ready.value,
    send: async (_seat, text, whenReady) => {
      h.sent.push({ text, ready: whenReady() });
      return whenReady();
    },
    readHandoff: async (path) => {
      const text = h.files.get(path);
      if (text === undefined) throw new Error('ENOENT: no such file or directory');
      return text;
    },
    restart: async (s) => {
      h.restarts.push(s.tabId);
      // The restart unbinds the session (markAgentLaunch resetAgentSession); the fresh one binds at its start.
      if (h.restartOutcome.value.ok) h.session.value = null;
      return h.restartOutcome.value;
    },
    typeFirstMessage: async (_seat, text) => {
      if (!h.firstReady.value) return false;
      h.first.push(text);
      return true;
    },
    retryMs: 5,
    releaseUrgent: (_seat, since) => {
      h.released.push(since);
    },
    record: (_ws, events) => {
      h.events.push(...events);
    },
    readSeatItem: () => h.item.value,
    ...depsOverride,
  });
  return h;
};

const stateEvents = (h: IHarness) => h.events.filter((e) => e.kind === 'state').map((e) => e.state);

/** The fresh session reports in after a restart: it binds a new session id and posts its session start. */
const freshSession = async (h: IHarness, id = 'sess-2') => {
  h.session.value = id;
  h.life.onSessionStart(h.seat.tabId);
  await h.life.advance(h.seat.tabId);
};

/** HANDOFF-READY with a passing file, then the fresh session: a whole rotation. */
const rotate = async (h: IHarness) => {
  h.files.set(PATH, handoffText(new Date(Math.floor(h.clock.now / 1000) * 1000).toISOString().replace('.000Z', 'Z')));
  h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
  await h.life.advance(h.seat.tabId);
  await freshSession(h);
};

/** Over the threshold at the prompt: ROTATE goes out. */
const requestRotation = async (h: IHarness) => {
  h.life.onContext(h.seat.tabId, 320_000);
  await h.life.advance(h.seat.tabId);
};

describe('settings (AC 1)', () => {
  it('parses the fleet value and the per-tab flag inside 50,000..900,000', () => {
    expect(parseRotateAtTokens('300000')).toBe(300_000);
    expect(parseRotateAtTokens('300_000')).toBe(300_000);
    expect(parseRotateAtTokens(50_000)).toBe(50_000);
    expect(parseRotateAtTokens('900000')).toBe(900_000);
    for (const bad of ['49999', '900001', '3e5', '-1', '', 'off', null, 300000.5]) expect(parseRotateAtTokens(bad)).toBeNull();
    expect(parseTabRotateAt('off')).toEqual({ ok: true, rotateAt: 'off' });
    expect(parseTabRotateAt('OFF')).toEqual({ ok: true, rotateAt: 'off' });
    expect(parseTabRotateAt('200000')).toEqual({ ok: true, rotateAt: 200_000 });
    expect(parseTabRotateAt('10')).toMatchObject({ ok: false, error: expect.stringContaining('from 50000 to 900000, got "10"') });
  });

  it('takes the fleet default, the tab value, or none when off', () => {
    expect(seatThreshold(null, 300_000)).toBe(300_000);
    expect(seatThreshold(150_000, 300_000)).toBe(150_000);
    expect(seatThreshold('off', 300_000)).toBeNull();
    const invalid: string[] = [];
    expect(fleetRotateAtFrom(null)).toBe(300_000);
    expect(fleetRotateAtFrom('120000')).toBe(120_000);
    expect(fleetRotateAtFrom('lots', (v) => invalid.push(v))).toBe(300_000);
    expect(invalid).toEqual(['lots']);
  });

  it('only a tab with a handoff path rotates', async () => {
    const h = harness();
    h.life.onContext('tab-plain', 800_000);
    await h.life.advance('tab-plain');
    expect(h.life.view('tab-plain')).toBeNull();
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('a seat with rotation off never asks, whatever its context or compactions', async () => {
    const h = harness({ rotateAt: 'off' });
    h.life.onContext(h.seat.tabId, 899_000);
    h.life.onCompact(h.seat.tabId, 'post');
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toEqual([]);
  });
});

describe('the ROTATE request (AC 2)', () => {
  it('sends the exact text once the context reaches the threshold and the tab is at its prompt', async () => {
    const h = harness();
    h.life.onContext(h.seat.tabId, 299_999);
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toEqual([]);
    await requestRotation(h);
    expect(h.sent).toEqual([{ text: `ROTATE: bring ${PATH} up to date, then end your turn with HANDOFF-READY.`, ready: true }]);
    expect(rotateMessage(PATH)).toBe(h.sent[0].text);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', rotateRequestedAt: Date.UTC(2026, 10, 3, 12, 0, 0) });
    expect(stateEvents(h)).toEqual(['rotate-requested']);
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(1);
  });

  it('a per-tab threshold wins over the fleet value', async () => {
    const h = harness({ rotateAt: 100_000 });
    h.life.onContext(h.seat.tabId, 120_000);
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(1);
  });

  it('never sends mid-turn or with background work open: nothing until the tab can rotate', async () => {
    const h = harness();
    h.ready.value = false;
    await requestRotation(h);
    expect(h.sent).toEqual([]);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('watching');
    h.ready.value = true;
    h.life.onIdle(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(1);
  });

  it('a paste refused inside the dispatch lock (a turn started) leaves the request unsent', async () => {
    let calls = 0;
    const h = harness({}, { atPrompt: () => (calls += 1) > 1 && false });
    await requestRotation(h);
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent.every((s) => s.text === rotateMessage(PATH) && !s.ready)).toBe(true);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('watching');
  });

  it('one deadline per rotation, set by the first ROTATE: past it the hold goes and one failed check counts (10-N1)', async () => {
    const h = harness();
    await requestRotation(h);
    const deadline = h.life.view(h.seat.tabId)!.deadline!;
    expect(deadline).toBe(T0 + ROTATION_DEADLINE_MS);
    h.clock.now = deadline - 1;
    await h.life.advance(h.seat.tabId);
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(true);
    h.clock.now = deadline;
    h.ready.value = false;
    await h.life.tick();
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', failures: 1, deadline: null });
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    expect(h.events.at(-1)?.attrs).toMatchObject({ rotationTimedOut: true, lastCheckFailure: 'no rotation within 30 min of the first ROTATE (the seat was rotate-requested)' });
    // The context is still over the threshold, but the next rotation waits 30 min: the hold is never back-to-back.
    h.ready.value = true;
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(1);
    expect(h.life.view(h.seat.tabId)!.nextRotationAt).toBe(deadline + ROTATION_DEADLINE_MS);
    h.clock.now = deadline + ROTATION_DEADLINE_MS;
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(2);
    expect(h.life.view(h.seat.tabId)!.deadline).toBe(deadline + 2 * ROTATION_DEADLINE_MS);
    h.clock.now += ROTATION_DEADLINE_MS;
    await h.life.tick();
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotation-alarm', failures: 2 });
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    await h.life.tick();
    expect(h.sent).toHaveLength(2);
  });
});

describe('HANDOFF-READY and the check (AC 3)', () => {
  it('reads HANDOFF-READY as the last line, with or without a colon or emphasis', () => {
    expect(isHandoffReady('Updated the file.\n\nHANDOFF-READY')).toBe(true);
    expect(isHandoffReady('HANDOFF-READY: handoff.md at 12:03Z\n')).toBe(true);
    expect(isHandoffReady('**HANDOFF-READY**')).toBe(true);
    expect(isHandoffReady('HANDOFF-READY.')).toBe(true);
    expect(isHandoffReady('HANDOFF-READY!')).toBe(true);
    expect(isHandoffReady('HANDOFF-READY:')).toBe(true);
    expect(isHandoffReady('handoff-ready')).toBe(false);
    expect(isHandoffReady('HANDOFF-READY.. done')).toBe(false);
    expect(isHandoffReady('HANDOFF-READY\nthen more')).toBe(false);
    expect(isHandoffReady('HANDOFF-READYish')).toBe(false);
    expect(isHandoffReady(null)).toBe(false);
  });

  it('pass: restarts --clear, then types "Read <path>, then continue: <resume command>" into the fresh session only (F4)', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.clock.now += 60_000;
    h.life.onTurnEnd(h.seat.tabId, 'Done.\nHANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([h.seat.tabId]);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotating', rotations: 1, sessionBefore: 'sess-1', restartedAt: h.clock.now });
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(true);
    // The pre-restart idle is no gate: nothing is typed until a session newer than the restart reports in.
    h.life.onIdle(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect(h.first).toEqual([]);
    await freshSession(h);
    expect(h.first).toEqual([`Read ${PATH}, then continue: /v2-orchestrate`]);
    expect(resumeMessage(PATH, '/v2-orchestrate')).toBe(h.first[0]);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', rotations: 1, contextTokens: null, failures: 0 });
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    expect(stateEvents(h)).toEqual(['rotate-requested', 'handoff-ready', 'rotating', 'rotating', 'watching']);
    const rotating = h.events.filter((e) => e.state === 'rotating');
    expect(rotating[0].attrs).toMatchObject({ firstMessage: h.first[0], sessionBefore: 'sess-1', restartedAt: null });
    expect(rotating[1].attrs).toMatchObject({ rotations: 1, restartedAt: h.clock.now, compactionsSinceRotation: 0, rotationFailures: 0 });
  });

  it('the first message waits while the fresh agent is not idle, and goes when it is', async () => {
    const h = harness();
    await requestRotation(h);
    h.firstReady.value = false;
    await rotate(h);
    expect(h.first).toEqual([]);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('rotating');
    h.firstReady.value = true;
    h.life.onIdle(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect(h.first).toHaveLength(1);
  });

  it('a fresh session bound without a session-start event (a hook missed) also opens the gate', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    h.session.value = 'sess-1';
    await h.life.tick();
    expect(h.first).toEqual([]);
    h.session.value = 'sess-9';
    await h.life.tick();
    expect(h.first).toHaveLength(1);
  });

  it('drops the first message 10 min after the restart if no fresh session came', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    h.clock.now += FIRST_MESSAGE_TTL_MS;
    await h.life.tick();
    expect(h.first).toEqual([]);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('watching');
    expect(h.events.at(-1)?.attrs).toMatchObject({ firstMessageDropped: true });
  });

  it('a turn end without HANDOFF-READY asks ROTATE again at the next idle, with a new request time (F1)', async () => {
    const h = harness();
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    await requestRotation(h);
    const first = h.life.view(h.seat.tabId)!.rotateRequestedAt;
    h.clock.now += 60_000;
    h.life.onTurnEnd(h.seat.tabId, 'DONE: something else');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent.map((x) => x.text)).toEqual([rotateMessage(PATH), rotateMessage(PATH)]);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', resendRotate: false });
    expect(h.life.view(h.seat.tabId)!.rotateRequestedAt).toBe(first! + 60_000);
  });

  it('REVIEW R1: a turn after HANDOFF-READY that is not HANDOFF-READY never rotates from the older file (F1)', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.ready.value = false;
    h.life.onTurnEnd(h.seat.tabId, 'Updated.\nHANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('handoff-ready');
    h.clock.now += 120_000;
    h.life.onTurnEnd(h.seat.tabId, 'Merged PR #12; decided to park story 7.\nDONE: digest handled');
    h.ready.value = true;
    h.life.onIdle(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent.map((x) => x.text)).toEqual([rotateMessage(PATH), rotateMessage(PATH)]);
    // The file of 12:00 is older than the second request: a HANDOFF-READY now fails the check.
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent.at(-1)?.text).toContain('is older than the rotate request 2026-11-03T12:02:00Z');
  });

  it('a submission after HANDOFF-READY (an urgent message, a send) puts the seat back to rotate-requested (F1)', async () => {
    const h = harness();
    await requestRotation(h);
    h.ready.value = false;
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    h.life.onPromptSubmit(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', resendRotate: true });
    // A prompt-submit while ROTATE is open is the ROTATE turn itself: no change.
    h.ready.value = true;
    await h.life.advance(h.seat.tabId);
    h.life.onPromptSubmit(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', resendRotate: false });
  });

  it('holds digests while a rotation is owed or under way, not while watching or in alarm', async () => {
    const h = harness();
    h.life.register(h.seat.tabId);
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    await requestRotation(h);
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(true);
    expect(h.life.holdsDigest('tab-plain')).toBe(false);
  });

  it('HANDOFF-READY with background work open: the wake that ends that work needs a fresh HANDOFF-READY (F1)', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.ready.value = false;
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('handoff-ready');
    // The background task returns: a new turn that ends with its result, not HANDOFF-READY.
    h.ready.value = true;
    h.life.onTurnEnd(h.seat.tabId, 'The gate passed.\nDONE: gate green');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent).toHaveLength(2);
    h.files.set(PATH, handoffText(new Date(h.life.view(h.seat.tabId)!.rotateRequestedAt!).toISOString().replace('.000Z', 'Z')));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toHaveLength(1);
  });

  it('fail once: one message naming the failed check, and the request stands', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T11:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].text).toBe(checkFailedMessage(PATH, [
      'updated stamp 2026-11-03T11:00:00Z is older than the rotate request 2026-11-03T12:00:00Z (expected at or after it)',
    ]));
    expect(h.sent[1].text).toMatch(/^HANDOFF CHECK FAILED: .*older than the rotate request.*\. Fix the file, then end your turn with HANDOFF-READY\.$/);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', failures: 1 });
  });

  it('a failed-check message refused at the paste is retried until typed', async () => {
    let refuse = 1;
    const typedTexts: string[] = [];
    const h = harness({}, {
      send: async (_seat, text) => {
        if (text.startsWith('HANDOFF CHECK FAILED') && refuse-- > 0) return false;
        typedTexts.push(text);
        return true;
      },
    });
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T11:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    await vi.waitFor(() => expect(typedTexts.filter((t) => t.startsWith('HANDOFF CHECK FAILED'))).toHaveLength(1));
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', failures: 1, pendingMessage: null });
  });

  it('fail twice: the alarm on the seat item, no message, the session left as it is', async () => {
    const h = harness();
    await requestRotation(h);
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.sent.at(-1)?.text).toContain('cannot read');
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z', ''));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(2);
    expect(h.restarts).toEqual([]);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotation-alarm', failures: 2 });
    const alarm = h.events.at(-1)!;
    expect(alarm).toMatchObject({ kind: 'state', state: 'rotation-alarm', item_key: seatItemKey('ws-a', 'orch') });
    expect(alarm.attrs).toMatchObject({ rotationFailures: 2, rotationAlarm: '## Resume command has 0 non-empty lines (expected exactly 1)' });
    h.life.onContext(h.seat.tabId, 600_000);
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(2);
  });

  it('after an alarm, a HANDOFF-READY whose check passes rotates and clears it', async () => {
    const h = harness();
    h.item.value = { state: 'rotation-alarm', attrs: { rotationFailures: 2, rotationAlarm: 'x', rotateRequestedAt: T0 - 60_000 } };
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toHaveLength(1);
    await freshSession(h);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', failures: 0, alarm: null });
  });

  it('a restart refused as busy waits for the next idle; any other refusal is a failed check', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.restartOutcome.value = { ok: false, busy: true, error: 'the tab is mid-turn' };
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'handoff-ready', failures: 0 });
    h.restartOutcome.value = { ok: false, busy: false, error: 'the reap left a process behind' };
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', failures: 1 });
    expect(h.sent.at(-1)?.text).toContain('the restart failed: the reap left a process behind');
    expect(h.first).toEqual([]);
  });

  it('a busy refusal is retried shortly without another idle, then counts nothing', async () => {
    const h = harness({}, { retryMs: 10 });
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.restartOutcome.value = { ok: false, busy: true, error: 'tab-busy: the tab is mid-turn' };
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    const refused = h.restarts.length;
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'handoff-ready', failures: 0 });
    h.restartOutcome.value = { ok: true };
    await vi.waitFor(() => expect(h.restarts).toHaveLength(refused + 1));
    await vi.waitFor(() => expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotating', rotations: 1, failures: 0 }));
  });

  it('cuts a long list of reasons in the message and points at the CLI', () => {
    const text = checkFailedMessage(PATH, Array.from({ length: 60 }, (_, i) => `reason ${i} ${'x'.repeat(40)}`));
    expect(Buffer.byteLength(text)).toBeLessThan(2_048);
    expect(text).toContain(`(purplemux handoff check ${PATH} prints every reason)`);
  });
});

describe('compaction (AC 4)', () => {
  it('PreCompact counts on the seat item; after PostCompact the rotation runs at the next idle, below the threshold', async () => {
    const h = harness();
    h.life.onContext(h.seat.tabId, 120_000);
    h.ready.value = false;
    h.life.onCompact(h.seat.tabId, 'pre');
    expect(h.life.view(h.seat.tabId)).toMatchObject({ compactions: 1, compactionsSinceRotation: 1 });
    const counted = h.events.at(-1)!;
    expect(counted).toMatchObject({ kind: 'clear', item_type: 'seat' });
    expect(counted.attrs).toMatchObject({ compactions: 1, compactionsSinceRotation: 1, lastCompactAt: T0 });
    h.life.onCompact(h.seat.tabId, 'post');
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toEqual([]);
    h.ready.value = true;
    h.life.onIdle(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect(h.sent.map((s) => s.text)).toEqual([rotateMessage(PATH)]);
    expect(h.events.at(-1)?.attrs).toMatchObject({ rotateReason: 'compaction' });
  });

  it('a rotation resets the compactions since it, not the total', async () => {
    const h = harness();
    h.life.onCompact(h.seat.tabId, 'pre');
    h.life.onCompact(h.seat.tabId, 'post');
    await h.life.advance(h.seat.tabId);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ compactions: 1, compactionsSinceRotation: 0, compactionPending: false, rotations: 1 });
  });
});

describe('REVIEW r2 repros (10-N1, 10-N2, 10-N4)', () => {
  it('Q1: request, HANDOFF-READY not ready, a DONE turn, idle: no restart, ROTATE resent', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.ready.value = false;
    h.life.onTurnEnd(h.seat.tabId, 'Updated.\nHANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('handoff-ready');
    h.clock.now += 120_000;
    h.life.onTurnEnd(h.seat.tabId, 'Merged PR #12.\nDONE: digest handled');
    h.ready.value = true;
    h.life.onIdle(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent.filter((x) => x.text.startsWith('ROTATE'))).toHaveLength(2);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('rotate-requested');
  });

  it('Q2: handoff-ready resumed with a changed session and an older rotation on record types the first message (10-N2)', async () => {
    const h = harness();
    h.item.value = { state: 'handoff-ready', attrs: { rotateRequestedAt: T0, readySessionId: 'sess-1', lastRotationAt: T0 - 86_400_000, rotations: 3 } };
    h.session.value = 'sess-7';
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z', '/v2-orchestrate --resume'));
    h.life.register(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotating', restartedAt: T0 });
    await h.life.advance(h.seat.tabId);
    expect(h.first).toEqual([`Read ${PATH}, then continue: /v2-orchestrate --resume`]);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('watching');
  });

  it('Q3: turns without HANDOFF-READY hold digests at most 30 min, with at most 2 ROTATEs', async () => {
    const h = harness();
    await requestRotation(h);
    let heldFor = 0;
    for (let i = 0; i < 3; i += 1) {
      h.clock.now += 10 * 60_000;
      h.life.onTurnEnd(h.seat.tabId, `DONE: step ${i}`);
      await h.life.advance(h.seat.tabId);
      await h.life.tick();
      if (h.life.holdsDigest(h.seat.tabId)) heldFor += 10;
    }
    expect(heldFor).toBeLessThanOrEqual(20);
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    expect(h.sent.filter((x) => x.text.startsWith('ROTATE')).length).toBeLessThanOrEqual(2);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', failures: 1 });
  });

  it('Q4: HANDOFF-READY while canRotate stays false: the hold is released at the deadline', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.ready.value = false;
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    for (let i = 0; i < 3; i += 1) {
      h.clock.now += 10 * 60_000;
      await h.life.tick();
    }
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', failures: 1 });
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    expect(h.restarts).toEqual([]);
  });

  it('names the hold for the stale-digest flag while it lasts', async () => {
    const h = harness();
    expect(h.life.holdReason(h.seat.tabId)).toBeNull();
    await requestRotation(h);
    expect(h.life.holdReason(h.seat.tabId)).toBe("the seat's context rotation holds its digests (phase rotate-requested, released by 2026-11-03T12:30:00Z at the latest)");
  });

  it('a turn without HANDOFF-READY and a submission after it move the request time: the stamp must be newer (10-N4)', async () => {
    const h = harness();
    await requestRotation(h);
    h.ready.value = false;
    h.clock.now = Date.UTC(2026, 10, 3, 12, 5, 0, 700);
    h.life.onTurnEnd(h.seat.tabId, 'DONE: other work');
    expect(h.life.view(h.seat.tabId)?.rotateRequestedAt).toBe(Date.UTC(2026, 10, 3, 12, 5));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    h.clock.now = Date.UTC(2026, 10, 3, 12, 7, 0, 200);
    h.life.onPromptSubmit(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', rotateRequestedAt: Date.UTC(2026, 10, 3, 12, 7) });
    // A file stamped 12:06 now fails the check.
    h.files.set(PATH, handoffText('2026-11-03T12:06:00Z'));
    h.ready.value = true;
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.restarts).toEqual([]);
    expect(h.sent.at(-1)?.text).toContain('is older than the rotate request 2026-11-03T12:07:00Z');
  });
});

describe('architect confirmation probes (P1-P3) and the urgent hold', () => {
  it('P1: server down 15 min after the restart, before the first message: the idle fresh session gets its handoff read', async () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: `Read ${PATH}, then continue: /v2-orchestrate`, sessionBefore: 'sess-1', restartedAt: T0 - 15 * 60_000, rotations: 4 } };
    h.session.value = 'sess-2';
    h.life.register(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect({ first: h.first, phase: h.life.view(h.seat.tabId)?.phase, dropped: h.events.some((e) => e.attrs?.firstMessageDropped === true) })
      .toEqual({ first: [`Read ${PATH}, then continue: /v2-orchestrate`], phase: 'watching', dropped: false });
  });

  it('P2: rotating resumed with no restart time and a changed session: the hold has a bound', async () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: 'Read x, then continue: y', sessionBefore: 'sess-1', restartedAt: null, rotateRequestedAt: T0 - 60_000 } };
    h.session.value = 'sess-2';
    h.firstReady.value = false;
    h.life.register(h.seat.tabId);
    for (let i = 0; i < 360; i += 1) {
      h.clock.now += 30_000;
      await h.life.tick();
    }
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    expect(h.life.holdsUrgent(h.seat.tabId)).toBe(false);
  });

  it('P3: after a timed-out alarm, one HANDOFF-READY while canRotate is false: the hold has a bound', async () => {
    const h = harness();
    await requestRotation(h);
    h.clock.now += 31 * 60_000;
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', failures: 1 });
    h.clock.now += 31 * 60_000;
    h.life.onContext(h.seat.tabId, 330_000);
    await h.life.advance(h.seat.tabId);
    h.clock.now += 31 * 60_000;
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotation-alarm', deadline: null });
    h.ready.value = false;
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)!.deadline).toBe(h.clock.now + ROTATION_DEADLINE_MS);
    h.life.onTurnEnd(h.seat.tabId, 'DONE: merged');
    h.ready.value = true;
    let heldTicks = 0;
    for (let i = 0; i < 360; i += 1) {
      h.clock.now += 30_000;
      await h.life.tick();
      if (i % 20 === 0) h.life.onTurnEnd(h.seat.tabId, 'DONE: next');
      if (h.life.holdsDigest(h.seat.tabId)) heldTicks += 1;
    }
    expect(heldTicks).toBeLessThanOrEqual(60);
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(false);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('rotation-alarm');
  });

  it('holds urgent events only while rotating and releases them from the rotation start once the first message is typed', async () => {
    const h = harness();
    await requestRotation(h);
    expect(h.life.holdsUrgent(h.seat.tabId)).toBe(false);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.clock.now += 1_000;
    const rotatingAt = h.clock.now;
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.holdsUrgent(h.seat.tabId)).toBe(true);
    expect(h.released).toEqual([]);
    await freshSession(h);
    expect(h.first).toHaveLength(1);
    expect(h.released).toEqual([rotatingAt]);
    expect(h.life.holdsUrgent(h.seat.tabId)).toBe(false);
  });

  it('releases the held urgent events when the first message is dropped, and marks the handoff undelivered for the board', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    h.clock.now += FIRST_MESSAGE_TTL_MS;
    await h.life.tick();
    expect(h.released).toHaveLength(1);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'watching', handoffUndeliveredAt: h.clock.now });
    expect(h.events.at(-1)?.attrs).toMatchObject({ handoffUndeliveredAt: h.clock.now, firstMessageDropped: true });
    // A later rotation that delivers its first message clears the flag.
    h.clock.now += 31 * 60_000;
    await requestRotation(h);
    await rotate(h);
    expect(h.life.view(h.seat.tabId)?.handoffUndeliveredAt).toBeNull();
    expect(h.events.at(-1)?.attrs).toMatchObject({ handoffUndeliveredAt: null });
  });

  it('U1: rotating persisted, restart never ran, server resumes it as handoff-ready, the re-check FAILS: the held urgent rows are released', async () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: 'x', sessionBefore: 'sess-1', restartedAt: null, rotateRequestedAt: T0, rotatingSince: T0 - 2_000, rotationDeadline: T0 + 20 * 60_000 } };
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z', ''));
    h.life.register(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'handoff-ready', rotatingSince: T0 - 2_000 });
    expect(h.life.holdsUrgent(h.seat.tabId)).toBe(false);
    await h.life.advance(h.seat.tabId);
    expect({ phase: h.life.view(h.seat.tabId)?.phase, released: h.released, rotatingSince: h.life.view(h.seat.tabId)?.rotatingSince })
      .toEqual({ phase: 'rotate-requested', released: [T0 - 2_000], rotatingSince: null });
  });

  it('U2: same resume, the deadline passes before a check: the held urgent rows are released', async () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: 'x', sessionBefore: 'sess-1', restartedAt: null, rotateRequestedAt: T0 - 40 * 60_000, rotatingSince: T0 - 35 * 60_000, rotationDeadline: T0 - 5 * 60_000 } };
    h.life.register(h.seat.tabId);
    await h.life.advance(h.seat.tabId);
    expect({ phase: h.life.view(h.seat.tabId)?.phase, released: h.released }).toEqual({ phase: 'watching', released: [T0 - 35 * 60_000] });
  });

  it('a restart refused busy releases what the rotation held', async () => {
    const h = harness();
    await requestRotation(h);
    h.files.set(PATH, handoffText('2026-11-03T12:00:00Z'));
    h.restartOutcome.value = { ok: false, busy: true, error: 'tab-busy' };
    h.life.onTurnEnd(h.seat.tabId, 'HANDOFF-READY');
    await h.life.advance(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('handoff-ready');
    expect(h.released.length).toBeGreaterThan(0);
    expect(h.life.holdsUrgent(h.seat.tabId)).toBe(false);
  });
});

describe('the seat item (AC 5)', () => {
  it('opens once per tab, holder the tab name, keyed seat:<ws>:<tab-name>', () => {
    const h = harness();
    h.life.register(h.seat.tabId);
    h.life.register(h.seat.tabId);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      event_id: `purplemux:seat:ws-a:orch:open:${h.seat.tabId}`, kind: 'open', item_type: 'seat', item_key: 'seat:ws-a:orch', holder: 'orch',
    });
    expect(h.events[0].attrs).toMatchObject({ tabId: 'tab-orch', handoffPath: PATH, rotateAtTokens: 300_000, compactions: 0, rotations: 0 });
  });

  it('records the context at most every 5 min, and only a changed reading', async () => {
    const h = harness();
    h.life.onContext(h.seat.tabId, 100_000);
    h.clock.now += 60_000;
    h.life.onContext(h.seat.tabId, 110_000);
    const readings = () => h.events.filter((e) => e.kind === 'clear').map((e) => e.attrs?.contextTokens);
    expect(readings()).toEqual([100_000]);
    h.clock.now += CONTEXT_RECORD_MS;
    await h.life.tick();
    expect(readings()).toEqual([100_000, 110_000]);
    h.clock.now += CONTEXT_RECORD_MS;
    await h.life.tick();
    expect(readings()).toEqual([100_000, 110_000]);
  });

  it('carries its counts and an open alarm or request across a server restart from the open item', () => {
    const h = harness();
    h.item.value = { state: 'rotate-requested', attrs: { compactions: 7, compactionsSinceRotation: 2, rotations: 3, lastRotationAt: 5, rotateRequestedAt: T0 - 1_000, rotationFailures: 1 } };
    h.life.register(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotate-requested', compactions: 7, compactionsSinceRotation: 2, rotations: 3, failures: 1, rotateRequestedAt: T0 - 1_000 });
  });

  it('a server restart mid-rotation resumes rotating and types the first message into the fresh session (F3)', async () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: `Read ${PATH}, then continue: /v2-orchestrate`, sessionBefore: 'sess-1', restartedAt: T0 - 5_000, rotations: 4 } };
    h.session.value = null;
    h.life.register(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotating', rotations: 4, freshSession: false });
    expect(h.life.holdsDigest(h.seat.tabId)).toBe(true);
    await freshSession(h);
    expect(h.first).toEqual([`Read ${PATH}, then continue: /v2-orchestrate`]);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('watching');
  });

  it('a server restart after the boot scan bound the fresh session: the changed session id opens the gate (F3)', async () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: 'Read x, then continue: y', sessionBefore: 'sess-1', restartedAt: T0 - 5_000 } };
    h.session.value = 'sess-2';
    h.life.register(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)).toMatchObject({ phase: 'rotating', freshSession: true });
    await h.life.advance(h.seat.tabId);
    expect(h.first).toEqual(['Read x, then continue: y']);
  });

  it('rotating persisted before a restart that never ran (same session, no restart time): the check runs again (F3)', () => {
    const h = harness();
    h.item.value = { state: 'rotating', attrs: { firstMessage: 'x', sessionBefore: 'sess-1', restartedAt: null, rotateRequestedAt: T0 } };
    h.life.register(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)?.phase).toBe('handoff-ready');
  });

  it('REVIEW R2: handoff-ready resumed with the same session owes a fresh HANDOFF-READY; a changed session was restarted (F3)', async () => {
    const same = harness();
    same.item.value = { state: 'handoff-ready', attrs: { rotateRequestedAt: T0, readySessionId: 'sess-1' } };
    same.life.register(same.seat.tabId);
    expect(same.life.view(same.seat.tabId)).toMatchObject({ phase: 'rotate-requested', resendRotate: true });
    await same.life.advance(same.seat.tabId);
    expect(same.sent.map((x) => x.text)).toEqual([rotateMessage(PATH)]);

    const changed = harness();
    changed.item.value = { state: 'handoff-ready', attrs: { rotateRequestedAt: T0, readySessionId: 'sess-1' } };
    changed.session.value = 'sess-7';
    changed.files.set(PATH, handoffText('2026-11-03T12:00:00Z', '/v2-orchestrate --resume'));
    changed.life.register(changed.seat.tabId);
    expect(changed.life.view(changed.seat.tabId)?.phase).toBe('rotating');
    await changed.life.advance(changed.seat.tabId);
    expect(changed.first).toEqual([`Read ${PATH}, then continue: /v2-orchestrate --resume`]);
    expect(changed.restarts).toEqual([]);
  });

  it('a /clear (session start) drops the reading: the next tick sends no ROTATE (F5)', async () => {
    const h = harness();
    h.ready.value = false;
    h.life.onContext(h.seat.tabId, 400_000);
    h.life.onSessionStart(h.seat.tabId);
    h.ready.value = true;
    await h.life.tick();
    expect(h.sent).toEqual([]);
    expect(h.life.view(h.seat.tabId)?.contextTokens).toBeNull();
  });

  it('a reading of an earlier session is dropped once the tab is bound to another (F5)', async () => {
    const h = harness();
    h.ready.value = false;
    h.life.onContext(h.seat.tabId, 400_000, 'sess-1');
    h.session.value = 'sess-2';
    h.ready.value = true;
    await h.life.tick();
    expect(h.sent).toEqual([]);
    h.life.onContext(h.seat.tabId, 310_000, 'sess-2');
    await h.life.advance(h.seat.tabId);
    expect(h.sent).toHaveLength(1);
  });

  it('a ledger that cannot be written never stops a rotation', async () => {
    const h = harness({}, { record: () => { throw new Error('ledger unreadable'); } });
    await requestRotation(h);
    expect(h.sent).toHaveLength(1);
  });

  it('closes the item when the tab closes', () => {
    const h = harness();
    h.life.register(h.seat.tabId);
    h.life.onClosed(h.seat.tabId, h.seat);
    expect(h.events.at(-1)).toMatchObject({ kind: 'close', state: 'closed', event_id: `purplemux:seat:ws-a:orch:close:${h.seat.tabId}` });
    expect(h.life.view(h.seat.tabId)).toBeNull();
  });

  it('forgets the context reading after an outside restart', () => {
    const h = harness();
    h.life.onContext(h.seat.tabId, 250_000);
    h.life.onRestarted(h.seat.tabId);
    expect(h.life.view(h.seat.tabId)?.contextTokens).toBeNull();
  });
});

describe('serialized steps', () => {
  it('two idles at once send one ROTATE', async () => {
    const h = harness();
    h.life.onContext(h.seat.tabId, 400_000);
    await Promise.all([h.life.advance(h.seat.tabId), h.life.advance(h.seat.tabId), h.life.advance(h.seat.tabId)]);
    expect(h.sent).toHaveLength(1);
  });
});
