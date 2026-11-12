import { beforeEach, describe, expect, it } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { OWNER_POINTER_SPACING_MS, type INotePointPort, type INotePointTarget, type TPointerTyped } from '@/lib/note-pointer';
import { NoteError, OWNER_ITEM_UNDELIVERED_NOTICE_MS, NOTE_UNDELIVERED_NOTICE_MS } from '@/lib/notes-store';
import { NotesService, type INotesDeps } from '@/lib/notes-service';
import type { IInboxItem } from '@/types/inbox';
import type { INote, INotesState } from '@/types/note';

// PMUX-NOTE-DELIVERY change 1: an owner item, flagged by the verified current orchestrator of its sender's workspace,
// is pointed at in its recipient orchestrator at once, busy included, until its line is in that composer.

const T0 = Date.parse('2026-11-12T04:00:00.000Z');
const MIN = 60_000;

const caller = (workspaceId: string, tabId: string, verified = true): ICaller =>
  ({ scope: { type: 'workspace', workspaceId }, workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'hook', admin: false } as unknown as ICaller);
const ADMIN = { scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true } as unknown as ICaller;

const A = caller('ws-1', 'tab-a'); // the recipient orchestrator
const B = caller('ws-2', 'tab-b'); // a sending orchestrator
const C = caller('ws-3', 'tab-c'); // another sending orchestrator
const W = caller('ws-2', 'tab-worker'); // a worker beside B
const O = caller('ws-4', 'tab-o'); // an owner-granted tab that is not its workspace's orchestrator

class Fakes {
  now = T0;
  state: INotesState = { notes: [] };
  live = new Set(['ws-1/tab-a', 'ws-1/tab-a2', 'ws-2/tab-b', 'ws-2/tab-worker', 'ws-3/tab-c', 'ws-4/tab-o', 'ws-4/tab-orch4']);
  orchestrators = new Map<string, string>([['ws-1', 'tab-a'], ['ws-2', 'tab-b'], ['ws-3', 'tab-c'], ['ws-4', 'tab-orch4']]);
  epics = new Map<string, { workspaceId: string; tabId: string }>();
  inbox = new Map<string, IInboxItem>();
  withdrawn: Array<{ id: string; reason: string }> = [];
  audits: Array<Record<string, unknown>> = [];
  claims: string[] = [];
  spent: Array<{ id: string; outcome: string }> = [];
  acks: INote[] = [];
  port: INotePointPort | undefined;
  private seq = 0;

  deps(): INotesDeps {
    return {
      now: () => this.now,
      newId: () => `n-note${++this.seq}`,
      mutate: async (fn) => {
        const { state, value } = await fn(this.state);
        this.state = state;
        return value;
      },
      read: async () => this.state,
      epicHolder: async (slug) => this.epics.get(slug) ?? null,
      holdsEpic: async () => false,
      orchestratorOf: async (ws) => this.orchestrators.get(ws) ?? null,
      withMappingRead: async (_ws, work) => work(),
      workspaceExists: async (ws) => ['ws-1', 'ws-2', 'ws-3', 'ws-4'].includes(ws),
      liveTabs: async () => ({
        tabs: [...this.live].map((k) => ({ workspaceId: k.split('/')[0], tabId: k.split('/')[1] })),
        uncertainWorkspaceIds: new Set<string>(),
      }),
      enqueue: async (req: IEnqueueRequest<'note'>) => {
        const existing = [...this.inbox.values()].find((i) => i.dedupeKey === req.dedupeKey && i.state === 'queued');
        if (existing) return { item: existing };
        const id = `i-item${this.inbox.size + 1}`;
        const item = { id, kind: 'note', dedupeKey: req.dedupeKey, state: 'queued', targetWorkspaceId: req.targetWorkspaceId,
          targetTabId: req.targetTabId, line: renderInboxLine('note', req.fields).line, createdAt: this.now, deliveredAt: null,
          lastRefusal: null, heldReason: null, expiresAt: this.now + 24 * 60 * MIN } as unknown as IInboxItem;
        this.inbox.set(id, item);
        return { item };
      },
      withdraw: async (id, reason) => {
        const item = this.inbox.get(id);
        if (!item || (item.state !== 'queued' && item.state !== 'held')) return false;
        this.inbox.set(id, { ...item, state: 'dropped' } as IInboxItem);
        this.withdrawn.push({ id, reason });
        return true;
      },
      inboxItems: async () => [...this.inbox.values()],
      ownerGrantOf: (tab) => (tab.workspaceId === 'ws-4' && tab.tabId === 'tab-o' ? { id: 'g-owner1', capability: 'owner' } as never : null),
      audit: async (entry) => { this.audits.push(entry); },
      window: () => ({ claim: (ws: string, tab: string) => { this.claims.push(`${ws}/${tab}`); } }) as never,
      pointPort: this.port ? async () => this.port! : undefined,
      alertPointerSpent: async (note, outcome) => { this.spent.push({ id: note.id, outcome }); },
      recordAck: async (note) => { this.acks.push(note); },
    };
  }

