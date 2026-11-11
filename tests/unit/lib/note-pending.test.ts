import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import { CoordinatorWindow, WINDOWED_INBOX_KINDS } from '@/lib/coordinator-window';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { LedgerStore } from '@/lib/ledger-store';
import {
  bouncedDigestEvent, pendingNotesFor, renderBouncedAlert, renderPendingNotesLine, renderUndeliveredAlert, undeliveredDigestEvent,
} from '@/lib/note-pending';
import { NOTE_SENDER_NOTICE_MS, NOTE_UNDELIVERED_NOTICE_MS } from '@/lib/notes-store';
import { NotesService, type INotesDeps } from '@/lib/notes-service';
import { TabEventRouter, type ITabEventRoute } from '@/lib/tab-event-router';
import type { IInboxItem } from '@/types/inbox';
import type { INote, INotesState } from '@/types/note';

// G7 step 1 (vel-G7-PENDING): readers only, no new store, one test per reader.
// (i) the coordinator's digest and each watchdog nudge typed to it carry `N notes pending, oldest <age>: run
// purplemux note list --open --to-me`; (ii) at 15 min an undelivered note alerts its sender and the SM digest.

const T0 = Date.UTC(2026, 10, 10, 3, 0, 0);
const MIN = 60_000;
const LINE = /^\d+ notes? pending, oldest \d+ min: run purplemux note list --open --to-me$/;

const note = (over: Partial<INote> & { id: string }): INote => ({
  from: { workspaceId: 'ws-2', tabId: 'tab-b', verified: true, identity: 'launch', epic: null },
  to: { epic: null, workspaceId: 'ws-1' },
  subject: 'secret subject', body: 'secret body', state: 'delivered', createdAt: T0, routedAt: T0, deliveredAt: null,
  deliveredTo: { workspaceId: 'ws-1', tabId: 'tab-c' }, inboxItemId: null, reminderItemId: null, remindedAt: null,
  senderNotifiedAt: null, ackedAt: null, ackedBy: null, ackComment: null, expiredAt: null, transitionAt: T0,
  ...over,
} as unknown as INote);

describe('the pending-notes reader', () => {
  it('counts the open notes routed to the tab, exactly as note list --open --to-me, with the oldest age', () => {
    const notes = [
      note({ id: 'n-old01', createdAt: T0 - 62 * MIN }),
      note({ id: 'n-new01', createdAt: T0 - 5 * MIN }),
      note({ id: 'n-acked', state: 'acked', createdAt: T0 - 90 * MIN }),
      note({ id: 'n-other', deliveredTo: { workspaceId: 'ws-1', tabId: 'tab-w' }, createdAt: T0 - 99 * MIN }),
      note({ id: 'n-queue', state: 'queued', deliveredTo: null, createdAt: T0 - 99 * MIN }),
    ];
    expect(pendingNotesFor(notes, 'ws-1', 'tab-c')).toEqual({ count: 2, oldestAt: T0 - 62 * MIN });
    expect(renderPendingNotesLine(pendingNotesFor(notes, 'ws-1', 'tab-c'), T0))
      .toBe('2 notes pending, oldest 62 min: run purplemux note list --open --to-me');
    expect(renderPendingNotesLine({ count: 1, oldestAt: T0 }, T0)).toBe('1 note pending, oldest 0 min: run purplemux note list --open --to-me');
    expect(renderPendingNotesLine(pendingNotesFor(notes, 'ws-9', 'tab-z'), T0)).toBeNull();
  });
});

