import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ICaller } from '@/lib/caller';
import { LedgerStore } from '@/lib/ledger-store';
import { TurnEndService, type ITurnEndTab } from '@/lib/turn-end-service';
import { fsEvidenceReader } from '@/lib/worker-event-validators';
import type { IEventScope } from '@/types/worker-event';

// `purplemux done` (F6, F10 step 2; design check (2) ruling (5), (8)): checked at write time with range, gate-verdict
// and gate-tree, against a real git work tree and gate log.

const T0 = Date.UTC(2026, 10, 10, 2, 0, 0);
const S = 'sess-w';

const caller = (over: Partial<ICaller> = {}): ICaller => ({
  scope: { type: 'workspace', workspaceId: 'ws-1' } as ICaller['scope'], workspaceId: 'ws-1', tabId: 'tab-w', tabName: 'w',
  verified: true, identity: 'launch', admin: false, ...over,
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

describe('TurnEndService.done', () => {
  let dir: string;
  let repo: string;
  let head: string;
  let tree: string;
  let store: LedgerStore;
  let tab: ITurnEndTab | null;
  let scope: IEventScope | null;

  const service = () => new TurnEndService({
    now: () => T0,
    table: () => store.turnEnds,
    tab: () => tab,
    scopeOf: async () => scope,
    roots: async () => [fs.realpathSync(dir)],
    reader: fsEvidenceReader,
  });

  const gateLog = (lines: string[]) => {
    const file = path.join(dir, `gate-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const valid = () => gateLog(['START=1', `GIT_TREE_END=${tree}`, 'SETTLED=yes', 'VERDICT=VALID']);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-done-'));
    repo = path.join(dir, 'wt');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'feature/x');
    git(repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
    head = git(repo, 'rev-parse', 'HEAD');
    tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    store = new LedgerStore(':memory:');
    store.turnEnds.bumpTurn(S, T0);
    tab = { workspaceId: 'ws-1', panelType: 'claude-code', host: undefined, agentSessionId: S };
    scope = { workspaceId: 'ws-1', tabId: 'tab-w', epic: 'e', story: 'F6', dependsOn: [], attempt: 2, declaredBy: { workspaceId: 'ws-1', tabId: 'tab-o' }, declaredAt: T0 };
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a builder DONE with a valid gate log: head defaults to the branch tip, the gate verdict is kept', async () => {
    const row = await service().done(caller(), { verdict: 'DONE', reason: 'shipped', gateLog: valid(), cwd: repo });
    expect(row).toMatchObject({ sessionId: S, turnId: 1, seatRole: 'builder', story: 'F6', attempt: 2, verdict: 'DONE', head, gateVerdict: 'VALID', source: 'done' });
    expect(store.turnEnds.unconsumed(S, 1)).toMatchObject({ verdict: 'DONE', head });
  });

  it('F10 AC3: refuses a gate log whose GIT_TREE_END is not the tree of head, with measured and expected values', async () => {
    const stale = gateLog(['START=1', `GIT_TREE_END=${'0'.repeat(40)}`, 'SETTLED=yes', 'VERDICT=VALID']);
    await expect(service().done(caller(), { verdict: 'DONE', gateLog: stale, cwd: repo })).rejects.toMatchObject({
      code: 'turn-end-refused', message: expect.stringContaining(`gate-tree: measured GIT_TREE_END=${'0'.repeat(40)}; expected GIT_TREE_END=${tree}`),
    });
    expect(store.turnEnds.unconsumed(S, 1)).toBeNull();
  });

  it('refuses a red or unsettled gate, and a head that is not the branch tip', async () => {
    const red = gateLog(['START=1', `GIT_TREE_END=${tree}`, 'SETTLED=yes', 'VERDICT=RED']);
    await expect(service().done(caller(), { verdict: 'DONE', gateLog: red, cwd: repo })).rejects.toMatchObject({ message: expect.stringContaining('gate-verdict') });
    await expect(service().done(caller(), { verdict: 'BLOCKED', reason: 'x', head: 'b'.repeat(40), cwd: repo }))
      .rejects.toMatchObject({ message: expect.stringContaining('range: measured refs/heads/feature/x=') });
  });

  it('a builder DONE or READY-TO-MERGE needs a gate log; a reviewer seat does not (ruling (8))', async () => {
    await expect(service().done(caller(), { verdict: 'DONE', cwd: repo })).rejects.toMatchObject({ code: 'turn-end-invalid', message: expect.stringContaining('gateLog: measured none') });
    await expect(service().done(caller(), { verdict: 'READY-TO-MERGE', cwd: repo })).rejects.toMatchObject({ code: 'turn-end-invalid' });
    scope = { ...scope!, seat: 'reviewer' };
    await expect(service().done(caller(), { verdict: 'DONE', reason: 'PASS', cwd: repo })).resolves.toMatchObject({ seatRole: 'reviewer', gateLog: null });
    scope = null;
    await expect(service().done(caller(), { verdict: 'DONE', cwd: repo })).resolves.toMatchObject({ seatRole: null });
  });

  it('BLOCKED and NEEDS-DECISION need a reason; a reason with a marker word is refused', async () => {
    await expect(service().done(caller(), { verdict: 'BLOCKED', cwd: repo })).rejects.toMatchObject({ message: expect.stringContaining('reason: measured none') });
    await expect(service().done(caller(), { verdict: 'NEEDS-DECISION', reason: 'see DONE: above', cwd: repo }))
      .rejects.toMatchObject({ message: expect.stringContaining('holds the turn marker DONE:') });
    await expect(service().done(caller(), { verdict: 'NEEDS-DECISION', reason: 'A or B?\nnew line', cwd: repo }))
      .resolves.toMatchObject({ verdict: 'NEEDS-DECISION', reason: 'A or B? new line' });
  });

  it('refuses another story than the scope\'s, an unknown verdict, a remote tab, no session and no turn', async () => {
    await expect(service().done(caller(), { verdict: 'CHECKPOINTED', story: 'F7', cwd: repo })).rejects.toMatchObject({ message: expect.stringContaining('expected F6') });
    await expect(service().done(caller(), { verdict: 'FINISHED', cwd: repo })).rejects.toMatchObject({ code: 'turn-end-invalid' });
    tab = { ...tab!, host: 'remote-1' };
    await expect(service().done(caller(), { verdict: 'CHECKPOINTED', cwd: repo })).rejects.toMatchObject({ code: 'forbidden' });
    tab = { ...tab, host: undefined, agentSessionId: null };
    await expect(service().done(caller(), { verdict: 'CHECKPOINTED', cwd: repo })).rejects.toMatchObject({ code: 'turn-end-no-turn' });
    tab = { ...tab, agentSessionId: 'never-prompted' };
    await expect(service().done(caller(), { verdict: 'CHECKPOINTED', cwd: repo })).rejects.toMatchObject({ code: 'turn-end-no-turn' });
    await expect(service().done(caller({ tabId: null }), { verdict: 'CHECKPOINTED', cwd: repo })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a gate log outside the workspace roots and a cwd outside a git work tree', async () => {
    const outside = path.join(os.tmpdir(), `pmux-outside-${process.pid}.log`);
    fs.writeFileSync(outside, `GIT_TREE_END=${tree}\nSETTLED=yes\nVERDICT=VALID\n`);
    try {
      await expect(service().done(caller(), { verdict: 'DONE', gateLog: outside, cwd: repo })).rejects.toMatchObject({ message: expect.stringContaining('evidence-paths') });
    } finally {
      fs.rmSync(outside, { force: true });
    }
    await expect(service().done(caller(), { verdict: 'DONE', gateLog: valid(), cwd: dir })).rejects.toMatchObject({ message: expect.stringContaining('not inside a git work tree') });
  });

  it('a second done in the same turn replaces the first; after its stop used it, the turn is closed', async () => {
    await service().done(caller(), { verdict: 'CHECKPOINTED', cwd: repo });
    await service().done(caller(), { verdict: 'BLOCKED', reason: 'red', cwd: repo });
    expect(store.turnEnds.unconsumed(S, 1)).toMatchObject({ verdict: 'BLOCKED' });
    store.turnEnds.consume(S, 1, T0 + 1);
    await expect(service().done(caller(), { verdict: 'CHECKPOINTED', cwd: repo })).rejects.toMatchObject({ code: 'turn-end-refused' });
  });
});
