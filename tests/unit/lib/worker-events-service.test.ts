import { beforeEach, describe, expect, it } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { NotesService, type INotesDeps } from '@/lib/notes-service';
import { WorkerEventError } from '@/lib/worker-event-schema';
import { patchIdCommandFrom } from '@/lib/worker-event-validators';
import { WorkerEventsService, type IWorkerEventsDeps } from '@/lib/worker-events-service';
import type { IInboxItem } from '@/types/inbox';
import type { INotesState } from '@/types/note';
import type { IEventScopesState } from '@/types/worker-event';
import { FakeEvidence, KEY, PATCH_ID_ENV_VALUE, landedPayload, range, reviewReadyPayload } from './worker-event-fakes';

// ADR-0043 end to end over fakes: the real events service and the real notes service, with an
// in-memory note store, scope store, lease table, live tabs, orchestrators, inbox and evidence.

const T0 = Date.parse('2026-11-08T09:00:00.000Z');

const tab = (workspaceId: string, tabId: string, verified = true): ICaller =>
  ({ scope: { type: 'workspace', workspaceId }, workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'hook', admin: false } as ICaller);
const ADMIN = { scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true } as unknown as ICaller;

const O1 = tab('ws-1', 'tab-o1'); // ws-1's coordinator; holds epic:alpha
const W1 = tab('ws-1', 'tab-w1'); // a worker of alpha
const W2 = tab('ws-1', 'tab-w2'); // holds epic:gamma inside ws-1
const O2 = tab('ws-2', 'tab-o2'); // ws-2's coordinator; holds epic:beta

class World {
  now = T0;
  notes: INotesState = { notes: [] };
  scopes: IEventScopesState = { scopes: [] };
  epics = new Map<string, { workspaceId: string; tabId: string }>([
    ['alpha', { workspaceId: 'ws-1', tabId: 'tab-o1' }],
    ['gamma', { workspaceId: 'ws-1', tabId: 'tab-w2' }],
    ['beta', { workspaceId: 'ws-2', tabId: 'tab-o2' }],
  ]);
  live = new Set(['ws-1/tab-o1', 'ws-1/tab-w1', 'ws-1/tab-w2', 'ws-1/tab-w3', 'ws-2/tab-o2']);
  uncertain = new Set<string>();
  orchestrators = new Map([['ws-1', 'tab-o1'], ['ws-2', 'tab-o2']]);
  inbox = new Map<string, IInboxItem>();
  sent: Array<IEnqueueRequest<'note'> & { line: string; id: string }> = [];
  audit: Array<Record<string, unknown>> = [];
  evidence = new FakeEvidence();
  /** `ws/tab` → the ssh alias of its host; absent = local; `unknown` = the layout cannot say. */
  hosts = new Map<string, string>();
  patchIdEnv: string | undefined = PATCH_ID_ENV_VALUE;
  /** Fail the n-th enqueue (1-based), to show nothing is left behind. */
  failEnqueue = 0;
  private seq = 0;

  private holder = async (slug: string) => {
    const h = this.epics.get(slug);
    return h && this.live.has(`${h.workspaceId}/${h.tabId}`) ? h : null;
  };

  private liveTabs = async () => ({
    tabs: [...this.live].map((k) => ({ workspaceId: k.split('/')[0], tabId: k.split('/')[1] })),
    uncertainWorkspaceIds: new Set(this.uncertain),
  });

  notesDeps(): INotesDeps {
    return {
      now: () => this.now,
      newId: () => `n-note${++this.seq}`,
      mutate: async (fn) => {
        const { state, value } = await fn(this.notes);
        this.notes = state;
        return value;
      },
      read: async () => this.notes,
      epicHolder: this.holder,
      holdsEpic: async () => false,
      orchestratorOf: async (ws) => this.orchestrators.get(ws) ?? null,
      withMappingRead: async (_ws, work) => work(),
      workspaceExists: async (ws) => ['ws-1', 'ws-2'].includes(ws),
      liveTabs: this.liveTabs,
      enqueue: async (req) => {
        if (this.failEnqueue && this.sent.length + 1 === this.failEnqueue) throw new Error('inbox write failed');
        const id = `i-item${this.sent.length + 1}`;
        this.sent.push({ ...req, line: renderInboxLine('note', req.fields).line, id });
        const item = { id, kind: 'note', dedupeKey: req.dedupeKey, state: 'queued', targetWorkspaceId: req.targetWorkspaceId,
          targetTabId: req.targetTabId, createdAt: this.now, deliveredAt: null, lastRefusal: null, heldReason: null } as unknown as IInboxItem;
        this.inbox.set(id, item);
        return { item };
      },
      withdraw: async (id) => {
        const item = this.inbox.get(id);
        if (!item || (item.state !== 'queued' && item.state !== 'held')) return false;
        this.inbox.set(id, { ...item, state: 'dropped' } as IInboxItem);
        return true;
      },
      inboxItems: async () => [...this.inbox.values()],
    };
  }

