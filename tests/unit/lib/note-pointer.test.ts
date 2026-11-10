import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine, renderNotePointerLine } from '@/lib/inbox-templates';
import { NOTE_POINT_BOUND_MS, notePointPort, pointerRefusal, type INotePointPort, type INotePointTarget, type INotePointTargetDeps } from '@/lib/note-pointer';
import { NoteError } from '@/lib/notes-store';
import { NotesService, type INotesDeps } from '@/lib/notes-service';
import type { IInboxItem } from '@/types/inbox';
import type { INotesState } from '@/types/note';
import type { ITab } from '@/types/terminal';

// G7 step 0 (design ruling vel-G7-POINTER): a verified coordinator types one fixed pointer line for its own
// undelivered cross-workspace note into the recipient orchestrator, busy included. Fakes as in notes-service.test.

const T0 = Date.parse('2026-11-10T03:00:00.000Z');

const caller = (workspaceId: string, tabId: string, verified = true): ICaller =>
  ({ scope: { type: 'workspace', workspaceId }, workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'hook', admin: false } as unknown as ICaller);
const ADMIN = { scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true } as unknown as ICaller;

const A = caller('ws-1', 'tab-a'); // the recipient workspace's orchestrator
const B = caller('ws-2', 'tab-b'); // a coordinator that sends
const C = caller('ws-3', 'tab-c'); // another coordinator
const W = caller('ws-2', 'tab-worker'); // a worker beside B
const O = caller('ws-4', 'tab-o'); // an owner-granted tab that is not a coordinator

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
        const id = `i-item${this.inbox.size + 1}`;
        const item = { id, kind: 'note', dedupeKey: req.dedupeKey, state: 'queued', targetWorkspaceId: req.targetWorkspaceId,
          targetTabId: req.targetTabId, line: renderInboxLine('note', req.fields).line, createdAt: this.now, deliveredAt: null,
          lastRefusal: null, heldReason: null } as unknown as IInboxItem;
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
      ownerGrantOf: (tab) => (tab.workspaceId === 'ws-4' && tab.tabId === 'tab-o'
        ? { id: 'g-owner1', capability: 'owner' } as never : null),
      audit: async (entry) => { this.audits.push(entry); },
      window: () => ({ claim: (ws: string, tab: string) => { this.claims.push(`${ws}/${tab}`); } }) as never,
    };
  }

  note(id: string) {
    return this.state.notes.find((n) => n.id === id)!;
  }
}

/** A port whose target answers `refusal` and records what was typed. */
class FakePort implements INotePointPort {
  typed: Array<{ tab: string; line: string }> = [];
  refusal: Awaited<ReturnType<INotePointTarget['refusal']>> = null;
  submitted = true;
  gone = false;
  insideLock: (() => void) | null = null;

  async withTarget<T>(workspaceId: string, tabId: string, work: (target: INotePointTarget) => Promise<T>): Promise<T | null> {
    if (this.gone) return null;
    this.insideLock?.();
    return work({
      refusal: async () => this.refusal,
      type: async (line) => {
        this.typed.push({ tab: `${workspaceId}/${tabId}`, line });
        return { submitted: this.submitted, cliState: 'busy' };
      },
    });
  }
}

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toBeInstanceOf(NoteError);
  await expect(promise).rejects.toMatchObject({ code });
};