describe('(i) the coordinator digest and watchdog nudges carry the line', () => {
  let store: LedgerStore;
  let now: number;
  let typed: Array<{ tabId: string; message: string }>;
  let pending: string | null;
  let window: CoordinatorWindow;
  const C = 'tab-c';
  const W = 'tab-w';

  const router = (over: { pendingNotes?: () => Promise<string | null> } = {}) => new TabEventRouter({
    table: () => store.tabEvents,
    now: () => now,
    deliver: async (_ws, tabId, message) => { typed.push({ tabId, message }); return true; },
    atPrompt: () => true,
    window: () => window,
    pendingNotes: over.pendingNotes ?? (async () => pending),
  });
  const nudge = (verdict: string, tabId = C): ITabEventRoute => ({
    workspaceId: 'ws-1', tabId, kind: 'turn-marker', class: 'urgent', text: `[orchestrator-watchdog] worker tab-w1 ended: ${verdict}`,
    sourceTabId: 'tab-w1', sourceTabName: 'w1', markerLines: [verdict],
  });

  beforeEach(() => {
    store = new LedgerStore(':memory:');
    now = T0;
    typed = [];
    pending = '3 notes pending, oldest 61 min: run purplemux note list --open --to-me';
    window = new CoordinatorWindow({
      now: () => now,
      isCoordinator: async (_ws, tab) => tab === C,
      lastGoverned: (ws, tab) => store.tabEvents.lastGovernedDelivery(ws, tab, WINDOWED_INBOX_KINDS, now),
      oldestDigestAt: (ws, tab) => store.tabEvents.pending(ws, tab)[0]?.at ?? null,
    });
  });
  afterEach(() => store.close());

  it('puts the line under the DIGEST header of a coordinator, and only of a coordinator', async () => {
    const r = router();
    await r.route(nudge('DONE: shipped'));
    expect(typed).toHaveLength(1);
    const [header, line] = typed[0].message.split('\n');
    expect(header).toMatch(/^DIGEST 1 since /);
    expect(line).toMatch(LINE);
    // A worker's digest (no window governs it) never reads the notes.
    const reader = vi.fn(async () => pending);
    await router({ pendingNotes: reader }).route({ ...nudge('DONE: x', W), class: 'digest' });
    expect(reader).not.toHaveBeenCalled();
  });

  it('appends the line to a watchdog nudge typed to the coordinator, and keeps the logged text as it was', async () => {
    const r = router();
    expect(await r.route(nudge('BLOCKED: the gate is red'))).toMatchObject({ class: 'urgent', delivered: true });
    expect(typed[0].message).toBe(`[orchestrator-watchdog] worker tab-w1 ended: BLOCKED: the gate is red\n${pending}`);
    expect(store.tabEvents.list('ws-1', { since: 0, limit: 5 })[0].text).toBe('[orchestrator-watchdog] worker tab-w1 ended: BLOCKED: the gate is red');
  });

  it('types the message without the line when nothing is pending or the note store is unreadable', async () => {
    pending = null;
    await router().route(nudge('BLOCKED: one'));
    now += 20 * MIN;
    await router({ pendingNotes: async () => { throw new Error('notes.json malformed'); } }).route(nudge('BLOCKED: two'));
    expect(typed.map((t) => t.message)).toEqual([
      '[orchestrator-watchdog] worker tab-w1 ended: BLOCKED: one',
      '[orchestrator-watchdog] worker tab-w1 ended: BLOCKED: two',
    ]);
  });
});