  eventsDeps(notes: NotesService): IWorkerEventsDeps {
    return {
      now: () => this.now,
      readScopes: async () => this.scopes,
      mutateScopes: async (fn) => {
        const { state, value } = await fn(this.scopes);
        this.scopes = state;
        return value;
      },
      orchestratorOf: async (ws) => this.orchestrators.get(ws) ?? null,
      liveTabs: this.liveTabs,
      epicHolder: this.holder,
      workspaceDirectories: async (ws) => (ws === 'ws-1' ? ['/w'] : []),
      extraRoots: () => [],
      reader: this.evidence.reader(),
      patchIdCommand: patchIdCommandFrom(this.patchIdEnv),
      tabHost: async (ws, tabId) => {
        const host = this.hosts.get(`${ws}/${tabId}`);
        return host === 'unknown' ? undefined : host ?? null;
      },
      notes,
      audit: async (entry) => { this.audit.push(entry); },
    };
  }
}

const refused = async (promise: Promise<unknown>, code: string): Promise<WorkerEventError> => {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toMatchObject({ code });
  return err as WorkerEventError;
};

let world: World;
let notes: NotesService;
let events: WorkerEventsService;

const declare = (input: Record<string, unknown> = {}) =>
  events.declareScope(O1, { tabId: 'tab-w1', epic: 'alpha', story: 'vel-d6', dependsOn: ['beta', 'gamma', 'delta'], ...input });
const reviewReady = (toEpic = 'beta', change: Record<string, unknown> = {}) =>
  events.send(W1, { type: 'review-ready', toEpic, payload: { ...reviewReadyPayload, ...change } });

beforeEach(() => {
  world = new World();
  notes = new NotesService(world.notesDeps());
  events = new WorkerEventsService(world.eventsDeps(notes));
});

