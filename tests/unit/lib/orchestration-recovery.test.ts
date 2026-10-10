import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab, IWorkspaceOrchestration } from '@/types/terminal';
import type { IOrchestrationChange } from '@/lib/orchestration-recovery';

const fixture = vi.hoisted(() => ({ home: '', runtime: vi.fn(), work: vi.fn(), model: vi.fn(), sessions: vi.fn(), rebind: vi.fn() }));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.home }, homedir: () => fixture.home };
});
vi.mock('@/lib/orchestration-runtime', () => ({ observeOrchestrationRuntime: fixture.runtime, candidateModelUsable: fixture.model }));
vi.mock('@/lib/orchestration-work-state', () => ({ readOrchestrationWorkState: fixture.work }));
vi.mock('@/lib/tmux', () => ({ killSession: vi.fn(async () => null), hasSession: vi.fn(async () => false), createSession: vi.fn(async () => undefined), resolveExistingDir: vi.fn(async () => '/tmp'), sendKeys: vi.fn(), listSessions: vi.fn(async () => []), workspaceSessionName: vi.fn(), observeTabSessionsStrict: fixture.sessions }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/mission-control-runtime', () => ({ rebindMissionRunsToOrchestrator: fixture.rebind }));
const file = () => path.join(fixture.home, '.purplemux/workspaces.json');
const layoutFile = () => path.join(fixture.home, '.purplemux/workspaces/ws-a/layout.json');
const tab = (id: string): ITab => ({ id, name: id, sessionName: `session-${id}`, panelType: 'claude-code', order: 0 });
const write = (orchestration?: IWorkspaceOrchestration) => fs.writeFileSync(file(), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'A', directories: ['/tmp'], orchestration }], groups: [] }));
const layout = (tabs: ITab[] = [tab('tab-old'), tab('tab-next')]) => fs.writeFileSync(layoutFile(), JSON.stringify({ root: { type: 'pane', id: 'pane-a', tabs, activeTabId: tabs[0]?.id }, activePaneId: 'pane-a', updatedAt: '2026-10-06' }));
const options = (over: Partial<IOrchestrationChange> = {}): IOrchestrationChange => ({ expectedRevision: 0, mode: 'recover', actor: { kind: 'workspace', workspaceId: 'ws-a', tabId: 'tab-worker', verified: false }, ...over });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const load = () => import('@/lib/orchestration-recovery');
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-recovery-'));
  fs.mkdirSync(path.dirname(layoutFile()), { recursive: true });
  write(); layout();
  fixture.runtime.mockImplementation(async (target: ITab) => target.id === 'tab-old' ? { state: 'absent', reason: 'strict session absence' } : { state: 'present', identity: target.sessionName });
  fixture.work.mockResolvedValue({ state: 'complete', evidence: [], incomplete: false });
  fixture.model.mockResolvedValue(true);
  fixture.sessions.mockResolvedValue({ state: 'present', sessions: ['pt-ws-a-pane-a-tab-missing'] });
  fixture.rebind.mockResolvedValue([]);
  for (const key of ['__purplemuxWorkspacesContentCache', '__ptWorkspacesMemo', '__ptTabTokens', '__ptWorkspaceTokens']) delete (globalThis as Record<string, unknown>)[key];
});
afterEach(() => { fs.rmSync(fixture.home, { recursive: true, force: true }); });