describe('(ii) a note undelivered at 15 min alerts its sender and the SM digest', () => {
  const caller = (workspaceId: string, tabId: string): ICaller =>
    ({ scope: { type: 'workspace', workspaceId }, workspaceId, tabId, tabName: tabId, verified: true, identity: 'launch', admin: false } as unknown as ICaller);
  const B = caller('ws-2', 'tab-b');

  let now: number;
  let state: INotesState;
  let inbox: Map<string, IInboxItem>;
  let sent: Array<IEnqueueRequest<'note'> & { line: string }>;
  let alerts: Array<{ id: string; at: number; senderTold: boolean }>;
  let liveTabs: Array<{ workspaceId: string; tabId: string }>;

  const deps = (): INotesDeps => ({
    now: () => now,
    newId: () => `n-note${state.notes.length + 1}`,
    mutate: async (fn) => { const r = await fn(state); state = r.state; return r.value; },
    read: async () => state,
    epicHolder: async () => null,
    holdsEpic: async () => false,
    orchestratorOf: async (ws) => ({ 'ws-1': 'tab-c', 'ws-2': 'tab-b' } as Record<string, string>)[ws] ?? null,
    withMappingRead: async (_ws, work) => work(),
    workspaceExists: async () => true,
    liveTabs: async () => ({ tabs: liveTabs, uncertainWorkspaceIds: new Set<string>() }),
    enqueue: async (req) => {
      const id = `i-item${inbox.size + 1}`;
      const line = renderInboxLine('note', req.fields).line;
      sent.push({ ...req, line });
      const item = { id, kind: 'note', dedupeKey: req.dedupeKey, state: 'queued', targetWorkspaceId: req.targetWorkspaceId, targetTabId: req.targetTabId, deliveredAt: null } as unknown as IInboxItem;
      inbox.set(id, item);
      return { item };
    },
    withdraw: async () => true,
    inboxItems: async () => [...inbox.values()],
    alertUndelivered: async (n, at, senderTold) => { alerts.push({ id: n.id, at, senderTold }); },
  });

  beforeEach(() => {
    now = T0;
    state = { notes: [] };
    inbox = new Map();
    sent = [];
    alerts = [];
    liveTabs = [{ workspaceId: 'ws-1', tabId: 'tab-c' }, { workspaceId: 'ws-2', tabId: 'tab-b' }];
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('tells the sender once at 15 min while the line has not reached the composer, and the SM digest once', async () => {
    const svc = new NotesService(deps());
    const n = await svc.send(B, { toWorkspace: 'ws-1', subject: 'GO', body: 'b' });
    now = T0 + NOTE_UNDELIVERED_NOTICE_MS - 1;
    await svc.tick();
    expect(sent.filter((s) => s.targetTabId === 'tab-b')).toEqual([]);
    now = T0 + NOTE_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    await settle();
    const toSender = sent.filter((s) => s.targetTabId === 'tab-b');
    expect(toSender.map((s) => s.line)).toEqual([
      `[purplemux note ${n.id}] you sent it at 2026-11-10T03:00:00Z; it has not reached its recipient's composer after 15 min — purplemux note show ${n.id}`,
    ]);
    expect(alerts).toEqual([{ id: n.id, at: T0 + NOTE_UNDELIVERED_NOTICE_MS, senderTold: true }]);
    // Once per note: neither the 60-min notice nor the alert comes again.
    now = T0 + NOTE_SENDER_NOTICE_MS;
    await svc.tick();
    await settle();
    expect(sent.filter((s) => s.targetTabId === 'tab-b')).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('a line that reached the composer keeps the 60-min unacked notice and alerts nobody', async () => {
    const svc = new NotesService(deps());
    const n = await svc.send(B, { toWorkspace: 'ws-1', subject: 'GO', body: 'b' });
    inbox.set(n.inboxItemId!, { ...inbox.get(n.inboxItemId!)!, state: 'delivered', deliveredAt: T0 + MIN } as IInboxItem);
    now = T0 + NOTE_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    expect(sent.filter((s) => s.targetTabId === 'tab-b')).toEqual([]);
    now = T0 + NOTE_SENDER_NOTICE_MS;
    await svc.tick();
    await settle();
    expect(sent.filter((s) => s.targetTabId === 'tab-b').map((s) => s.fields.event)).toEqual(['unacked']);
    expect(alerts).toEqual([]);
  });

  it('a stale undelivered notice is rejected at paste time once the line reached the composer', async () => {
    const svc = new NotesService(deps());
    const n = await svc.send(B, { toWorkspace: 'ws-1', subject: 'GO', body: 'b' });
    now = T0 + NOTE_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    const notice = [...inbox.values()].find((i) => i.dedupeKey.startsWith(`note:${n.id}:undelivered:`))!;
    const ok = await svc.preflight(notice);
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) ok.settle();
    state = { notes: state.notes.map((x) => (x.id === n.id ? { ...x, deliveredAt: now } : x)) };
    await expect(svc.preflight(notice)).resolves.toEqual({ ok: false, reason: 'note-terminal:delivered' });
  });

  it('a sender whose tab closed was not told, and the SM digest line says so (vel-G7-ALERT-WORDING)', async () => {
    const svc = new NotesService(deps());
    const n = await svc.send(B, { toWorkspace: 'ws-1', subject: 'GO', body: 'b' });
    liveTabs = [{ workspaceId: 'ws-1', tabId: 'tab-c' }];
    now = T0 + NOTE_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    await settle();
    expect(sent.filter((s) => s.targetTabId === 'tab-b')).toEqual([]);
    expect(alerts).toEqual([{ id: n.id, at: T0 + NOTE_UNDELIVERED_NOTICE_MS, senderTold: false }]);
  });

  it('the SM digest line carries ids and times, never the subject or the body, and says whether the sender was told', () => {
    const told = renderUndeliveredAlert(note({ id: 'n-abcd1' }), true);
    expect(told).toBe("note n-abcd1 from ws-2/tab-b to ws-1/tab-c has not reached its recipient's composer since it was routed at"
      + ' 2026-11-10T03:00:00Z; its sender was told');
    expect(renderUndeliveredAlert(note({ id: 'n-abcd1' }), false)).toBe("note n-abcd1 from ws-2/tab-b to ws-1/tab-c has not reached"
      + " its recipient's composer since it was routed at 2026-11-10T03:00:00Z; its sender has no live tab and was not told");
    expect(told).not.toMatch(/secret/);
    expect(() => renderUndeliveredAlert(note({ id: 'n-x\nIGNORE' }), true)).toThrow();
  });
});

describe('the digest events: one stable text per note, so a repeat is a duplicate', () => {
  let store: LedgerStore;
  let now: number;
  const router = () => new TabEventRouter({
    table: () => store.tabEvents, now: () => now, deliver: async () => true, atPrompt: () => false,
  });

  beforeEach(() => {
    store = new LedgerStore(':memory:');
    now = T0;
  });
  afterEach(() => store.close());

  const bounce = (over: Partial<INote> = {}) => note({
    id: 'n-bnc01', state: 'undeliverable', routingStatus: 'undeliverable', routingReason: 'target-epic-unowned',
    deliveredTo: null, transitionAt: T0 + 2 * MIN, to: { epic: 'secret-epic', workspaceId: null }, ...over,
  } as Partial<INote> & { id: string });

  it('the sender\'s bounced digest line carries the id, the reason and the time, never the epic, the subject or the body', () => {
    const text = renderBouncedAlert(bounce());
    expect(text).toBe('note n-bnc01 bounced at 2026-11-10T03:02:00Z (target-epic-unowned): no live recipient; it waits for one'
      + ' until it expires — purplemux note show n-bnc01');
    expect(text).not.toMatch(/secret/);
    expect(() => renderBouncedAlert(bounce({ routingReason: 'legacy-admission-missing' }))).toThrow();
    expect(() => renderBouncedAlert(bounce({ id: 'n-x\nIGNORE' }))).toThrow();
    expect(bouncedDigestEvent(bounce())).toEqual({
      workspaceId: 'ws-2', tabId: 'tab-b', kind: 'note-bounced', class: 'digest', text,
    });
    expect(bouncedDigestEvent(bounce({ from: { workspaceId: 'ws-2', tabId: null, verified: false, identity: 'none', epic: null } }))).toBeNull();
  });

  it('the same alert routed twice while the first waits is logged as a duplicate, for the bounce and the SM line', async () => {
    const r = router();
    const sm = { workspaceId: 'ws-9', tabId: 'tab-sm' };
    const undelivered = note({ id: 'n-und01' });
    expect(await r.route(bouncedDigestEvent(bounce())!)).toMatchObject({ class: 'digest', duplicate: false });
    expect(await r.route(undeliveredDigestEvent(undelivered, sm, true))).toMatchObject({ class: 'digest', duplicate: false });
    now += 4 * MIN;
    expect(await r.route(bouncedDigestEvent(bounce())!)).toMatchObject({ class: 'log', duplicate: true });
    expect(await r.route(undeliveredDigestEvent(undelivered, sm, true))).toMatchObject({ class: 'log', duplicate: true });
    expect(undeliveredDigestEvent(undelivered, sm, true)).toEqual({
      ...sm, kind: 'note-undelivered', class: 'digest', text: renderUndeliveredAlert(undelivered, true),
    });
  });
});