describe('declaring a scope (ADR-0043 §1)', () => {
  it('records the coordinator-declared scope of a live worker tab', async () => {
    await expect(declare()).resolves.toEqual({
      workspaceId: 'ws-1', tabId: 'tab-w1', epic: 'alpha', story: 'vel-d6', dependsOn: ['beta', 'gamma', 'delta'], attempt: 1,
      declaredBy: { workspaceId: 'ws-1', tabId: 'tab-o1' }, declaredAt: T0,
    });
    await expect(events.listScopes(W1)).resolves.toHaveLength(1);
    await expect(events.listScopes(O2)).resolves.toEqual([]);
    await expect(events.listScopes(ADMIN)).resolves.toHaveLength(1);
  });

  it('is the verified designated live coordinator only', async () => {
    await refused(events.declareScope(W1, { tabId: 'tab-w1', epic: 'alpha' }), 'forbidden');
    await refused(events.declareScope(tab('ws-1', 'tab-o1', false), { tabId: 'tab-w1', epic: 'alpha' }), 'forbidden');
    await refused(events.declareScope(ADMIN, { tabId: 'tab-w1', epic: 'alpha' }), 'forbidden');
    world.live.delete('ws-1/tab-o1');
    await refused(declare(), 'forbidden');
    world.live.add('ws-1/tab-o1');
    world.orchestrators.set('ws-1', 'tab-w3');
    await refused(declare(), 'forbidden');
    expect(world.scopes.scopes).toEqual([]);
  });

  it('serves only an epic held by a live tab of the same workspace, for a live tab of that workspace', async () => {
    expect((await refused(declare({ epic: 'beta', dependsOn: [] }), 'event-scope-invalid')).message).toContain('epic:beta is not held by a live tab of ws-1 (holder: ws-2/tab-o2)');
    expect((await refused(declare({ epic: 'delta', dependsOn: [] }), 'event-scope-invalid')).message).toContain('(holder: none)');
    expect((await refused(declare({ tabId: 'tab-o2' }), 'event-scope-invalid')).message).toBe('tab-o2 is not a live tab of ws-1');
    await refused(declare({ tabId: 'not-a-tab' }), 'event-scope-invalid');
    await refused(declare({ epic: 'Not A Slug' }), 'event-scope-invalid');
  });

  it.each([
    ['a dependency twice', { dependsOn: ['beta', 'beta'] }, 'dependsOn names an epic twice'],
    ['the served epic as a dependency', { dependsOn: ['alpha'] }, 'dependsOn names the served epic alpha'],
    ['a non-slug dependency', { dependsOn: ['beta', 'Bad Slug'] }, 'not epic slugs: "Bad Slug"'],
    ['dependencies that are not a list', { dependsOn: 'beta' }, 'dependsOn must be a list'],
    ['more than 16 dependencies', { dependsOn: Array.from({ length: 17 }, (_, i) => `e${i}`) }, 'at most 16'],
    ['a bad story key', { story: 'a b' }, 'story must match'],
    ['attempt 0', { attempt: 0 }, 'attempt must be a whole number'],
  ])('refuses %s', async (_name, input, message) => {
    expect((await refused(declare(input), 'event-scope-invalid')).message).toContain(message);
  });

  it('keeps the attempt on a re-declare, raises it on a re-dispatch, and never lowers it', async () => {
    await declare({ attempt: 2 });
    await expect(declare({ dependsOn: ['beta'] })).resolves.toMatchObject({ attempt: 2, dependsOn: ['beta'] });
    await expect(declare({ attempt: 3 })).resolves.toMatchObject({ attempt: 3 });
    expect((await refused(declare({ attempt: 1 }), 'event-scope-invalid')).message).toContain('attempt 1 is below the current attempt 3');
    expect(world.scopes.scopes).toHaveLength(1);
  });

  it('drops the scopes of closed tabs, but not of tabs whose state is unknown', async () => {
    await declare();
    await events.declareScope(O1, { tabId: 'tab-w3', epic: 'alpha' });
    world.live.delete('ws-1/tab-w1');
    await events.declareScope(O1, { tabId: 'tab-w2', epic: 'alpha' });
    expect(world.scopes.scopes.map((s) => s.tabId)).toEqual(['tab-w3', 'tab-w2']);
    world.scopes.scopes.push({ ...world.scopes.scopes[0], workspaceId: 'ws-9', tabId: 'tab-x' });
    world.uncertain.add('ws-9');
    await events.declareScope(O1, { tabId: 'tab-w3', epic: 'alpha' });
    expect(world.scopes.scopes.map((s) => s.tabId)).toEqual(['tab-w2', 'tab-x', 'tab-w3']);
  });

  it('is cleared by the coordinator only', async () => {
    await declare();
    await refused(events.clearScope(W1, 'tab-w1'), 'forbidden');
    await expect(events.clearScope(O1, 'tab-w1')).resolves.toBe(true);
    await expect(events.clearScope(O1, 'tab-w1')).resolves.toBe(false);
    await refused(events.clearScope(O1, 'bad'), 'event-scope-invalid');
  });
});

