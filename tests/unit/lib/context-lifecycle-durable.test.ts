import { describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINT_LIVE_MS, ContextLifecycle, FIRST_MESSAGE_TTL_MS, HandoffRefused, ROTATION_DEADLINE_MS, SEAT_BUSY_FACE, SeatHostUnreachable, restartRefusalOutcome, restartWaitFace,
  type IContextLifecycleDeps, type TRestartOutcome,
} from '@/lib/context-lifecycle';
import { LedgerStore, SERVER_PRODUCER } from '@/lib/ledger-store';
import type { ISeatTab } from '@/types/context-lifecycle';
import type { IGitFacts, TCheckpointStatus } from '@/types/rotation-checkpoint';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

// vel-D5: a rotation clears a session only after a durable checkpoint, and a server that stops anywhere in the
// rotation resumes from stored state: the right task, its decisions kept, no clear and no first message twice.
// The world (the tab, its session, its files, the ledger file) outlives each server; a "server" is one
// ContextLifecycle over the same LedgerStore.

const T0 = Date.UTC(2026, 10, 8, 9, 0, 0, 0);
const PATH = '/srv/wt/.v2/seats/kit/handoff.md';
const TASK = 'seat:ws-a:kit';
const FACTS: IGitFacts = {
  kind: 'ok', cwd: '/srv/wt', worktree: '/srv/wt', branch: 'story/7', head: 'a'.repeat(40), baseRef: 'origin/main', base: 'b'.repeat(40), dirty: 0,
};

interface IPoint {
  name: string;
  inFlight: string;
  openQuestions: string[];
  doNot: string;
  resume: string;
  /** A `tab bg` job runs when the rotation comes due, and lives past one server restart. */
  backgroundJob?: boolean;
}

const POINTS: IPoint[] = [
  { name: 'after implementation', inFlight: '| story-7 | implemented | request review | reviewer |', openQuestions: ['MC-101'], doNot: '- nothing', resume: '/implement story-7 --request-review' },
  { name: 'during a long background job', inFlight: '| story-7 | gate running | read the gate log | tab bg job 4242 |', openQuestions: [], doNot: '- Kill the gate: it is the only green run.', resume: '/implement story-7 --await-gate', backgroundJob: true },
  { name: 'after review', inFlight: '| story-7 | reviewed | fix 2 findings | none |', openQuestions: ['MC-102', 'MC-103'], doNot: '- Retry the flaky gate unchanged.', resume: '/implement story-7 --fix-findings' },
  { name: 'after merge, before the deploy acknowledgement', inFlight: '| story-7 | merged | await the deploy ack | owner |', openQuestions: ['MC-104'], doNot: '- Merge PR 12 again: it is merged.', resume: '/deploy-test story-7 --await-ack' },
];

const handoff = (point: IPoint, stamp: string) => [
  `# Handoff: kit · updated ${stamp}`, '',
  '## Role', '/v2-lane kit', '',
  '## In flight', '| item key | state | next action | waiting on |', '| --- | --- | --- | --- |', point.inFlight, '',
  '## Open questions', ...(point.openQuestions.length ? point.openQuestions.map((id) => `- ${id}`) : ['none']), '',
  '## Standing rules', '- Land through tools/land.sh only. (source: DEC-58)', '',
  '## Decisions in the last 24 h', 'none', '',
  '## Do not', point.doNot, '',
  '## Resume command', point.resume, '',
].join('\n');

const stampOf = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const never = <T>() => new Promise<T>(() => {});

type TCrash = 'none' | 'before-checkpoint' | 'after-write' | 'after-clear' | 'during-delivery' | 'after-delivery';

/** What outlives a server: the tab, its agent session, its files, the git worktree and the ledger file. */
interface IWorld {
  clock: { now: number };
  store: LedgerStore;
  session: string | null;
  files: Map<string, string>;
  facts: IGitFacts;
  atPrompt: boolean;
  jobLive: boolean;
  hostDown: boolean;
  /** The clears that ran on the tab, and the first messages typed into it. */
  clears: number;
  typed: string[];
  rotates: string[];
  crash: TCrash;
  placed: number;
  seq: number;
  /** While true, every restart answers 503 remote-host-unreachable, before anything is killed; the test lifts it. */
  restartHostDown: boolean;
  /** Restarts refused because the host was down. */
  restartRefusals: number;
  /** While true, every restart answers tab-busy (a turn on its way); the test lifts it. */
  restartBusy: boolean;
  storeFails: { put?: boolean; readBack?: 'missing' | 'tampered'; record?: boolean };
}

const world = (): IWorld => ({
  clock: { now: T0 }, store: new LedgerStore(':memory:'), session: 'sess-1', files: new Map(), facts: FACTS, atPrompt: true,
  jobLive: false, hostDown: false, clears: 0, typed: [], rotates: [], crash: 'none', placed: 0, seq: 0, storeFails: {}, restartHostDown: false,
  restartRefusals: 0, restartBusy: false,
});

const SEAT: ISeatTab = { workspaceId: 'ws-a', tabId: 'tab-kit', tabName: 'kit', handoffPath: PATH, rotateAt: null, host: 'ai-server' };