describe('guarded orchestration revision and recovery', () => {
  it('a remote tab is never designated coordinator, before any runtime proof is asked (ADR-0022)', async () => {
    layout([tab('tab-old'), { ...tab('tab-next'), host: 'ai-server' }]);
    const { changeOrchestration } = await load();
    await expect(changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options()))
      .rejects.toMatchObject({ code: 'orchestrator-candidate-invalid', message: expect.stringContaining('remote host ai-server') });
    expect(fixture.runtime.mock.calls.map((c) => (c[0] as ITab).id)).not.toContain('tab-next');
  });

  it('normalizes legacy zero on read without writes and preserves future fields on change', async () => {
    write({ enabled: false, orchestratorTabId: null, future: 'retained' } as IWorkspaceOrchestration);
    const original = fs.readFileSync(file(), 'utf8');
    const store = await import('@/lib/workspace-store');
    expect((await store.getWorkspaceStrict('ws-a')).orchestration?.revision).toBe(0);
    expect(fs.readFileSync(file(), 'utf8')).toBe(original);
    const updated = await (await load()).changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options());
    expect(updated.orchestration).toMatchObject({ revision: 1, future: 'retained', orchestratorTabId: 'tab-next' });
    await store.renameWorkspace('ws-a', 'renamed');
    expect((await store.getWorkspaceStrict('ws-a')).orchestration?.revision).toBe(1);
  });
  it('two writers expecting zero produce one commit; stale identical no-op is refused', async () => {
    const entered = deferred(); const release = deferred();
    fixture.runtime.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'present', identity: 'session-tab-next' }; });
    const { changeOrchestration } = await load();
    const patch = { enabled: true, orchestratorTabId: 'tab-next' };
    const first = changeOrchestration('ws-a', patch, options()); await entered.promise;
    const second = changeOrchestration('ws-a', patch, options());
    const outcomes = Promise.allSettled([first, second]); release.resolve();
    const result = await outcomes;
    expect(result[0].status).toBe('fulfilled'); expect(result[1]).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'orchestration-conflict' } });
    const count = fixture.runtime.mock.calls.length;
    const noop = await changeOrchestration('ws-a', patch, options({ expectedRevision: 1 }));
    expect(noop.orchestration?.revision).toBe(1); expect(fixture.runtime).toHaveBeenCalledTimes(count);
  });
  it('A to B to A retains monotonic revisions and rejects the original ABA revision', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old', revision: 0 });
    fixture.runtime.mockImplementation(async (target: ITab) => ({ state: 'present', identity: target.sessionName }));
    const { changeOrchestration } = await load();
    const human = options({ mode: 'replace', actor: { kind: 'human' } });
    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, human);
    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-old' }, { ...human, expectedRevision: 1 });
    await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-old' }, human)).rejects.toMatchObject({ code: 'orchestration-conflict' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).workspaces[0].orchestration.revision).toBe(2);
  });
  it.each([undefined, -1, 0.5, '0'])('refuses precondition %s before runtime inspection or mutation', async (expectedRevision) => {
    const original = fs.readFileSync(file(), 'utf8');
    await expect((await load()).changeOrchestration('ws-a', { kickoffTemplate: 'changed' }, options({ expectedRevision: expectedRevision as number }))).rejects.toMatchObject({ status: expectedRevision === undefined ? 428 : 400 });
    expect(fixture.runtime).not.toHaveBeenCalled(); expect(fs.readFileSync(file(), 'utf8')).toBe(original);
  });
  it.each(['workspace', 'layout', 'revision'])('fails closed on corrupt %s without backup or mutation', async (corrupt) => {
    if (corrupt === 'workspace') fs.writeFileSync(file(), '{');
    if (corrupt === 'layout') fs.writeFileSync(layoutFile(), '{');
    if (corrupt === 'revision') write({ enabled: false, orchestratorTabId: null, revision: -1 });
    const original = fs.readFileSync(file(), 'utf8');
    await expect((await load()).changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options())).rejects.toMatchObject({ status: corrupt === 'layout' ? 409 : 503 });
    expect(fs.readFileSync(file(), 'utf8')).toBe(original); expect(fs.existsSync(file()+'.bak')).toBe(false);
  });
  it('recovers a positively absent incumbent without changing unrelated data', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    const result = await (await load()).changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options());
    expect(result.orchestration).toMatchObject({ orchestratorTabId: 'tab-next', revision: 1 });
    expect(fs.readdirSync(path.dirname(file())).sort()).toEqual(['workspaces', 'workspaces.json']);
  });
  it.each([{ state: 'present', identity: 'old' }, { state: 'unknown', reason: 'timeout or pending launch' }])('never treats %j as a dead incumbent, even disabled', async (runtime) => {
    write({ enabled: false, orchestratorTabId: 'tab-old' });
    fixture.runtime.mockResolvedValue(runtime);
    await expect((await load()).changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options())).rejects.toMatchObject({ code: runtime.state === 'present' ? 'orchestrator-live' : 'orchestrator-state-unknown' });
    expect(fixture.runtime).toHaveBeenCalledTimes(1);
  });
  it('a missing legacy binding stays unknown, while explicit human replacement retains the old process', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-missing' });
    const { changeOrchestration } = await load();
    await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options())).rejects.toMatchObject({ code: 'orchestrator-state-unknown' });
    expect((await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'replace', actor: { kind: 'human' } }))).orchestration?.revision).toBe(1);
    expect((await import('@/lib/tmux')).killSession).not.toHaveBeenCalled();
  });
  it('recovers a closed incumbent: gone from the layout and no session of it survives', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-closed' });
    fixture.sessions.mockResolvedValue({ state: 'absent', reason: 'no tmux session of the tab survives' });
    const { changeOrchestration } = await load();
    await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'update' }))).rejects.toMatchObject({ code: 'orchestration-recovery-required' });
    const result = await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options());
    expect(result.orchestration).toMatchObject({ orchestratorTabId: 'tab-next', revision: 1 });
    expect(fixture.sessions).toHaveBeenCalledWith('ws-a', 'tab-closed');
  });
  it.each([{ state: 'unknown', reason: 'tmux unavailable' }, { state: 'present', sessions: ['pt-ws-a-pane-x-tab-closed'] }])('keeps a missing incumbent unknown while %j', async (sessions) => {
    write({ enabled: true, orchestratorTabId: 'tab-closed' });
    fixture.sessions.mockResolvedValue(sessions);
    await expect((await load()).changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options())).rejects.toMatchObject({ code: 'orchestrator-state-unknown' });
  });
  it('requires launch-verified incumbent authority for handoff; forged session identity fails', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    fixture.runtime.mockImplementation(async (target: ITab) => ({ state: 'present', identity: target.sessionName }));
    const { changeOrchestration } = await load();
    const actor = { kind: 'workspace' as const, workspaceId: 'ws-a', tabId: 'tab-old', verified: false };
    await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor }))).rejects.toMatchObject({ code: 'orchestrator-live' });
    expect((await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: { ...actor, verified: true } }))).orchestration?.revision).toBe(1);
  });
  it('refuses foreign and global authority before any layout/process inspection', async () => {
    const { changeOrchestration } = await load();
    for (const actor of [{ kind: 'workspace', workspaceId: 'ws-foreign', tabId: 'foreign', verified: true }, { kind: 'admin' }]) {
      await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ actor: actor as IOrchestrationChange['actor'] }))).rejects.toMatchObject({ status: 403 });
    }
    expect(fixture.runtime).not.toHaveBeenCalled(); expect(fixture.work).not.toHaveBeenCalled();
  });
  it.each(['missing', 'browser', 'dead', 'unknown', 'model', 'changed'])('rejects a %s candidate', async (variant) => {
    if (variant === 'missing') layout([]);
    if (variant === 'browser') layout([{ ...tab('tab-next'), panelType: 'web-browser' }]);
    if (variant === 'dead' || variant === 'unknown') fixture.runtime.mockResolvedValue({ state: variant === 'dead' ? 'absent' : 'unknown', reason: variant });
    if (variant === 'model') fixture.model.mockResolvedValue(false);
    if (variant === 'changed') fixture.runtime.mockResolvedValueOnce({ state: 'present', identity: 'first' }).mockResolvedValueOnce({ state: 'present', identity: 'second' });
    await expect((await load()).changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options())).rejects.toMatchObject({ status: 409 });
  });
  it.each(['remaining', 'unknown'])('refuses clear/off when fresh classifier says %s', async (state) => {
    write({ enabled: true, orchestratorTabId: 'tab-old' }); fixture.work.mockResolvedValue({ state, evidence: ['awaiting-human or unresolved work'], incomplete: state === 'unknown' });
    const { changeOrchestration } = await load();
    for (const patch of [{ enabled: false }, { orchestratorTabId: null }]) await expect(changeOrchestration('ws-a', patch, options())).rejects.toMatchObject({ code: 'orchestration-work-remains' });
  });
  it('allows finished work to disable and leaves the mapping evidence intact', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    const result = await (await load()).changeOrchestration('ws-a', { enabled: false }, options());
    expect(result.orchestration).toMatchObject({ enabled: false, orchestratorTabId: 'tab-old', revision: 1 });
    expect(fixture.work).toHaveBeenCalledTimes(1);
  });
  it('a stale human start creates nothing; persistence failure reports an undesignated tab', async () => {
    const { startOrchestrationTransaction } = await load(); const create = vi.fn(async () => tab('tab-new'));
    await expect(startOrchestrationTransaction('ws-a', options({ expectedRevision: 1, actor: { kind: 'human' } }), undefined, create)).rejects.toMatchObject({ code: 'orchestration-conflict' });
    expect(create).not.toHaveBeenCalled();
    create.mockImplementation(async () => { fs.mkdirSync(file()+'.tmp'); return tab('tab-new'); });
    await expect(startOrchestrationTransaction('ws-a', options({ actor: { kind: 'human' } }), undefined, create)).rejects.toMatchObject({ code: 'orchestration-persist-failed', undesignatedTabId: 'tab-new' });
  });
  it('close and restart wait behind recovery observation/commit, without nested lock acquisition', async () => {
    const { changeOrchestration } = await load(); const entered = deferred(); const release = deferred();
    fixture.runtime.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'present', identity: 'session-tab-next' }; });
    const change = changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options()); await entered.promise;
    const { closeTab, restartTabSession } = await import('@/lib/layout-store');
    const closed = closeTab('ws-a', 'pane-a', 'tab-old'); const restarted = restartTabSession('ws-a', 'pane-a', 'tab-next');
    await Promise.resolve(); expect((await import('@/lib/tmux')).killSession).not.toHaveBeenCalled(); expect((await import('@/lib/tmux')).createSession).not.toHaveBeenCalled();
    release.resolve(); await change; await Promise.all([closed, restarted]);
    expect((await import('@/lib/tmux')).killSession).toHaveBeenCalled();
  });
});