  note(id: string) {
    return this.state.notes.find((n) => n.id === id)!;
  }

  setItem(id: string, over: Partial<IInboxItem>) {
    this.inbox.set(id, { ...this.inbox.get(id)!, ...over } as IInboxItem);
  }
}

/** A target that answers `refusal` and the next typing outcome, and records each line typed. */
class FakePort implements INotePointPort {
  typed: Array<{ tab: string; line: string }> = [];
  refusal: Awaited<ReturnType<INotePointTarget['refusal']>> = null;
  outcome: TPointerTyped = 'submitted';

  async withTarget<T>(workspaceId: string, tabId: string, work: (target: INotePointTarget) => Promise<T>): Promise<T | null> {
    return work({
      refusal: async () => this.refusal,
      type: async (line) => {
        this.typed.push({ tab: `${workspaceId}/${tabId}`, line });
        return { outcome: this.outcome, cliState: 'busy' };
      },
    });
  }
}

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toBeInstanceOf(NoteError);
  await expect(promise).rejects.toMatchObject({ code });
};

/** Let the send's not-awaited pointer run finish. */
const settle = async (svc: NotesService) => { await svc.pointOwnerItems(); };

describe('owner item: who may set it', () => {
  let f: Fakes;
  let svc: NotesService;

  beforeEach(() => {
    f = new Fakes();
    svc = new NotesService(f.deps());
  });

  it.each([
    ['a worker', W],
    ['an unverified tab', caller('ws-2', 'tab-b', false)],
    ['the admin token', ADMIN],
    ['an owner-granted tab that is not its orchestrator', O],
  ])('refuses %s with forbidden, stores nothing and writes one audit line', async (_name, from) => {
    await expectCode(svc.send(from, { toWorkspace: 'ws-1', subject: 's', body: 'b', ownerItem: true }), 'forbidden');
    expect(f.state.notes).toEqual([]);
    expect(f.inbox.size).toBe(0);
    expect(f.audits).toEqual([expect.objectContaining({ event: 'owner-item-refused' })]);
  });

  it('refuses a human send and a server-local send', async () => {
    await expectCode(svc.sendHuman('person', 'ws-1', { subject: 's', body: 'b', ownerItem: true }), 'forbidden');
    await expectCode(svc.sendSystemLocal('ws-1', { subject: 's', body: 'b', ownerItem: true }), 'forbidden');
    expect(f.state.notes).toEqual([]);
  });

  it.each([['the string "true"', 'true'], ['1', 1], ['false', false], ['null', null]])('refuses %s as the flag (note-invalid)', async (_name, value) => {
    await expectCode(svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b', ownerItem: value }), 'note-invalid');
  });

  it('a handover before the send refuses the old orchestrator', async () => {
    f.orchestrators.set('ws-2', 'tab-worker');
    await expectCode(svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b', ownerItem: true }), 'forbidden');
  });

  it('the verified orchestrator sets it: stored, routed, answered armed or inactive', async () => {
    const sent = await svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b', ownerItem: true });
    expect(sent).toMatchObject({ ownerItem: true, ownerPointer: 'armed', deliveredTo: { workspaceId: 'ws-1', tabId: 'tab-a' } });
    const local = await svc.send(B, { toWorkspace: 'ws-2', subject: 's', body: 'b', ownerItem: true });
    expect(local.ownerPointer).toBe('inactive:same-workspace');
    f.orchestrators.delete('ws-3');
    const bounced = await svc.send(B, { toWorkspace: 'ws-3', subject: 's', body: 'b', ownerItem: true });
    expect(bounced.ownerPointer).toBe('inactive:target-coordinator-unavailable');
    const plain = await svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b' });
    expect(plain.ownerItem).toBeUndefined();
    expect(plain).not.toHaveProperty('ownerPointer');
  });

  it('bounced owner items arm nothing and do not count toward the cap', async () => {
    f.orchestrators.delete('ws-3');
    for (let i = 0; i < 5; i += 1) {
      expect((await svc.send(B, { toWorkspace: 'ws-3', subject: `b${i}`, body: 'b', ownerItem: true })).ownerPointer)
        .toBe('inactive:target-coordinator-unavailable');
    }
    await expect(svc.send(B, { toWorkspace: 'ws-1', subject: 'routed', body: 'b', ownerItem: true })).resolves.toMatchObject({ ownerPointer: 'armed' });
  });

  it('caps a sender at 5 armed owner items; one that reached a composer frees its slot', async () => {
    const sent = [];
    for (let i = 0; i < 5; i += 1) sent.push(await svc.send(B, { toWorkspace: 'ws-1', subject: `s${i}`, body: 'b', ownerItem: true }));
    const sixth = svc.send(B, { toWorkspace: 'ws-1', subject: 's6', body: 'b', ownerItem: true });
    await expectCode(sixth, 'note-cap');
    await expect(sixth).rejects.toThrow(/owner-item-cap/);
    // Another orchestrator has its own 5; an ordinary note is not capped by owner items.
    await expect(svc.send(C, { toWorkspace: 'ws-1', subject: 'c', body: 'b', ownerItem: true })).resolves.toMatchObject({ ownerItem: true });
    await expect(svc.send(B, { toWorkspace: 'ws-1', subject: 'plain', body: 'b' })).resolves.toBeTruthy();
    // Read but never acked: the line reached a composer, so the slot is free.
    f.setItem(sent[0].inboxItemId!, { state: 'delivered', deliveredAt: f.now });
    await svc.tick();
    await expect(svc.send(B, { toWorkspace: 'ws-1', subject: 's7', body: 'b', ownerItem: true })).resolves.toMatchObject({ ownerItem: true });
  });
});

describe('owner item: the pointer', () => {
  let f: Fakes;
  let svc: NotesService;
  let port: FakePort;

  beforeEach(() => {
    f = new Fakes();
    port = new FakePort();
    f.port = port;
    svc = new NotesService(f.deps());
  });

  const owner = async (from: ICaller = B, toWorkspace = 'ws-1') => {
    const note = await svc.send(from, { toWorkspace, subject: 'GO on F12', body: 'owner says go', ownerItem: true });
    await settle(svc);
    return note;
  };

  it('types one sender-flagged line into the busy recipient at send, then never again', async () => {
    const note = await owner();
    expect(port.typed).toEqual([{ tab: 'ws-1/tab-a',
      line: `[purplemux note ${note.id}] from ws-2/tab-b at 2026-11-12T04:00:00Z, flagged owner item, needs action now: `
        + `run purplemux note show ${note.id} now, then purplemux note ack ${note.id}` }]);
    expect(port.typed[0].line).not.toMatch(/GO on F12|owner says go|owner decision/);
    expect(f.note(note.id)).toMatchObject({ deliveredAt: T0, pointer: { route: 'ws-1/tab-a', outcome: 'submitted', by: 'owner-item' } });
    expect(f.withdrawn).toEqual([{ id: note.inboxItemId, reason: 'note-pointed' }]);
    // No window claim: the owner line neither waits for the coordinator window nor delays a due digest.
    expect(f.claims).toEqual([]);
    f.now += 10 * MIN;
    await svc.tick();
    expect(port.typed).toHaveLength(1);
    expect(f.audits.filter((a) => a.event === 'note-pointer')).toEqual([expect.objectContaining({ by: 'owner-item', result: 'submitted' })]);
  });

  it('two owner items to one target: oldest first, the second only after the 60 s spacing, from any sender', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'composer-not-empty' };
    const first = await owner(B);
    f.now += 1000;
    const second = await owner(C);
    expect(port.typed).toEqual([]);
    port.refusal = null;
    await svc.tick();
    expect(port.typed.map((t) => t.line.includes(first.id))).toEqual([true]);
    f.now += OWNER_POINTER_SPACING_MS - 1;
    await svc.tick();
    expect(port.typed).toHaveLength(1);
    f.now += 1;
    await svc.tick();
    expect(port.typed.map((t) => t.line.includes(second.id))).toEqual([false, true]);
  });

  it('a manual note point at the target counts toward the spacing', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'native-prompt-active' };
    const flagged = await owner(C);
    const ordinary = await svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b' });
    port.refusal = null;
    await svc.point(B, ordinary.id, port);
    await svc.tick();
    expect(port.typed).toHaveLength(1);
    f.now += OWNER_POINTER_SPACING_MS;
    await svc.tick();
    expect(port.typed.map((t) => t.line.includes(flagged.id))).toEqual([false, true]);
  });

  it('manual and automatic pointers at one note type one line (the shared stamp)', async () => {
    port.outcome = 'stranded';
    const note = await owner();
    f.now += 20 * MIN;
    await expectCode(svc.point(B, note.id, port), 'note-point-spent');
    await svc.tick();
    expect(port.typed).toHaveLength(1);
  });

  it('a target that is never ready: nothing typed, one audit line per reason change, the sender hears at 5 min', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'native-prompt-active' };
    const note = await owner();
    for (let i = 0; i < 4; i += 1) {
      f.now += 15_000;
      await svc.tick();
    }
    port.refusal = { code: 'note-point-not-ready', reason: 'composer-not-empty' };
    f.now += 15_000;
    await svc.tick();
    expect(port.typed).toEqual([]);
    expect(f.audits.filter((a) => a.event === 'note-pointer').map((a) => a.detail)).toEqual(['native-prompt-active', 'composer-not-empty']);
    f.now = T0 + OWNER_ITEM_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    const undelivered = [...f.inbox.values()].find((i) => i.dedupeKey === `note:${note.id}:undelivered:tab-b`);
    expect(undelivered?.line).toBe(`[purplemux note ${note.id}] you sent it at 2026-11-12T04:00:00Z; it has not reached its`
      + ` recipient's composer after 5 min — purplemux note show ${note.id}`);
  });

  it.each(['stranded', 'unverified'] as const)('a %s line is spent: never typed again, the notice kept, the sender alerted, the next note goes', async (outcome) => {
    port.outcome = outcome;
    const first = await owner(B);
    expect(f.note(first.id).deliveredAt).toBeNull();
    expect(f.note(first.id).pointer).toMatchObject({ outcome });
    expect(f.withdrawn).toEqual([]);
    await Promise.resolve();
    expect(f.spent).toEqual([{ id: first.id, outcome }]);
    port.outcome = 'submitted';
    f.now += 1000;
    const second = await owner(C);
    f.now += OWNER_POINTER_SPACING_MS;
    await svc.tick();
    expect(port.typed.map((t) => (t.line.includes(first.id) ? 'first' : t.line.includes(second.id) ? 'second' : '?'))).toEqual(['first', 'second']);
  });

  it('a composer that was not clean: no Enter, the note stays armed with its reason, and is pointed again later', async () => {
    port.outcome = 'not-clean';
    const note = await owner();
    expect(f.note(note.id)).toMatchObject({ deliveredAt: null, pointer: null });
    expect(f.withdrawn).toEqual([]);
    expect(f.spent).toEqual([]);
    expect(svc.ownerItemReason(note.id)).toBe('composer-not-clean');
    expect(f.audits.filter((a) => a.event === 'note-pointer')).toEqual([
      expect.objectContaining({ result: 'not-clean', detail: 'composer-not-clean' })]);
    // Text was typed, so the 60 s spacing holds; then the composer is clean again and the line goes once.
    port.outcome = 'submitted';
    await svc.tick();
    expect(port.typed).toHaveLength(1);
    f.now += OWNER_POINTER_SPACING_MS;
    await svc.tick();
    expect(port.typed).toHaveLength(2);
    expect(f.note(note.id).pointer).toMatchObject({ outcome: 'submitted' });
    expect(svc.ownerItemReason(note.id)).toBeNull();
  });

  it('one refused note at the head of a target does not block the later owner items for that tab', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'composer-not-empty' };
    const head = await owner(B);
    f.now += 1000;
    const next = await owner(C);
    port.refusal = null;
    // The head note's line is refused for itself: its stored sender tab fails the line grammar.
    f.state = { notes: f.state.notes.map((n) => (n.id === head.id ? { ...n, from: { ...n.from, tabId: 'tab bad;id' } } : n)) };
    await svc.tick();
    expect(port.typed.map((t) => t.line.includes(next.id))).toEqual([true]);
    expect(svc.ownerItemReason(head.id)).toMatch(/^line-refused:/);
    expect(f.note(head.id)).toMatchObject({ state: 'delivered', deliveredAt: null });
    expect(f.note(head.id).pointer ?? null).toBeNull();
    // A refusal of the target itself ends the target's turn: the next note would meet the same tab.
    const third = await owner(B);
    port.refusal = { code: 'note-point-not-ready', reason: 'native-prompt-active' };
    f.now += OWNER_POINTER_SPACING_MS;
    const attempts: string[] = [];
    class CountingPort extends FakePort {
      override async withTarget<T>(ws: string, tab: string, work: (target: INotePointTarget) => Promise<T>): Promise<T | null> {
        attempts.push(`${ws}/${tab}`);
        return super.withTarget(ws, tab, work);
      }
    }
    const counting = new CountingPort();
    counting.refusal = port.refusal;
    f.port = counting;
    await new NotesService(f.deps()).tick();
    expect(attempts).toHaveLength(2); // the head is disarmed for itself, then `third` meets the refusing tab: stop
    expect(f.note(third.id).deliveredAt).toBeNull();
  });

  it('a restart does not retype: the stamp is persisted before the typing', async () => {
    port.outcome = 'unverified';
    const note = await owner();
    const restarted = new NotesService(f.deps());
    f.now += 10 * MIN;
    await restarted.tick();
    expect(port.typed).toHaveLength(1);
    expect(f.note(note.id).pointer?.route).toBe('ws-1/tab-a');
  });

  it('a crash mid-typing leaves the typing stamp: after a restart nothing is typed again', async () => {
    const crashing = new FakePort();
    crashing.withTarget = async (ws, tab, work) => work({
      refusal: async () => null,
      type: async (line) => {
        crashing.typed.push({ tab: `${ws}/${tab}`, line });
        throw new Error('server killed mid-paste');
      },
    });
    f.port = crashing;
    const svc2 = new NotesService(f.deps());
    const note = await svc2.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b', ownerItem: true });
    await settle(svc2);
    expect(f.note(note.id).pointer).toMatchObject({ route: 'ws-1/tab-a', outcome: 'typing', by: 'owner-item' });
    f.port = port;
    f.now += 10 * MIN;
    await new NotesService(f.deps()).tick();
    expect(crashing.typed).toHaveLength(1);
    expect(port.typed).toEqual([]);
  });

  it('types nothing when the inbox notice was already typed (delivered, held stranded or transport-uncertain)', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'composer-not-empty' };
    const delivered = await owner();
    const stranded = await owner(C);
    const uncertain = await owner(C);
    port.refusal = null;
    f.setItem(delivered.inboxItemId!, { state: 'delivered', deliveredAt: f.now });
    f.setItem(stranded.inboxItemId!, { state: 'held', heldReason: 'stranded-in-composer' });
    f.setItem(uncertain.inboxItemId!, { state: 'held', heldReason: 'transport-uncertain:EPIPE' });
    f.now += OWNER_POINTER_SPACING_MS;
    await svc.tick();
    expect(port.typed).toEqual([]);
  });

  it('a recoverable hold (refusal budget) stays armed', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'composer-not-empty' };
    const note = await owner();
    f.setItem(note.inboxItemId!, { state: 'held', heldReason: 'composer-not-ready:busy (30 refusals)' });
    port.refusal = null;
    await svc.tick();
    expect(port.typed).toHaveLength(1);
  });

  it('a handover in the recipient workspace re-routes the note and arms one line for the new orchestrator', async () => {
    port.outcome = 'stranded';
    const note = await owner();
    f.orchestrators.set('ws-1', 'tab-a2');
    port.outcome = 'submitted';
    f.now += OWNER_POINTER_SPACING_MS;
    await svc.tick();
    expect(f.note(note.id).deliveredTo).toEqual({ workspaceId: 'ws-1', tabId: 'tab-a2' });
    expect(port.typed.map((t) => t.tab)).toEqual(['ws-1/tab-a', 'ws-1/tab-a2']);
    expect(f.note(note.id).pointer).toMatchObject({ route: 'ws-1/tab-a2', outcome: 'submitted' });
  });

  it('an acked or expired owner item is never pointed at', async () => {
    port.refusal = { code: 'note-point-not-ready', reason: 'composer-not-empty' };
    const note = await owner();
    f.setItem(note.inboxItemId!, { state: 'delivered', deliveredAt: f.now });
    await svc.tick();
    await svc.ack(A, note.id, undefined);
    port.refusal = null;
    await svc.tick();
    expect(port.typed).toEqual([]);
  });

  it('without a port (a server that has none wired), an owner item keeps only its inbox notice', async () => {
    const bare = new NotesService({ ...f.deps(), pointPort: undefined });
    const note = await bare.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b', ownerItem: true });
    await bare.tick();
    expect(port.typed).toEqual([]);
    expect(f.inbox.get(note.inboxItemId!)?.state).toBe('queued');
  });
});