/** One server process over the world; a start takes a moment, so its ledger event ids never meet the last one's. */
const server = (w: IWorld, overrides: Partial<IContextLifecycleDeps> = {}): ContextLifecycle => {
  w.clock.now += 1_000;
  return lifecycle(w, overrides);
};

const lifecycle = (w: IWorld, overrides: Partial<IContextLifecycleDeps>): ContextLifecycle => new ContextLifecycle({
  now: () => w.clock.now,
  seat: (tabId) => (tabId === SEAT.tabId ? SEAT : null),
  seats: () => [SEAT],
  fleetRotateAt: () => 300_000,
  sessionId: () => w.session,
  canRotate: async () => w.atPrompt && !w.jobLive,
  atPrompt: () => w.atPrompt,
  send: async (_seat, text, whenReady) => {
    if (!whenReady()) return false;
    w.rotates.push(text);
    return true;
  },
  readHandoff: async (file) => {
    if (w.hostDown) throw new SeatHostUnreachable('remote host ai-server did not answer over ssh (timed out)');
    const text = w.files.get(file);
    if (text === undefined) throw new Error('ENOENT');
    return text;
  },
  gitFacts: async (_seat, expectedHead) => {
    if (w.hostDown) throw new SeatHostUnreachable('remote host ai-server did not answer over ssh (timed out)');
    return { ...w.facts, ...(expectedHead ? { containsExpected: w.facts.head === expectedHead } : {}) };
  },
  placeCheckpoint: async (_seat, checkpoint, restore) => {
    if (w.hostDown) throw new SeatHostUnreachable('remote host ai-server did not answer over ssh (timed out)');
    w.placed += 1;
    if (restore && w.files.get(checkpoint.handoffPath) !== checkpoint.handoffText) {
      w.files.set(checkpoint.handoffPath, checkpoint.handoffText);
      return { restored: true };
    }
    return { restored: false };
  },
  checkpoints: {
    put: (checkpoint, at) => {
      if (w.storeFails.put) throw new Error('SQLITE_FULL: database or disk is full');
      w.store.checkpoints.put(checkpoint, at);
    },
    get: (workspaceId, id) => {
      const row = w.store.checkpoints.get(workspaceId, id);
      if (w.storeFails.readBack === 'missing') return null;
      if (row && w.storeFails.readBack === 'tampered') return { ...row, checkpoint: { ...row.checkpoint, intendedNextAction: 'rm -rf /' } };
      return row;
    },
    latest: (workspaceId, taskId) => w.store.checkpoints.latest(workspaceId, taskId),
    mark: (workspaceId, id, from, to, at) => w.store.checkpoints.mark(workspaceId, id, from, to, at),
    abandonTab: (tabId, at) => w.store.checkpoints.abandonTab(tabId, at),
  },
  restart: async (): Promise<TRestartOutcome> => {
    if (w.crash === 'after-write') return never();
    if (w.restartBusy) return restartRefusalOutcome('tab-busy', 'the tab is mid-turn; restart it with --interrupt to abandon the turn');
    if (w.restartHostDown) {
      w.restartRefusals += 1;
      return restartRefusalOutcome('remote-host-unreachable', 'remote host ai-server did not answer over ssh (exit 255)');
    }
    w.clears += 1;
    w.session = null;
    if (w.crash === 'after-clear') return never();
    return { ok: true };
  },
  typeFirstMessage: async (_seat, text) => {
    if (!w.atPrompt) return false;
    w.typed.push(text);
    if (w.crash === 'during-delivery') return never();
    return true;
  },
  releaseUrgent: () => {},
  record: (workspaceId, events) => {
    if (w.storeFails.record) throw new Error('ledger is read-only');
    w.store.append(workspaceId, SERVER_PRODUCER, events, w.clock.now);
  },
  readSeatItem: (workspaceId, itemKey, holder) => {
    const item = w.store.items(workspaceId, { open: true, type: 'seat', holder }, w.clock.now).items.find((row) => row.itemKey === itemKey);
    return item ? { state: item.state, attrs: item.attrs } : null;
  },
  retryMs: 1,
  ...overrides,
});

const seatItem = (w: IWorld) => w.store.items('ws-a', { type: 'seat' }, w.clock.now).items.find((row) => row.itemKey === TASK);
const latest = (w: IWorld) => w.store.checkpoints.latest('ws-a', TASK);

/** Over the threshold at the prompt: ROTATE is typed. */
const request = async (w: IWorld, life: ContextLifecycle) => {
  life.onContext(SEAT.tabId, 320_000, w.session);
  await life.advance(SEAT.tabId);
};

/** The seat writes its handoff and ends its turn with HANDOFF-READY. */
const handoffReady = async (w: IWorld, life: ContextLifecycle, point: IPoint) => {
  w.clock.now += 30_000;
  w.files.set(PATH, handoff(point, stampOf(w.clock.now)));
  life.onTurnEnd(SEAT.tabId, 'HANDOFF-READY');
  await flush();
};