describe('the event states (ADR-0043 §2)', () => {
  beforeEach(async () => {
    await declare();
  });

  it('sent → validated → delivered: a worker reaches another workspace\'s coordinator without its own retyping it', async () => {
    const result = await reviewReady();
    expect(result.event).toEqual({
      type: 'review-ready', toEpic: 'beta', state: 'delivered',
      checks: ['evidence-paths', 'range', 'gate-verdict', 'gate-tree', 'patch-id', 'review-folder', 'receipt'],
      noteId: 'n-note1', statusNoteId: null,
    });
    const stored = world.notes.notes[0];
    expect(stored).toMatchObject({
      state: 'delivered', admission: { mode: 'event', sender: { workspaceId: 'ws-1', tabId: 'tab-w1' } },
      deliveredTo: { workspaceId: 'ws-2', tabId: 'tab-o2' }, to: { epic: 'beta', workspaceId: null },
      event: { type: 'review-ready', role: 'delivery', payload: reviewReadyPayload, scope: { epic: 'alpha', story: 'vel-d6', attempt: 1 } },
    });
    expect(stored.body).toContain(`"key": "${KEY}"`);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]).toMatchObject({ targetWorkspaceId: 'ws-2', targetTabId: 'tab-o2' });
    expect(world.sent[0].line).toBe('[purplemux note n-note1] from ws-1/tab-w1 at 2026-11-08T09:00:00Z — purplemux note show n-note1, then purplemux note ack n-note1');
    expect(world.audit).toEqual([expect.objectContaining({ event: 'typed-event-delivered', noteId: 'n-note1', toEpic: 'beta' })]);
  });

  it('review-ready sends the source coordinator no line; it reads the event with note list', async () => {
    await reviewReady();
    expect(world.sent.filter((s) => s.targetTabId === 'tab-o1')).toEqual([]);
    await expect(notes.list(O1, {})).resolves.toEqual([expect.objectContaining({ id: 'n-note1', event: expect.objectContaining({ type: 'review-ready' }) })]);
  });

  it('delivered → acked: the receiving coordinator acks; the worker cannot', async () => {
    await reviewReady();
    await expect(notes.ack(W1, 'n-note1', null)).rejects.toMatchObject({ code: 'forbidden' });
    const preflight = await notes.preflight(world.inbox.get('i-item1')!);
    expect(preflight).toMatchObject({ ok: true });
    if (preflight.ok) preflight.settle();
    await expect(notes.ack(O2, 'n-note1', 'reviewing now')).resolves.toMatchObject({ state: 'acked', ackedBy: { workspaceId: 'ws-2', tabId: 'tab-o2' } });
  });

  it('delivers a dependency held inside the same workspace to its holder tab', async () => {
    const result = await events.send(W1, { type: 'landed', toEpic: 'gamma', payload: landedPayload });
    expect(world.notes.notes.find((n) => n.id === result.event.noteId)!.deliveredTo).toEqual({ workspaceId: 'ws-1', tabId: 'tab-w2' });
  });

  it('landed and blocked-on send one short status note to the source coordinator', async () => {
    const landed = await events.send(W1, { type: 'landed', toEpic: 'beta', payload: landedPayload });
    expect(landed.event.statusNoteId).toBe('n-note2');
    const status = world.notes.notes.find((n) => n.id === 'n-note2')!;
    expect(status).toMatchObject({
      to: { epic: null, workspaceId: 'ws-1' }, deliveredTo: { workspaceId: 'ws-1', tabId: 'tab-o1' },
      event: { role: 'status', type: 'landed', deliveryNoteId: 'n-note1' },
    });
    expect(status.body).not.toContain('"repo"');
    const blocked = await events.send(W1, { type: 'blocked-on', toEpic: 'beta', payload: { ...range, reason: 'waits for beta schema', clearInput: 'beta#12 merged' } });
    expect(blocked.status).toMatchObject({ event: expect.objectContaining({ role: 'status', type: 'blocked-on' }) });
    expect(world.sent.map((s) => s.targetTabId)).toEqual(['tab-o2', 'tab-o1', 'tab-o2', 'tab-o1']);
    expect(world.sent.every((s) => !s.line.includes('waits for beta'))).toBe(true);
  });

  it('sends no status note when the source coordinator is the recipient, or is the sender', async () => {
    const own = await events.send(W1, { type: 'landed', toEpic: 'alpha', payload: landedPayload });
    expect(own.status).toBeNull();
    expect(world.notes.notes).toHaveLength(1);
    await events.declareScope(O1, { tabId: 'tab-o1', epic: 'alpha', dependsOn: ['beta'] });
    const fromCoordinator = await events.send(O1, { type: 'landed', toEpic: 'beta', payload: landedPayload });
    expect(fromCoordinator.status).toBeNull();
  });

  it('validated → refused: a failed check is refused with every failure, audited, and nothing is delivered', async () => {
    world.evidence.files.set(`/w/receipts/${KEY}.md`, 'verdict: BLOCK\n');
    world.evidence.files.delete('/w/review/x-r1/record.md');
    const err = await refused(reviewReady(), 'event-refused');
    expect(err.message).toBe(`review-ready refused by 2 check(s): review-folder: measured /w/review/x-r1 lacks record.md; expected /w/review/x-r1 holds range.txt, diff.patch, status.txt, patch-id.txt, record.md | receipt: measured ${KEY}.md holds verdict: BLOCK; expected no BLOCK verdict in ${KEY}.md; a BLOCK belongs at ${KEY}.block.md`);
    expect(err.details.failures).toHaveLength(2);
    expect(world.notes.notes).toEqual([]);
    expect(world.sent).toEqual([]);
    expect(world.audit).toEqual([expect.objectContaining({ event: 'typed-event-refused', code: 'event-refused', from: { workspaceId: 'ws-1', tabId: 'tab-w1' } })]);
  });

  it('sent → refused: a schema defect is event-invalid before any evidence is read', async () => {
    await refused(reviewReady('beta', { head: 'HEAD' }), 'event-invalid');
    await refused(events.send(W1, { type: 'review-ready', toEpic: 'Beta!', payload: reviewReadyPayload }), 'event-invalid');
    expect(world.evidence.runs).toEqual([]);
  });

  it('refuses a target outside the scope, a tab with no scope, and a scope whose epic was released', async () => {
    expect((await refused(reviewReady('omega'), 'event-out-of-scope')).message).toBe('epic:omega is outside this tab\'s scope (allowed: alpha, beta, gamma, delta)');
    expect((await refused(events.send(W2, { type: 'landed', toEpic: 'beta', payload: landedPayload }), 'event-out-of-scope')).message)
      .toContain('ws-1/tab-w2 has no event scope');
    world.epics.delete('alpha');
    expect((await refused(reviewReady(), 'event-out-of-scope')).message).toContain('no longer held by a live tab of ws-1');
    expect(world.notes.notes).toEqual([]);
  });

  it('refuses an admin token, a workspace token and an unverified tab: no blanket authority', async () => {
    await refused(events.send(ADMIN, { type: 'landed', toEpic: 'beta', payload: {} }), 'forbidden');
    await refused(events.send({ ...W1, tabId: null } as ICaller, { type: 'landed', toEpic: 'beta', payload: {} }), 'forbidden');
    await refused(events.send(tab('ws-1', 'tab-w1', false), { type: 'landed', toEpic: 'beta', payload: {} }), 'forbidden');
    await expect(notes.sendEvent(tab('ws-1', 'tab-w1', false), { toEpic: 'beta', subject: 's', body: 'b',
      record: { type: 'landed', role: 'delivery', payload: landedPayload, scope: { epic: 'alpha', story: null, dependsOn: [], attempt: 1 }, checks: [], dedupeKey: 'k' } }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses an old attempt as stale (attempt fencing)', async () => {
    await declare({ attempt: 2 });
    expect((await refused(reviewReady('beta', { attempt: 1 }), 'event-stale')).message).toContain('attempt 1 is not the current attempt 2');
    await expect(reviewReady('beta', { attempt: 2 })).resolves.toMatchObject({ event: { state: 'delivered' } });
  });

  it('refuses the same event twice as stale, naming the note that carried it', async () => {
    await reviewReady();
    const err = await refused(reviewReady(), 'event-stale');
    expect(err.details).toEqual({ noteId: 'n-note1', noteState: 'delivered' });
    expect(world.notes.notes).toHaveLength(1);
    expect(world.sent).toHaveLength(1);
    await expect(reviewReady('gamma')).resolves.toMatchObject({ event: { state: 'delivered' } });
  });

  it('refuses an event with no live recipient and stores nothing (no event sits unseen)', async () => {
    expect((await refused(reviewReady('delta'), 'event-no-recipient')).message).toContain('epic:delta has no live recipient now (target-epic-unowned)');
    world.live.delete('ws-2/tab-o2');
    world.epics.set('beta', { workspaceId: 'ws-2', tabId: 'tab-b2' });
    world.live.add('ws-2/tab-b2');
    expect((await refused(reviewReady(), 'event-no-recipient')).message).toContain('(target-coordinator-unavailable)');
    expect(world.notes.notes).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  it('counts the delivery and its status note against the sender cap', async () => {
    world.notes.notes = Array.from({ length: 49 }, (_, i) => ({
      ...({} as INotesState['notes'][number]), id: `n-old${i}aa`, state: 'delivered', from: { workspaceId: 'ws-1', tabId: 'tab-w1', verified: true, epic: null },
      to: { epic: 'beta', workspaceId: null }, subject: 's', body: 'b',
    }));
    await refused(events.send(W1, { type: 'landed', toEpic: 'beta', payload: landedPayload }), 'note-cap');
    await expect(reviewReady()).resolves.toMatchObject({ event: { state: 'delivered' } });
  });
});

describe('review round 1 rulings', () => {
  beforeEach(async () => {
    await declare();
  });

  it('delivers a first hand-off for review that names no receipt (R1-2)', async () => {
    const { receipt: _receipt, ...firstHandOff } = reviewReadyPayload;
    world.evidence.files.delete(`/w/receipts/${KEY}.md`);
    const result = await events.send(W1, { type: 'review-ready', toEpic: 'beta', payload: firstHandOff });
    expect(result.event).toMatchObject({ state: 'delivered', checks: ['evidence-paths', 'range', 'gate-verdict', 'gate-tree', 'patch-id', 'review-folder'] });
    expect(world.notes.notes[0].event?.payload).not.toHaveProperty('receipt');
  });

  it('refuses a RED gate as event-refused, naming the verdict (R1-1)', async () => {
    world.evidence.files.set('/w/gate.log', `START=1\nGIT_TREE_END=${'d'.repeat(40)}\nVERDICT=RED\nSETTLED=yes\n`);
    const err = await refused(reviewReady(), 'event-refused');
    expect(err.message).toContain('gate-verdict: measured VERDICT=RED SETTLED=yes in the last run of the gate log');
    expect(world.notes.notes).toEqual([]);
  });

  it('refuses as event-check-unavailable, naming the variable, when no patch-id command is configured (R1-3)', async () => {
    world.patchIdEnv = undefined;
    events = new WorkerEventsService(world.eventsDeps(notes));
    world.evidence.files.set('/w/gate.log', 'START=1\nVERDICT=RED\n');
    const err = await refused(reviewReady(), 'event-check-unavailable');
    expect(err.message).toContain('PMUX_EVENT_PATCH_ID_CMD is unset on the server');
    expect(err.details.failures).toEqual([expect.objectContaining({ check: 'patch-id', unavailable: true })]);
    expect(world.evidence.runs).toEqual([]);
    expect(world.notes.notes).toEqual([]);
    world.patchIdEnv = '["tools/patch-id.sh", "{base}", "{head}"]';
    events = new WorkerEventsService(world.eventsDeps(notes));
    expect((await refused(reviewReady(), 'event-check-unavailable')).message).toContain('not an absolute path');
  });

  it('refuses a remote tab, and a tab whose host is unknown, before reading any evidence (R1-4)', async () => {
    world.hosts.set('ws-1/tab-w1', 'ai-lan');
    expect((await refused(reviewReady(), 'event-check-unavailable')).message)
      .toBe('ws-1/tab-w1 runs on host ai-lan (ADR-0022); the server reads evidence on its own host only, so a remote tab reports through the coordinator');
    world.hosts.set('ws-1/tab-w1', 'unknown');
    expect((await refused(reviewReady(), 'event-check-unavailable')).message).toContain('cannot be read from its layout');
    expect(world.evidence.runs).toEqual([]);
    expect(world.notes.notes).toEqual([]);
  });

  it('refuses a result whose scope was re-dispatched, cleared or narrowed while the evidence was checked (R1-5)', async () => {
    const during = (change: () => void) => {
      world.evidence.command = () => {
        change();
        return { code: 0, stdout: `${KEY}\n`, stderr: '' };
      };
    };
    during(() => { world.scopes = { scopes: world.scopes.scopes.map((sc) => ({ ...sc, attempt: 2 })) }; });
    expect((await refused(reviewReady(), 'event-stale')).message).toContain('attempt 1 → 2');
    await declare({ attempt: 3 });
    during(() => { world.scopes = { scopes: [] }; });
    expect((await refused(reviewReady('beta', { attempt: 3 }), 'event-stale')).message).toContain('the scope was cleared');
    await declare({ attempt: 3 });
    during(() => { world.scopes = { scopes: world.scopes.scopes.map((sc) => ({ ...sc, dependsOn: ['gamma'] })) }; });
    await refused(reviewReady('beta', { attempt: 3 }), 'event-out-of-scope');
    expect(world.notes.notes).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  it('lets an event be sent again once its note expired unacked, and says when it is still open or acked (R1-6)', async () => {
    await reviewReady();
    expect((await refused(reviewReady(), 'event-stale')).message).toContain('already sent as note n-note1 (delivered, not yet acked)');
    world.notes = { notes: world.notes.notes.map((n) => ({ ...n, state: 'acked' as const })) };
    expect((await refused(reviewReady(), 'event-stale')).message).toContain('(acked)');
    world.notes = { notes: world.notes.notes.map((n) => ({ ...n, state: 'expired' as const })) };
    const again = await reviewReady();
    expect(again.event.state).toBe('delivered');
    expect(again.event.noteId).not.toBe('n-note1');
    expect(world.notes.notes.map((n) => n.state)).toEqual(['expired', 'delivered']);
  });

  it('withdraws the delivery\'s queued line when the status note fails, and stores nothing (R1-6)', async () => {
    world.failEnqueue = 2;
    await expect(events.send(W1, { type: 'landed', toEpic: 'beta', payload: landedPayload })).rejects.toThrow('inbox write failed');
    expect(world.notes.notes).toEqual([]);
    expect([...world.inbox.values()].map((item) => item.state)).toEqual(['dropped']);
  });
});