it.each(['pane-close', 'workspace-delete'])('%s cannot cross recovery validation and commit', async (operation) => {
  if (operation === 'pane-close') fs.writeFileSync(layoutFile(), JSON.stringify({ root: { type: 'split', direction: 'horizontal', ratio: 0.5, children: [
    { type: 'pane', id: 'pane-a', tabs: [tab('tab-old')], activeTabId: 'tab-old' },
    { type: 'pane', id: 'pane-b', tabs: [tab('tab-next')], activeTabId: 'tab-next' },
  ] }, activePaneId: 'pane-b' }));
  const entered = deferred(); const release = deferred();
  fixture.runtime.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'present', identity: 'session-tab-next' }; });
  const changing = (await load()).changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options());
  await entered.promise;
  let finished = false;
  const lifecycle = operation === 'pane-close'
    ? (await import('@/lib/layout-store')).closePaneInLayout('ws-a', 'pane-b')
    : (await import('@/lib/workspace-store')).deleteWorkspace('ws-a');
  const completion = lifecycle.then(() => { finished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false); expect((await import('@/lib/tmux')).killSession).not.toHaveBeenCalled();
  release.resolve(); await changing; await completion;
  expect(finished).toBe(true); expect((await import('@/lib/tmux')).killSession).toHaveBeenCalled();
});