/** The fresh session binds and reports in, idle at its prompt. */
const freshSession = async (life: ContextLifecycle, w: IWorld) => {
  w.session = 'sess-2';
  life.onSessionStart(SEAT.tabId);
  await flush();
  if (w.crash === 'none') await life.advance(SEAT.tabId);
};

describe('a durable checkpoint gates the clear (AC1)', () => {
  it('a passing check writes the checkpoint, reads it back, then clears; the row goes the whole way', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[2]);
    expect(w.clears).toBe(1);
    expect(latest(w)).toMatchObject({ status: 'cleared', checkpoint: { id: `${TASK}#1`, attempt: 1, host: 'ai-server', facts: FACTS, sessionBefore: 'sess-1' } });
    expect(seatItem(w)).toMatchObject({ state: 'rotating', attrs: { checkpointId: `${TASK}#1` } });
    await freshSession(life, w);
    expect(w.typed).toHaveLength(1);
    expect(w.typed[0]).toContain(`Read ${PATH}, then continue: /implement story-7 --fix-findings RESTORE NOTICE (checkpoint ${TASK}#1): verified worktree /srv/wt`);
    expect(latest(w)?.status).toBe('delivered');
    expect(seatItem(w)).toMatchObject({ state: 'watching', attrs: { resumeVerdict: 'match', rotations: 1 } });
    expect(w.placed).toBe(2);
  });

  it.each([
    ['the write throws', { put: true }, 'is not durable: SQLITE_FULL: database or disk is full'],
    ['the read-back finds no row', { readBack: 'missing' as const }, 'is not durable: the read-back found no row'],
    ['the read-back differs', { readBack: 'tampered' as const }, 'is not durable: the read-back digest is'],
  ])('%s: no clear, the seat stays handoff-ready, the refusal is visible and counted once', async (_label, fails, reason) => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.storeFails = fails;
    await handoffReady(w, life, POINTS[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(w.clears).toBe(0);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'handoff-ready', checkpointRefusals: 1, failures: 0 });
    expect(life.view(SEAT.tabId)?.checkpointRefused).toContain(reason);
    expect(seatItem(w)?.attrs).toMatchObject({ checkpointRefusals: 1, checkpointRefused: expect.stringContaining(reason) });
    expect(life.holdReason(SEAT.tabId)).toContain(`the rotation stopped before the clear: checkpoint ${TASK}#1`);
    expect(w.rotates).toHaveLength(1);
    // The store recovers: the next pass writes the same attempt and the rotation goes on.
    w.storeFails = {};
    await life.advance(SEAT.tabId);
    expect(w.clears).toBe(1);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'rotating', checkpointRefused: null, checkpointRefusals: 1 });
    expect(latest(w)?.checkpoint.attempt).toBe(1);
  });

  it('a refused checkpoint that never recovers ends at the rotation deadline as one failure, never a clear', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.storeFails = { put: true };
    await handoffReady(w, life, POINTS[0]);
    w.clock.now += ROTATION_DEADLINE_MS;
    await life.advance(SEAT.tabId);
    expect(w.clears).toBe(0);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'watching', failures: 1, rotationTimeouts: 1, checkpointRefused: null });
    expect(life.holdsDigest(SEAT.tabId)).toBe(false);
  });

  it('the git probe failing is a refusal before the clear', async () => {
    const w = world();
    const life = server(w, { gitFacts: async () => { throw new Error('sh: git: not found'); } });
    await request(w, life);
    await handoffReady(w, life, POINTS[0]);
    expect(w.clears).toBe(0);
    expect(life.view(SEAT.tabId)?.checkpointRefused).toBe('the git facts could not be read on ai-server: sh: git: not found');
  });

  it('a seat item (telemetry) that cannot be written never stops the rotation', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.storeFails = { record: true };
    await handoffReady(w, life, POINTS[0]);
    await freshSession(life, w);
    expect(w.clears).toBe(1);
    expect(w.typed).toHaveLength(1);
    expect(latest(w)?.status).toBe('delivered');
  });

  it('the attempt comes from the store: a second rotation is attempt 2, and a lost seat item cannot reuse attempt 1', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[0]);
    await freshSession(life, w);
    w.clock.now += 60 * 60_000;
    life.onContext(SEAT.tabId, 320_000, 'sess-2');
    await life.advance(SEAT.tabId);
    await handoffReady(w, life, POINTS[2]);
    expect(latest(w)).toMatchObject({ status: 'cleared', checkpoint: { attempt: 2, id: `${TASK}#2`, sessionBefore: 'sess-2' } });
    expect(w.store.checkpoints.get('ws-a', `${TASK}#1`)?.status).toBe('delivered');
  });
});