describe('note point (G7 step 0)', () => {
  let f: Fakes;
  let svc: NotesService;
  let port: FakePort;

  beforeEach(() => {
    f = new Fakes();
    svc = new NotesService(f.deps());
    port = new FakePort();
  });

  const send = async (from: ICaller = B, toWorkspace = 'ws-1') => svc.send(from, { toWorkspace, subject: 'GO on F12', body: 'owner says go' });

  it('types the fixed line into a busy recipient orchestrator once, then records the composer receipt (AC5)', async () => {
    const note = await send();
    expect(note.deliveredTo).toEqual({ workspaceId: 'ws-1', tabId: 'tab-a' });
    const result = await svc.point(B, note.id, port);
    expect(result).toMatchObject({ status: 'sent', submitted: true, noteId: note.id, target: { workspaceId: 'ws-1', tabId: 'tab-a' }, cliState: 'busy' });
    expect(port.typed).toEqual([{ tab: 'ws-1/tab-a',
      line: `[purplemux note ${note.id}] from ws-2/tab-b at 2026-11-10T03:00:00Z needs action now: run purplemux note show ${note.id} now, then purplemux note ack ${note.id}` }]);
    expect(f.note(note.id).deliveredAt).toBe(T0);
    expect(f.withdrawn).toEqual([{ id: note.inboxItemId, reason: 'note-pointed' }]);
    expect(f.claims).toEqual(['ws-1/tab-a']);
    expect(f.audits).toEqual([expect.objectContaining({ event: 'note-pointer', noteId: note.id, result: 'submitted' })]);
    // The note now reached a composer: a second pointer is refused, and nothing more is typed.
    f.now += NOTE_POINT_BOUND_MS;
    await expectCode(svc.point(B, note.id, port), 'forbidden');
    expect(port.typed).toHaveLength(1);
  });

  it('never types the subject or the body, and says "owner decision" only for an owner-admitted note (AC9)', async () => {
    const coord = await send();
    await svc.point(B, coord.id, port);
    expect(port.typed[0].line).not.toMatch(/GO on F12|owner says go|owner/);
    const line = renderNotePointerLine({ noteId: 'n-abcd1', fromWorkspaceId: 'ws-4', fromTabId: 'tab-o', fromOwner: true, sentAt: T0 });
    expect(line).toBe('[purplemux note n-abcd1] from owner (ws-4/tab-o) at 2026-11-10T03:00:00Z carries an owner decision: '
      + 'run purplemux note show n-abcd1 now, then purplemux note ack n-abcd1');
    expect(() => renderNotePointerLine({ noteId: 'n-x; rm -rf', fromWorkspaceId: 'ws-4', fromTabId: 'tab-o', sentAt: T0 })).toThrow();
  });

  it('refuses a note the caller did not send, an acked note, and a note already in the composer (AC2)', async () => {
    const fromB = await send();
    await expectCode(svc.point(C, fromB.id, port), 'forbidden');
    await svc.ack(A, fromB.id, undefined);
    await expectCode(svc.point(B, fromB.id, port), 'forbidden');
    const delivered = await send();
    f.inbox.set(delivered.inboxItemId!, { ...f.inbox.get(delivered.inboxItemId!)!, state: 'delivered', deliveredAt: T0 } as IInboxItem);
    await expectCode(svc.point(B, delivered.id, port), 'forbidden');
    await expectCode(svc.point(B, 'n-nosuch1', port), 'note-not-found');
    await expectCode(svc.point(B, 'not an id', port), 'note-invalid');
    expect(port.typed).toEqual([]);
  });

  it('refuses a target that is not the enabled orchestrator of another workspace (AC3)', async () => {
    const note = await send();
    // The mapping moved: the note's routed tab is no longer that workspace's orchestrator.
    f.orchestrators.set('ws-1', 'tab-a2');
    await expectCode(svc.point(B, note.id, port), 'forbidden');
    // Orchestration off: no route at all.
    f.orchestrators.delete('ws-1');
    await expectCode(svc.point(B, note.id, port), 'forbidden');
    // A note inside the caller's own workspace (to its epic-holding worker) takes no pointer.
    f.orchestrators.set('ws-1', 'tab-a');
    f.epics.set('local', { workspaceId: 'ws-2', tabId: 'tab-worker' });
    const local = await svc.send(B, { toEpic: 'local', subject: 's', body: 'b' });
    expect(local.deliveredTo).toEqual({ workspaceId: 'ws-2', tabId: 'tab-worker' });
    await expectCode(svc.point(B, local.id, port), 'forbidden');
    expect(port.typed).toEqual([]);
  });

  it('refuses a caller that is not the verified current orchestrator of its own workspace (AC4)', async () => {
    const note = await send();
    await expectCode(svc.point(W, note.id, port), 'forbidden');
    await expectCode(svc.point(caller('ws-2', 'tab-b', false), note.id, port), 'forbidden');
    await expectCode(svc.point(ADMIN, note.id, port), 'forbidden');
    // An owner-granted tab sends as owner, but is not a coordinator: it points at nothing.
    const owned = await svc.send(O, { toWorkspace: 'ws-1', subject: 's', body: 'b' });
    expect(owned.admission).toMatchObject({ mode: 'owner' });
    await expectCode(svc.point(O, owned.id, port), 'forbidden');
    // A handover after the note was sent: the old coordinator no longer points.
    f.orchestrators.set('ws-2', 'tab-worker');
    await expectCode(svc.point(B, note.id, port), 'forbidden');
    expect(port.typed).toEqual([]);
  });

  it('re-checks inside the lock: a handover while the pointer waited types nothing', async () => {
    const note = await send();
    port.insideLock = () => { f.orchestrators.set('ws-2', 'tab-worker'); };
    await expectCode(svc.point(B, note.id, port), 'forbidden');
    expect(port.typed).toEqual([]);
  });

  it('a target that cannot take a line types nothing and spends no bound (AC7)', async () => {
    const note = await send();
    port.refusal = { code: 'note-point-not-ready', reason: 'native-prompt-active' };
    await expectCode(svc.point(B, note.id, port), 'note-point-not-ready');
    port.refusal = { code: 'session-not-running', reason: 'session-not-running' };
    await expectCode(svc.point(B, note.id, port), 'session-not-running');
    port.refusal = null;
    port.gone = true;
    await expectCode(svc.point(B, note.id, port), 'tab-not-found');
    port.gone = false;
    expect(port.typed).toEqual([]);
    await expect(svc.point(B, note.id, port)).resolves.toMatchObject({ submitted: true });
    expect(f.audits.map((a) => a.result)).toEqual(['note-point-not-ready', 'session-not-running', 'tab-not-found', 'submitted']);
  });

  it('one pointer per target tab per 10 min from any sender, and one per note (AC8)', async () => {
    const fromB = await send(B);
    const fromC = await send(C);
    await svc.point(B, fromB.id, port);
    await expectCode(svc.point(C, fromC.id, port), 'note-point-too-soon');
    f.now += NOTE_POINT_BOUND_MS - 1;
    await expectCode(svc.point(C, fromC.id, port), 'note-point-too-soon');
    f.now += 1;
    await expect(svc.point(C, fromC.id, port)).resolves.toMatchObject({ submitted: true });
    expect(port.typed.map((t) => t.line.slice(0, 30))).toHaveLength(2);
  });

  it('a line left in the composer is reported, keeps no receipt, and still spends the bound', async () => {
    const note = await send();
    port.submitted = false;
    await expect(svc.point(B, note.id, port)).resolves.toMatchObject({ submitted: false, notSubmitted: 'typed-not-submitted' });
    expect(f.note(note.id).deliveredAt).toBeNull();
    expect(f.withdrawn).toEqual([]);
    expect(f.claims).toEqual([]);
    await expectCode(svc.point(B, note.id, port), 'note-point-too-soon');
  });

  it('five concurrent pointers at one target type exactly one line', async () => {
    const notes = [];
    for (let i = 0; i < 5; i += 1) notes.push(await send());
    const results = await Promise.allSettled(notes.map((n) => svc.point(B, n.id, port)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(port.typed).toHaveLength(1);
  });
});

describe('pointerRefusal — the inbox checks with busy admitted (design ruling F1)', () => {
  const EMPTY = 'done\n────────\n❯ \n────────\n';
  const TAB = { id: 'tab-a', name: 'orch', sessionName: 'pt-ws-1-p-tab-a', panelType: 'claude-code' } as unknown as ITab;

  const deps = (over: Partial<{ cliState: string; permission: boolean; halted: boolean; pane: string; tab: ITab | null; session: boolean }> = {}) => {
    const delivered: string[] = [];
    const d: INotePointTargetDeps = {
      findTab: async () => (over.tab === undefined ? TAB : over.tab),
      hasSession: async () => over.session ?? true,
      status: () => ({ cliState: over.cliState ?? 'busy', permissionRequest: over.permission ? { id: 'p' } : null }) as never,
      halted: () => over.halted ?? false,
      capture: async () => over.pane ?? EMPTY,
      withDispatchLock: async (_ws, _tab, work) => work(async () => ({ ok: true })),
      deliver: async (_s, line) => { delivered.push(line); },
      isPending: async () => false,
    };
    return { d, delivered };
  };
  const ok = async () => ({ ok: true as const });

  it('admits a busy tab with an empty composer, and an idle one', async () => {
    expect(await pointerRefusal(deps().d, 'ws-1', TAB, ok)).toBeNull();
    expect(await pointerRefusal(deps({ cliState: 'idle' }).d, 'ws-1', TAB, ok)).toBeNull();
  });

  it.each([
    ['a native permission prompt', { permission: true }, 'native-prompt-active'],
    ['needs-input', { cliState: 'needs-input' }, 'composer-not-ready:needs-input'],
    ['a startup prompt', { cliState: 'startup-prompt' }, 'composer-not-ready:startup-prompt'],
    ['a usage-limit halt', { halted: true }, 'usage-limit-halt'],
    ['an option list on screen', { pane: 'Proceed?\n❯ 1. Yes\n  2. No\n' }, 'interactive-prompt-active'],
    ['text in the composer', { pane: 'x\n❯ the owner types here\n' }, 'composer-not-empty'],
  ])('refuses %s', async (_name, over, reason) => {
    expect(await pointerRefusal(deps(over).d, 'ws-1', TAB, ok)).toEqual({ code: 'note-point-not-ready', reason });
  });

  it('refuses a failed dispatch policy, a terminal tab, a gone tab and a dead session', async () => {
    const policy = vi.fn(async () => ({ ok: false as const, error: 'agent-model-mismatch' as const, tabId: 'tab-a', modelStatus: {} as never }));
    expect(await pointerRefusal(deps().d, 'ws-1', TAB, policy)).toEqual({ code: 'note-point-not-ready', reason: 'policy:agent-model-mismatch' });
    const shell = { ...TAB, panelType: 'terminal' } as ITab;
    expect(await pointerRefusal(deps({ tab: shell }).d, 'ws-1', shell, ok)).toEqual({ code: 'note-point-not-ready', reason: 'target-not-agent' });
    expect(await pointerRefusal(deps({ tab: null }).d, 'ws-1', TAB, ok)).toEqual({ code: 'tab-not-found', reason: 'target-tab-gone' });
    expect(await pointerRefusal(deps({ session: false }).d, 'ws-1', TAB, ok)).toEqual({ code: 'session-not-running', reason: 'session-not-running' });
  });

  it('the port types inside the dispatch lock and reads the submission', async () => {
    const { d, delivered } = deps();
    const lock = vi.fn(d.withDispatchLock);
    const p = notePointPort({ ...d, withDispatchLock: lock as INotePointTargetDeps['withDispatchLock'] });
    const out = await p.withTarget('ws-1', 'tab-a', async (t) => ((await t.refusal()) ? null : t.type('LINE')));
    expect(out).toEqual({ submitted: true, cliState: 'busy' });
    expect(delivered).toEqual(['LINE']);
    expect(lock).toHaveBeenCalledOnce();
    expect(await notePointPort({ ...d, findTab: async () => null }).withTarget('ws-1', 'tab-a', async () => 1)).toBeNull();
  });
});