describe('a committed coordinator change rebinds the workspace Mission Control runs', () => {
  const verifiedIncumbent = { kind: 'workspace' as const, workspaceId: 'ws-a', tabId: 'tab-old', verified: true };
  const bothLive = () => fixture.runtime.mockImplementation(async (target: ITab) => ({ state: 'present', identity: target.sessionName }));

  it('a verified handoff reports the new coordinator with cause handoff, after the commit', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' }); bothLive();
    fixture.rebind.mockImplementation(async () => {
      expect(JSON.parse(fs.readFileSync(file(), 'utf8')).workspaces[0].orchestration).toMatchObject({ orchestratorTabId: 'tab-next', revision: 1 });
      return [];
    });
    await (await load()).changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verifiedIncumbent }));
    expect(fixture.rebind.mock.calls).toEqual([['ws-a', 'tab-next', 'handoff']]);
  });
  it('an own-workspace recovery reports cause recover, and a human replacement cause replace', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    const { changeOrchestration } = await load();
    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options());
    bothLive();
    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-old' }, options({ mode: 'replace', actor: { kind: 'human' }, expectedRevision: 1 }));
    expect(fixture.rebind.mock.calls).toEqual([['ws-a', 'tab-next', 'recover'], ['ws-a', 'tab-old', 'replace']]);
  });
  it('the first designation of a coordinator reports cause recover', async () => {
    await (await load()).changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options());
    expect(fixture.rebind.mock.calls).toEqual([['ws-a', 'tab-next', 'recover']]);
  });
  it('reports nothing when the commit is refused, only the template changes, a human saves the same tab, or orchestration is switched off', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' }); bothLive();
    const { changeOrchestration } = await load();
    await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options())).rejects.toMatchObject({ code: 'orchestrator-live' });
    await expect(changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verifiedIncumbent, expectedRevision: 7 }))).rejects.toMatchObject({ code: 'orchestration-conflict' });
    await expect(changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-old' }, options({ expectedRevision: 7 }))).rejects.toMatchObject({ code: 'orchestration-conflict' });
    await changeOrchestration('ws-a', { kickoffTemplate: 'changed' }, options());
    await changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-old' }, options({ mode: 'update', actor: { kind: 'human' }, expectedRevision: 1 }));
    await changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-old' }, options({ mode: 'replace', actor: { kind: 'human' }, expectedRevision: 1 }));
    await changeOrchestration('ws-a', { enabled: false }, options({ expectedRevision: 1 }));
    await changeOrchestration('ws-a', { enabled: false, orchestratorTabId: 'tab-old' }, options({ expectedRevision: 2 }));
    expect(fixture.rebind).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).workspaces[0].orchestration).toMatchObject({ enabled: false, orchestratorTabId: 'tab-old', revision: 2 });
  });
  it('a handoff or recovery that names the coordinator already in place re-asserts it without a mapping change', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' }); bothLive();
    const { changeOrchestration } = await load();
    const again = { enabled: true, orchestratorTabId: 'tab-old' };
    expect((await changeOrchestration('ws-a', again, options({ mode: 'handoff', actor: verifiedIncumbent }))).orchestration?.revision).toBe(0);
    expect((await changeOrchestration('ws-a', again, options())).orchestration?.revision).toBe(0);
    expect(fixture.rebind.mock.calls).toEqual([['ws-a', 'tab-old', 'handoff'], ['ws-a', 'tab-old', 'recover']]);
    expect(fixture.runtime).not.toHaveBeenCalled();
  });
  it('a failing Mission Control rebind never fails or undoes the committed handoff', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' }); bothLive();
    fixture.rebind.mockRejectedValue(new Error('mission storage unavailable'));
    const updated = await (await load()).changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verifiedIncumbent }));
    expect(updated.orchestration).toMatchObject({ orchestratorTabId: 'tab-next', revision: 1 });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).workspaces[0].orchestration.orchestratorTabId).toBe('tab-next');
    expect(fixture.rebind).toHaveBeenCalledTimes(1);
  });
  it('a human start reports the tab it created, and nothing when its commit fails', async () => {
    const { startOrchestrationTransaction } = await load();
    const started = await startOrchestrationTransaction('ws-a', options({ mode: 'update', actor: { kind: 'human' } }), undefined, async () => tab('tab-new'));
    expect(started.workspace.orchestration).toMatchObject({ orchestratorTabId: 'tab-new', revision: 1 });
    expect(fixture.rebind.mock.calls).toEqual([['ws-a', 'tab-new', 'recover']]);
    fixture.rebind.mockClear();
    await expect(startOrchestrationTransaction('ws-a', options({ expectedRevision: 1, mode: 'replace', actor: { kind: 'human' } }), undefined, async () => { fs.mkdirSync(file()+'.tmp'); return tab('tab-newer'); }))
      .rejects.toMatchObject({ code: 'orchestration-persist-failed' });
    expect(fixture.rebind).not.toHaveBeenCalled();
  });
});