describe('review r1: a checkpoint row belongs to one tab and one live rotation (F1, Q1)', () => {
  const NEW: ISeatTab = { ...SEAT, tabId: 'tab-kit-2' };
  const recreated = (w: IWorld) => server(w, { seat: (tabId) => (tabId === NEW.tabId ? NEW : null), seats: () => [NEW] });

  it('close, then a new tab with the same name: the old row is abandoned and nothing resumes into the new tab', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.crash = 'after-clear';
    await handoffReady(w, life, POINTS[0]);
    expect(latest(w)?.status).toBe('written');
    w.crash = 'none';
    life = server(w);
    life.onClosed(SEAT.tabId, SEAT);
    expect(latest(w)?.status).toBe('abandoned');
    w.session = 'sess-new';
    life = recreated(w);
    life.register(NEW.tabId);
    await life.advance(NEW.tabId);
    await life.tick();
    expect(life.view(NEW.tabId)).toMatchObject({ phase: 'watching', rotations: 0 });
    expect(w.typed).toEqual([]);
    expect(w.placed).toBe(1);
  });

  it('a row left by a tab closed while no server ran is never this tab\'s; the new tab\'s first rotation is the next attempt', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.crash = 'after-clear';
    await handoffReady(w, life, POINTS[0]);
    w.crash = 'none';
    w.session = 'sess-new';
    life = recreated(w);
    life.register(NEW.tabId);
    await life.advance(NEW.tabId);
    expect(life.view(NEW.tabId)?.phase).toBe('watching');
    expect(w.typed).toEqual([]);
    life.onContext(NEW.tabId, 320_000, 'sess-new');
    await life.advance(NEW.tabId);
    w.clock.now += 30_000;
    w.files.set(PATH, handoff(POINTS[2], stampOf(w.clock.now)));
    life.onTurnEnd(NEW.tabId, 'HANDOFF-READY');
    await flush();
    expect(w.clears).toBe(2);
    expect(latest(w)?.checkpoint).toMatchObject({ attempt: 2, tabId: NEW.tabId, sessionBefore: 'sess-new' });
    expect(w.store.checkpoints.get('ws-a', `${TASK}#1`)).toMatchObject({ status: 'written', checkpoint: { tabId: SEAT.tabId } });
  });

  it(`a cleared row older than ${CHECKPOINT_LIVE_MS / 60_000} min (the 30 min deadline + the 10 min first-message wait) is finished, not resumed`, async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.crash = 'after-clear';
    await handoffReady(w, life, POINTS[0]);
    w.crash = 'none';
    w.store.checkpoints.mark('ws-a', `${TASK}#1`, ['written'], 'cleared', w.clock.now);
    w.clock.now += CHECKPOINT_LIVE_MS + 1;
    w.session = 'sess-2';
    life = server(w);
    life.register(SEAT.tabId);
    await life.advance(SEAT.tabId);
    await life.advance(SEAT.tabId);
    expect(latest(w)?.status).toBe('undelivered');
    expect(w.typed).toEqual([]);
    expect(w.clears).toBe(1);
  });

  it('an aged written row with the same session is abandoned, and the seat item resume runs as before', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.crash = 'after-write';
    await handoffReady(w, life, POINTS[0]);
    w.crash = 'none';
    w.clock.now += CHECKPOINT_LIVE_MS + 1;
    life = server(w);
    life.register(SEAT.tabId);
    expect(latest(w)?.status).toBe('abandoned');
    expect(w.clears).toBe(0);
  });

  it('Q1: a checkpoint taken with no bound session cannot show its clear ran: frozen, flagged, never cleared again', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.session = null;
    w.crash = 'after-write';
    await handoffReady(w, life, POINTS[0]);
    expect(latest(w)?.checkpoint.sessionBefore).toBeNull();
    w.crash = 'none';
    life = server(w);
    life.register(SEAT.tabId);
    await life.advance(SEAT.tabId);
    await life.tick();
    expect(latest(w)?.status).toBe('delivery-unknown');
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'watching', handoffUndeliveredAt: w.clock.now });
    expect({ clears: w.clears, typed: w.typed.length }).toEqual({ clears: 0, typed: 0 });
    expect(seatItem(w)?.attrs.handoffUndeliveredAt).toBe(w.clock.now);
  });
});