describe('the undelivered sender notice', () => {
  it('comes at 15 min for an ordinary note and says 15 min', async () => {
    const f = new Fakes();
    const svc = new NotesService(f.deps());
    const note = await svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b' });
    f.now = T0 + OWNER_ITEM_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    expect([...f.inbox.values()].some((i) => i.dedupeKey.includes(':undelivered:'))).toBe(false);
    f.now = T0 + NOTE_UNDELIVERED_NOTICE_MS;
    await svc.tick();
    expect([...f.inbox.values()].find((i) => i.dedupeKey === `note:${note.id}:undelivered:tab-b`)?.line).toContain('after 15 min');
  });
});

describe('ack (change 2)', () => {
  it('types nothing, records the ack once for the sender, and a repeated ack records nothing more', async () => {
    const f = new Fakes();
    const svc = new NotesService(f.deps());
    const note = await svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b' });
    f.setItem(note.inboxItemId!, { state: 'delivered', deliveredAt: f.now });
    const before = f.inbox.size;
    await svc.ack(A, note.id, 'GO');
    await svc.ack(A, note.id, 'GO');
    expect(f.inbox.size).toBe(before);
    expect(f.acks.map((n) => [n.id, n.state, n.ackComment])).toEqual([[note.id, 'acked', 'GO']]);
  });

  it('a failed record never fails the ack', async () => {
    const f = new Fakes();
    const svc = new NotesService({ ...f.deps(), recordAck: async () => { throw new Error('ledger down'); } });
    const note = await svc.send(B, { toWorkspace: 'ws-1', subject: 's', body: 'b' });
    f.setItem(note.inboxItemId!, { state: 'delivered', deliveredAt: f.now });
    await expect(svc.ack(A, note.id, undefined)).resolves.toMatchObject({ state: 'acked' });
  });

  it('the boot sweep withdraws queued and held retired ack notices, and nothing else', async () => {
    const f = new Fakes();
    const svc = new NotesService(f.deps());
    const item = (id: string, dedupeKey: string, state: IInboxItem['state'], heldReason: string | null = null) =>
      f.inbox.set(id, { id, kind: 'note', dedupeKey, state, heldReason } as IInboxItem);
    item('i-1', 'note:n-abcd1:acked:tab-b', 'held', 'stranded-in-composer');
    item('i-2', 'note:n-abcd2:acked:tab-b', 'queued');
    item('i-3', 'note:n-abcd3:acked:tab-b', 'delivered');
    item('i-4', 'note:n-abcd4:delivered:tab-a', 'held', 'stranded-in-composer');
    item('i-5', 'note:n-abcd5:undelivered:tab-b', 'queued');
    expect(await svc.sweepRetiredAckNotices()).toBe(2);
    expect(f.withdrawn).toEqual([{ id: 'i-1', reason: 'note-ack-notice-retired' }, { id: 'i-2', reason: 'note-ack-notice-retired' }]);
  });
});