describe('review pm48 N1: the face names the current stop; the count is one per stopped attempt', () => {
  const STORE_FULL = 'is not durable: SQLITE_FULL';

  /** A store failure stops the rotation, then the store recovers and the checkpoint writes. */
  const storeFailsThenRecovers = async (w: IWorld, life: ContextLifecycle) => {
    await request(w, life);
    w.storeFails = { put: true };
    await handoffReady(w, life, POINTS[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(life.view(SEAT.tabId)).toMatchObject({ checkpointRefusals: 1, refusalCounted: true });
    expect(life.holdReason(SEAT.tabId)).toContain(STORE_FULL);
    w.storeFails = {};
  };

  it('a store failure that recovers, then a busy restart: the busy reason shows, never the old one; counted once', async () => {
    const w = world();
    const life = server(w);
    await storeFailsThenRecovers(w, life);
    w.restartBusy = true;
    await life.advance(SEAT.tabId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(w.clears).toBe(0);
    expect(life.holdReason(SEAT.tabId)).toContain('the restart waits: the seat is mid-turn');
    expect(life.holdReason(SEAT.tabId)).not.toContain('tab-busy');
    expect(life.holdReason(SEAT.tabId)).not.toContain(STORE_FULL);
    expect(seatItem(w)?.attrs.checkpointRefused).toBe('the restart waits: the seat is mid-turn');
    expect(life.view(SEAT.tabId)?.checkpointRefusals).toBe(1);
    w.restartBusy = false;
    await life.advance(SEAT.tabId);
    expect(w.clears).toBe(1);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'rotating', checkpointRefused: null, checkpointRefusals: 1, refusalCounted: false });
    expect(seatItem(w)?.attrs).toMatchObject({ checkpointRefused: null, checkpointRefusals: 1 });
  });

  it('a store failure that recovers, then a host down at the restart: the host reason shows; still one stopped attempt', async () => {
    const w = world();
    const life = server(w);
    await storeFailsThenRecovers(w, life);
    w.restartHostDown = true;
    await life.advance(SEAT.tabId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(life.holdReason(SEAT.tabId)).toContain("the restart waits: the seat's host did not answer");
    expect(life.holdReason(SEAT.tabId)).not.toContain('remote-host-unreachable');
    expect(life.holdReason(SEAT.tabId)).not.toContain(STORE_FULL);
    expect(life.view(SEAT.tabId)?.checkpointRefusals).toBe(1);
  });

  it('the checkpoint writes after a refusal: the face is clear at once, before any later stop', async () => {
    const w = world();
    let afterWrite: string | null | undefined;
    const life: ContextLifecycle = server(w, {
      restart: async () => {
        afterWrite = life.view(SEAT.tabId)?.checkpointRefused;
        w.clears += 1;
        w.session = null;
        return { ok: true };
      },
    });
    await storeFailsThenRecovers(w, life);
    await life.advance(SEAT.tabId);
    expect(afterWrite).toBeNull();
    expect(w.clears).toBe(1);
  });

  it('a counted stop is read back after a server restart, so it is not counted twice', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.storeFails = { put: true };
    await handoffReady(w, life, POINTS[0]);
    expect(seatItem(w)?.attrs).toMatchObject({ checkpointRefusals: 1, checkpointRefusalCounted: true });
    life = server(w);
    life.register(SEAT.tabId);
    expect(life.view(SEAT.tabId)).toMatchObject({ checkpointRefusals: 1, refusalCounted: true });
  });
});

describe('pm49 gap 1: a seat that is only busy shows that, not an earlier cause', () => {
  it('a host that did not answer, then the seat goes busy: the face says it waits for the seat; the count stays one', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.hostDown = true;
    await handoffReady(w, life, POINTS[0]);
    expect(life.view(SEAT.tabId)?.checkpointRefused).toContain('the handoff file could not be read');
    w.hostDown = false;
    w.atPrompt = false;
    await life.advance(SEAT.tabId);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'handoff-ready', checkpointRefused: SEAT_BUSY_FACE, checkpointRefusals: 1 });
    expect(life.holdReason(SEAT.tabId)).not.toContain('did not answer');
    expect(seatItem(w)?.attrs.checkpointRefused).toBe(SEAT_BUSY_FACE);
    const events = w.store.items('ws-a', { type: 'seat' }, w.clock.now).items[0].lastSeq;
    await life.advance(SEAT.tabId);
    expect(w.store.items('ws-a', { type: 'seat' }, w.clock.now).items[0].lastSeq).toBe(events);
    w.atPrompt = true;
    await life.advance(SEAT.tabId);
    expect(w.clears).toBe(1);
    expect(life.view(SEAT.tabId)).toMatchObject({ checkpointRefused: null, checkpointRefusals: 1 });
  });

  it('a seat that is busy with nothing standing writes no face', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.atPrompt = false;
    w.clock.now += 30_000;
    w.files.set(PATH, handoff(POINTS[0], stampOf(w.clock.now)));
    life.onTurnEnd(SEAT.tabId, 'HANDOFF-READY');
    await flush();
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'handoff-ready', checkpointRefused: null });
  });
});

describe('review r1: the restart hop and the gap after the checkpoint (F2, F4, F6)', () => {
  it('F2: host up at the check, down at the restart: a wait, the row stays written, no failed check; then it clears', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.restartHostDown = true;
    await handoffReady(w, life, POINTS[0]);
    // The host stays down until the test lifts it, so the retries the refusal schedules (retryMs, real time) refuse
    // too, however slow the runner: the state below cannot race them (CI run 42455698496).
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(w.restartRefusals).toBeGreaterThanOrEqual(1);
    expect(w.clears).toBe(0);
    expect(latest(w)?.status).toBe('written');
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'handoff-ready', failures: 0, handoffRefusals: 0, checkpointRefusals: 1, pendingMessage: null });
    expect(life.view(SEAT.tabId)?.checkpointRefused).toBe("the restart waits: the seat's host did not answer");
    expect(w.rotates).toHaveLength(1);
    w.restartHostDown = false;
    await life.advance(SEAT.tabId);
    expect(w.clears).toBe(1);
    expect(latest(w)).toMatchObject({ status: 'cleared', checkpoint: { attempt: 1 } });
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'rotating', checkpointRefused: null, checkpointRefusals: 1 });
  });

  it('F2: the restart refusals map to outcomes: busy retries, a host or kit that did not answer waits, others fail', () => {
    expect(restartRefusalOutcome('tab-busy', 'mid-turn')).toEqual({ ok: false, busy: true, error: 'tab-busy: mid-turn', code: 'tab-busy', reason: 'mid-turn' });
    expect(restartRefusalOutcome('remote-host-unreachable', 'x')).toMatchObject({ busy: false, hostUnreachable: true });
    expect(restartRefusalOutcome('remote-kit-broken', 'x')).toMatchObject({ busy: false, hostUnreachable: true });
    expect(restartRefusalOutcome('restart-not-confirmed', 'x')).toEqual({ ok: false, busy: false, error: 'restart-not-confirmed: x', code: 'restart-not-confirmed', reason: 'x' });
  });

  it('pm49 gap 2: a restart wait reaches the face as an operator sentence, an unmapped token as a neutral word and its reason', () => {
    expect(restartWaitFace(restartRefusalOutcome('tab-busy', 'the tab is mid-turn; restart it with --interrupt to abandon the turn')))
      .toBe('the restart waits: the seat is mid-turn');
    expect(restartWaitFace(restartRefusalOutcome('remote-host-unreachable', 'exit 255'))).toBe("the restart waits: the seat's host did not answer");
    expect(restartWaitFace(restartRefusalOutcome('remote-kit-broken', 'x'))).toBe("the restart waits: the purplemux kit does not run on the seat's host");
    expect(restartWaitFace(restartRefusalOutcome('restart-raced', 'another restart ran first'))).toBe('the restart was refused: another restart ran first');
    for (const token of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const face = restartWaitFace(restartRefusalOutcome(token, 'odd answer'));
      expect(face).toBe('the restart was refused: odd answer');
      expect(face).not.toContain(token);
    }
    expect(restartWaitFace({ error: 'spawn failed' })).toBe('the restart was refused: spawn failed');
  });

  it('F4: a remote file over the size cap is the checker\'s size refusal, not a wait', async () => {
    const w = world();
    const life = server(w, { readHandoff: async () => { throw new HandoffRefused('size over 1048576 bytes (expected at most 12288, 12 KB)'); } });
    await request(w, life);
    await handoffReady(w, life, POINTS[0]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flush();
    expect(w.clears).toBe(0);
    expect(life.view(SEAT.tabId)).toMatchObject({ handoffRefusals: 1, checkpointRefused: null });
    expect(w.rotates.at(-1)).toBe(`HANDOFF CHECK FAILED: ${PATH}: size over 1048576 bytes (expected at most 12288, 12 KB). Fix the file, then end your turn with HANDOFF-READY.`);
  });

  it('a stop before the clear that turns into a failed check no longer names the stop', async () => {
    const w = world();
    let readable = false;
    const life = server(w, {
      readHandoff: async (file) => {
        if (!readable) throw new SeatHostUnreachable('remote host ai-server did not answer over ssh (timed out)');
        return w.files.get(file) ?? '';
      },
    });
    await request(w, life);
    await handoffReady(w, life, POINTS[0]);
    expect(life.view(SEAT.tabId)?.checkpointRefused).toContain('could not be read');
    readable = true;
    w.files.set(PATH, 'not a handoff');
    await life.advance(SEAT.tabId);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'rotate-requested', handoffRefusals: 1, checkpointRefusals: 1, checkpointRefused: null });
    expect(life.holdReason(SEAT.tabId)).not.toContain('stopped before the clear');
  });

  it('F6: a turn that starts and ends while the checkpoint is written stops the clear; the stale file is checked again', async () => {
    const w = world();
    let mid = false;
    const life: ContextLifecycle = server(w, {
      gitFacts: async () => {
        if (!mid) {
          mid = true;
          w.clock.now += 2_000;
          life.onPromptSubmit(SEAT.tabId);
          life.onTurnEnd(SEAT.tabId, 'HANDOFF-READY');
        }
        return w.facts;
      },
    });
    await request(w, life);
    await handoffReady(w, life, POINTS[0]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flush();
    expect(w.clears).toBe(0);
    expect(w.rotates.at(-1)).toContain('HANDOFF CHECK FAILED');
    expect(w.rotates.at(-1)).toContain('is older than the rotate request');
  });
});

describe('a remote seat (AC3)', () => {
  it('a host that does not answer at the check is a wait, not a failed check: no message, no alarm count', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    w.hostDown = true;
    await handoffReady(w, life, POINTS[0]);
    expect(w.clears).toBe(0);
    expect(w.rotates).toHaveLength(1);
    expect(life.view(SEAT.tabId)).toMatchObject({ phase: 'handoff-ready', failures: 0, handoffRefusals: 0, pendingMessage: null });
    expect(life.view(SEAT.tabId)?.checkpointRefused).toContain('the handoff file could not be read: remote host ai-server did not answer');
    w.hostDown = false;
    await life.advance(SEAT.tabId);
    expect(w.clears).toBe(1);
  });

  it('a host unreachable at resume: nothing typed, the checkpoint waits on the control host, then it goes when the host is back', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[3]);
    w.hostDown = true;
    await freshSession(life, w);
    await life.advance(SEAT.tabId);
    expect(w.typed).toEqual([]);
    expect(latest(w)?.status).toBe('cleared');
    expect(life.view(SEAT.tabId)?.phase).toBe('rotating');
    w.hostDown = false;
    await life.advance(SEAT.tabId);
    expect(w.typed).toHaveLength(1);
    expect(w.typed[0]).toContain('/deploy-test story-7 --await-ack');
  });

  it('a host still unreachable after the first-message timeout: the row is undelivered and the board flags the seat', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[0]);
    w.hostDown = true;
    await freshSession(life, w);
    w.clock.now += FIRST_MESSAGE_TTL_MS;
    await life.advance(SEAT.tabId);
    expect(w.typed).toEqual([]);
    expect(latest(w)?.status).toBe('undelivered');
    expect(seatItem(w)).toMatchObject({ state: 'watching', attrs: { handoffUndeliveredAt: w.clock.now, firstMessageDropped: true } });
  });
});

describe('resume compares the checkpoint with the worktree (AC4)', () => {
  it('a worktree that moved on gets the differences and a reconcile step before the resume command', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[1]);
    w.facts = { ...FACTS, head: 'c'.repeat(40), dirty: 2 };
    await freshSession(life, w);
    expect(w.typed).toHaveLength(1);
    expect(w.typed[0]).toContain(`Read ${PATH}. RESTORE NOTICE (checkpoint ${TASK}#1): the worktree does not match the checkpoint: head `);
    expect(w.typed[0]).toContain('uncommitted files 0 → 2');
    expect(w.typed[0]).toContain('Reconcile this before you continue');
    expect(w.typed[0].indexOf('Reconcile')).toBeLessThan(w.typed[0].indexOf('then continue: /implement story-7 --await-gate'));
    expect(seatItem(w)?.attrs).toMatchObject({ resumeVerdict: 'mismatch', checkpointMismatch: expect.stringContaining('uncommitted files 0 → 2') });
  });

  it('a handoff file lost on the host is written back from the checkpoint before the first message', async () => {
    const w = world();
    const life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[2]);
    const text = w.files.get(PATH)!;
    w.files.delete(PATH);
    await freshSession(life, w);
    expect(w.files.get(PATH)).toBe(text);
    expect(w.typed[0]).toContain('the server wrote it back from the checkpoint');
  });
});

describe('wait-to-rotate and the counts (AC6)', () => {
  it('measures rotation due to clear, prompt waits included, and counts refusals on the seat item', async () => {
    const w = world();
    const life = server(w);
    w.atPrompt = false;
    await request(w, life);
    expect(w.rotates).toEqual([]);
    w.clock.now += 120_000;
    w.atPrompt = true;
    life.onIdle(SEAT.tabId);
    await life.advance(SEAT.tabId);
    w.files.set(PATH, 'not a handoff');
    life.onTurnEnd(SEAT.tabId, 'HANDOFF-READY');
    await flush();
    expect(life.view(SEAT.tabId)?.handoffRefusals).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handoffReady(w, life, POINTS[0]);
    expect(w.clears).toBe(1);
    expect(seatItem(w)?.attrs).toMatchObject({ handoffRefusals: 1, lastWaitToRotateMs: 150_000, waitToRotateTotalMs: 150_000, waitToRotateCount: 1, rotationDueAt: null });
  });
});

describe('telemetry lost, then a server restart: the checkpoint row decides (review: "can lose the rotation phase")', () => {
  it('the seat item never saw the rotation, the clear ran: the fresh session gets its handoff, not a ROTATE', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    w.storeFails = { record: true };
    w.crash = 'after-clear';
    await handoffReady(w, life, POINTS[0]);
    expect(seatItem(w)?.state).toBe('rotate-requested');
    w.crash = 'none';
    w.storeFails = {};
    w.session = 'sess-2';
    life = server(w);
    life.register(SEAT.tabId);
    await life.advance(SEAT.tabId);
    expect(w.rotates).toHaveLength(1);
    expect(w.typed).toHaveLength(1);
    expect(w.typed[0]).toContain('then continue: /implement story-7 --request-review RESTORE NOTICE');
    expect(seatItem(w)).toMatchObject({ state: 'watching', attrs: { rotations: 1, checkpointId: `${TASK}#1` } });
  });

  it('the seat item never saw the delivery: a delivered row settles the seat without a flag or a second paste', async () => {
    const w = world();
    let life = server(w);
    await request(w, life);
    await handoffReady(w, life, POINTS[2]);
    w.storeFails = { record: true };
    await freshSession(life, w);
    expect(latest(w)?.status).toBe('delivered');
    expect(seatItem(w)?.state).toBe('rotating');
    w.storeFails = {};
    life = server(w);
    life.register(SEAT.tabId);
    await life.advance(SEAT.tabId);
    expect(w.typed).toHaveLength(1);
    expect(seatItem(w)).toMatchObject({ state: 'watching', attrs: { handoffUndeliveredAt: null, checkpointId: `${TASK}#1` } });
  });
});

describe('a due rotation that a /clear made moot (AC6)', () => {
  it('stops counting its wait: the next rotation measures from its own due time', async () => {
    const w = world();
    const life = server(w);
    w.atPrompt = false;
    await request(w, life);
    expect(life.view(SEAT.tabId)?.rotationDueAt).toBe(w.clock.now);
    w.clock.now += 60 * 60_000;
    w.session = 'sess-h';
    life.onSessionStart(SEAT.tabId);
    expect(life.view(SEAT.tabId)?.rotationDueAt).toBeNull();
    w.atPrompt = true;
    life.onContext(SEAT.tabId, 320_000, 'sess-h');
    await life.advance(SEAT.tabId);
    await handoffReady(w, life, POINTS[0]);
    expect(seatItem(w)?.attrs.lastWaitToRotateMs).toBe(30_000);
  });
});

const CRASHES: TCrash[] = ['before-checkpoint', 'after-write', 'after-clear', 'during-delivery', 'after-delivery'];

describe('restart at each workflow point and each crash point (AC7)', () => {
  const cases = POINTS.flatMap((point) => CRASHES.map((crash) => [point.name, crash, point] as const));

  it.each(cases)('%s, server stops %s: the right task resumes, decisions kept, nothing runs twice', async (_name, crash, point) => {
    const w = world();
    w.jobLive = !!point.backgroundJob;
    let life = server(w);
    await request(w, life);
    if (point.backgroundJob) {
      // A live job dies with a restart: nothing is asked or cleared while it runs, across a server restart too.
      expect(w.rotates).toEqual([]);
      life = server(w);
      life.register(SEAT.tabId);
      life.onContext(SEAT.tabId, 330_000, w.session);
      await life.advance(SEAT.tabId);
      expect({ rotates: w.rotates.length, clears: w.clears }).toEqual({ rotates: 0, clears: 0 });
      w.jobLive = false;
      life.onIdle(SEAT.tabId);
      await life.advance(SEAT.tabId);
    }
    expect(w.rotates).toHaveLength(1);

    w.crash = crash === 'before-checkpoint' ? 'none' : crash;
    if (crash === 'before-checkpoint') {
      // HANDOFF-READY recorded, the server stops before the check runs.
      w.clock.now += 30_000;
      w.files.set(PATH, handoff(point, stampOf(w.clock.now)));
      life = server(w, { canRotate: async () => false });
      life.onTurnEnd(SEAT.tabId, 'HANDOFF-READY');
      await flush();
      expect(seatItem(w)?.state).toBe('handoff-ready');
      life = server(w);
      life.register(SEAT.tabId);
      await life.advance(SEAT.tabId);
      // Same session: the seat owes a fresh HANDOFF-READY (ADR-0036 F3); one more ROTATE, within the cap.
      await handoffReady(w, life, point);
      await freshSession(life, w);
    } else {
      await handoffReady(w, life, point);
      if (crash === 'during-delivery' || crash === 'after-delivery') await freshSession(life, w);
      // The server stops; whatever it was doing never finishes. The fresh session (if any) binds meanwhile.
      w.crash = 'none';
      if (crash === 'after-clear') w.session = 'sess-2';
      life = server(w);
      life.register(SEAT.tabId);
      await life.advance(SEAT.tabId);
      if (crash === 'after-write' || crash === 'after-clear') {
        if (crash === 'after-write') await life.advance(SEAT.tabId);
        if (crash === 'after-clear') life.onSessionStart(SEAT.tabId);
        await freshSession(life, w);
      }
      await life.advance(SEAT.tabId);
    }

    const row = latest(w)!;
    expect(w.clears, 'clears').toBe(1);
    expect(w.rotates.length, 'ROTATEs').toBeLessThanOrEqual(2);
    expect(w.typed.length, 'first messages').toBe(1);
    expect(w.typed[0]).toContain(`then continue: ${point.resume}`);
    expect(row.checkpoint).toMatchObject({
      attempt: 1, intendedNextAction: point.resume, outstandingDecisionIds: point.openQuestions,
      inFlight: [expect.objectContaining({ itemKey: 'story-7' })], failedApproaches: [point.doNot.replace(/^- /, '')],
    });
    const expected: TCheckpointStatus = crash === 'during-delivery' ? 'delivery-unknown' : 'delivered';
    expect(row.status).toBe(expected);
    if (crash === 'during-delivery') {
      expect(seatItem(w)?.attrs.handoffUndeliveredAt).toBe(w.clock.now);
    }
    expect(seatItem(w)?.state).toBe('watching');
    expect(seatItem(w)?.attrs.rotations).toBe(1);
    // One more server start changes nothing.
    life = server(w);
    life.register(SEAT.tabId);
    await life.advance(SEAT.tabId);
    await life.tick();
    expect({ clears: w.clears, typed: w.typed.length }).toEqual({ clears: 1, typed: 1 });
  });
});
