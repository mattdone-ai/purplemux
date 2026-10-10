import fs from 'fs/promises';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITab } from '@/types/terminal';

const fixture = vi.hoisted(() => ({ home: '', now: 1000, send: vi.fn(), type: vi.fn(), submit: vi.fn(), reap: vi.fn(), session: vi.fn(), process: vi.fn(), write: vi.fn(), spawn: vi.fn() }));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.home }, homedir: () => fixture.home };
});
vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => fixture.spawn(...args) }));
vi.mock('@/lib/tmux', async (original) => ({
  ...await original<typeof import('@/lib/tmux')>(),
  exitCopyMode: vi.fn(async () => undefined), hasSession: vi.fn(async () => true), hasSessionOrUnreachable: vi.fn(async () => true), sessionPresence: vi.fn(async () => 'present'), isContentPendingInComposer: vi.fn(async () => false), createSession: vi.fn(async () => undefined), resolveExistingDir: vi.fn(async () => '/tmp'),
  sendKeys: fixture.send, sendTypedText: fixture.type, sendBracketedPasteText: fixture.type, submitComposer: fixture.submit,
  killSession: fixture.reap, observeSessionStrict: fixture.session,
}));
vi.mock('@/lib/process-utils', async (original) => ({ ...await original<typeof import('@/lib/process-utils')>(), observeProviderProcess: fixture.process }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ isOrchestrationLaunchPending: () => false, isWaitingAtPrompt: () => true, markAgentLaunch: vi.fn(), getAllForClient: () => ({ 'tab-old': { workspaceId: 'ws-a', cliState: 'idle' } }) }) }));
vi.mock('@/lib/lease-store', () => ({ readLeaseEvidence: vi.fn(async () => ({ known: true, leases: [] })) }));
vi.mock('@/lib/standup-store', () => ({ readLatestStandupEvidence: vi.fn(async () => ({ known: true, standup: { state: 'done' } })) }));
vi.mock('@/lib/liveness-store', () => ({ readLivenessEvidence: vi.fn(async () => ({ known: true, data: { jobs: [] } })) }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
const SESSION = 'pt-ws-a-pane-a-tab-old';
const file = () => path.join(fixture.home, '.purplemux/workspaces/ws-a/layout.json');
const readTab = async (): Promise<ITab> => JSON.parse(await fs.readFile(file(), 'utf8')).root.tabs[0];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const options = { expectedRevision: 0, mode: 'recover' as const, actor: { kind: 'workspace' as const, workspaceId: 'ws-a', tabId: 'tab-next', verified: false } };
let layout: typeof import('@/lib/layout-store');
let activity: typeof import('@/lib/orchestration-activity');
let recovery: typeof import('@/lib/orchestration-recovery');
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-activity-'));
  fixture.now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify({ root: { type: 'pane', id: 'pane-a', activeTabId: 'tab-old', tabs: [
    { id: 'tab-old', name: 'Old', order: 0, panelType: 'claude-code', sessionName: SESSION },
    { id: 'tab-next', name: 'Next', order: 1, panelType: 'claude-code', sessionName: 'pt-ws-a-pane-a-tab-next' },
  ] }, activePaneId: 'pane-a' }));
  await fs.writeFile(path.join(fixture.home, '.purplemux/workspaces.json'), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'A', directories: [], orchestration: { enabled: true, orchestratorTabId: 'tab-old', revision: 0 } }], groups: [] }));
  for (const key of ['__purplemuxWorkspacesContentCache', '__ptWorkspacesMemo']) delete (globalThis as Record<string, unknown>)[key];
  fixture.send.mockResolvedValue(undefined); fixture.type.mockResolvedValue(undefined); fixture.submit.mockResolvedValue(undefined);
  fixture.spawn.mockImplementation(() => ({ pid: 42, write: fixture.write, resize: vi.fn(), destroy: vi.fn(), onData: () => ({ dispose: vi.fn() }), onExit: () => ({ dispose: vi.fn() }) }));
  fixture.reap.mockResolvedValue({ reaper: 'linux', envMarker: 'present', killed: [], survivors: [] });
  fixture.session.mockResolvedValue({ state: 'absent', reason: 'exact session absent' });
  fixture.process.mockResolvedValue({ state: 'present', identity: 'provider:123:456' });
  layout = await import('@/lib/layout-store'); activity = await import('@/lib/orchestration-activity');
  recovery = await import('@/lib/orchestration-recovery');
  vi.spyOn(await import('@/lib/human-mutation'), 'authorizeHumanMutation').mockResolvedValue(true);
  vi.spyOn(await import('@/lib/cli-utils'), 'authorizeWorkspaceInput').mockResolvedValue({ type: 'workspace', workspaceId: 'ws-a' });
});
afterEach(async () => { for (const socket of sockets.splice(0)) socket.emit('close'); vi.unstubAllGlobals(); vi.restoreAllMocks(); await fs.rm(fixture.home, { recursive: true, force: true }); });

describe('persisted pending lifecycle evidence through real layout and recovery services', () => {
  it('queues restart only after durable launch intent; shell absence cannot permit recovery after module reload', async () => {
    fixture.send.mockImplementation(async () => { expect((await readTab()).orchestrationActivity?.launch).toEqual({ at: 1000 }); });
    vi.mocked((await import('@/lib/tmux')).hasSession).mockResolvedValueOnce(false);
    await layout.restartTabSession('ws-a', 'pane-a', 'tab-old', 'sleep 1; claude');
    vi.resetModules();
    const { observeOrchestrationRuntime } = await import('@/lib/orchestration-runtime');
    expect(await observeOrchestrationRuntime(await readTab())).toMatchObject({ state: 'unknown' });
    await expect(recovery.changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options)).rejects.toMatchObject({ code: 'orchestrator-state-unknown' });
    expect(fixture.send).toHaveBeenCalledOnce();
  });
  it('does not queue restart when durable marker persistence fails', async () => {
    vi.mocked((await import('@/lib/tmux')).hasSession).mockResolvedValueOnce(false);
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(layout.restartTabSession('ws-a', 'pane-a', 'tab-old', 'claude')).rejects.toThrow('disk unavailable');
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it('pending submitted turn blocks an already queued off writer before any busy hook arrives', async () => {
    const entered = deferred(); const release = deferred();
    fixture.submit.mockImplementation(async () => { expect((await readTab()).orchestrationActivity?.turn).toBeDefined(); entered.resolve(); await release.promise; });
    const { default: send } = await import('@/pages/api/cli/tabs/[tabId]/send');
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const delivery = send({ method: 'POST', query: { workspaceId: 'ws-a', tabId: 'tab-old' }, body: { content: 'work', waitMs: 0 } } as unknown as NextApiRequest, response as unknown as NextApiResponse);
    await Promise.race([entered.promise, delivery.then(() => { throw new Error(`Send returned before submission: ${JSON.stringify(response.json.mock.calls)}`); })]);
    const off = recovery.changeOrchestration('ws-a', { enabled: false }, options);
    const denied = expect(off).rejects.toMatchObject({ code: 'orchestration-work-remains' });
    release.resolve(); await delivery; await denied;
    expect(response.status).toHaveBeenCalledWith(200);
  });
  it('persists before any prompt bytes and retains uncertain text or Enter delivery', async () => {
    const { deliverPrompt } = await import('@/lib/agent-prompt-delivery');
    fixture.type.mockRejectedValueOnce(new Error('text failed'));
    await expect(deliverPrompt(SESSION, 'work')).rejects.toThrow('text failed');
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined(); expect(fixture.submit).not.toHaveBeenCalled();
    fixture.submit.mockRejectedValueOnce(new Error('transport failed after write'));
    await expect(deliverPrompt(SESSION, 'work')).rejects.toThrow('transport failed after write');
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    await expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
  });
  it('requires current prompt-submit then a later stop/interrupt; session-start and time do not complete work', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1001);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 1002);
    fixture.now = 1_000_000;
    expect((await readTab()).orchestrationActivity?.turn?.runningAt).toBeUndefined();
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1003);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1002);
    expect((await readTab()).orchestrationActivity?.turn).toMatchObject({ runningAt: 1003 });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'interrupt', 1004);
    expect((await readTab()).orchestrationActivity?.turn).toBeUndefined();
  });
  it('old stop/replay cannot erase a newer submission or cross a restart generation', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    const first = (await readTab()).orchestrationActivity!.turn!.generation;
    fixture.now = 2000; await activity.recordOrchestrationSubmission(SESSION);
    expect((await readTab()).orchestrationActivity!.turn!.generation).not.toBe(first);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1500);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 2001);
    fixture.now = 3000; await activity.recordOrchestrationLaunch('ws-a', 'tab-old', SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 3002);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 3003);
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    fixture.now = 4000; await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 3002);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 4001);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 4002);
    expect((await readTab()).orchestrationActivity?.turn).toBeUndefined();
  });
  it('an acknowledgment whose process probe finishes after a newer submission cannot clear it', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    const entered = deferred(); const release = deferred();
    fixture.process.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'present', identity: 'provider:123:456' }; });
    const stopped = activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1002);
    await entered.promise;
    fixture.now = 2000; await activity.recordOrchestrationSubmission(SESSION);
    const newer = (await readTab()).orchestrationActivity!.turn!.generation;
    release.resolve(); await stopped;
    expect((await readTab()).orchestrationActivity?.turn?.generation).toBe(newer);
  });
  it('session-name reuse or changed provider process cannot acknowledge the previous running turn', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    fixture.process.mockResolvedValue({ state: 'present', identity: 'provider:123:999' });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1002);
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
  });
  it('launch acknowledgment requires a new strict provider identity, and cannot turn an unknown prior identity into proof', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationLaunch('ws-a', 'tab-old', SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 1001);
    expect((await readTab()).orchestrationActivity?.launch).toBeDefined();
    fixture.process.mockResolvedValue({ state: 'present', identity: 'provider:123:999' });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 1002);
    expect((await readTab()).orchestrationActivity?.launch).toBeUndefined();
    fixture.process.mockResolvedValueOnce({ state: 'unknown', reason: 'unreadable process' });
    fixture.now = 2000; await activity.recordOrchestrationLaunch('ws-a', 'tab-old', SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 2001);
    expect((await readTab()).orchestrationActivity?.launch).toMatchObject({ priorUnknown: true });
  });
  it('client metadata cannot erase pending evidence or hide it by changing the panel type', async () => {
    await activity.recordOrchestrationSubmission(SESSION);
    await layout.patchTab('ws-a', 'pane-a', 'tab-old', { panelType: 'terminal', orchestrationActivity: undefined } as Parameters<typeof layout.patchTab>[3]);
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    await expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
  });
  it('only confirmed close/reap abandons uncertain work; newer restart waits behind the close', async () => {
    await activity.recordOrchestrationSubmission(SESSION);
    await expect(layout.closeTab('ws-a', 'pane-a', 'tab-old', { keepProcesses: true })).rejects.toThrow('confirmed process reap');
    fixture.session.mockResolvedValueOnce({ state: 'unknown', reason: 'tmux timeout' });
    await expect(layout.closeTab('ws-a', 'pane-a', 'tab-old')).rejects.toThrow('unconfirmed');
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    const entered = deferred(); const release = deferred();
    fixture.reap.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { reaper: 'linux', survivors: [], killed: [] }; });
    const closing = layout.closeTab('ws-a', 'pane-a', 'tab-old'); await entered.promise;
    const restart = layout.restartTabSession('ws-a', 'pane-a', 'tab-old', 'claude');
    release.resolve(); expect(await closing).toMatchObject({ ok: true }); expect(await restart).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});

const sockets: EventEmitter[] = [];
const connectRaw = async () => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
  sockets.push(socket);
  const { handleConnection } = await import('@/lib/terminal-server');
  await handleConnection(socket as unknown as WebSocket, { url: '/api/terminal' } as IncomingMessage, SESSION);
  return socket;
};
const emitRaw = (socket: EventEmitter, data: string, type = 0) => socket.emit('message', Buffer.concat([Buffer.from([type]), Buffer.from(data)]));
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis(), setHeader: vi.fn() });

describe('real non-Codex browser launch preparation', () => {
  it.each(['terminal', 'agent-sessions'] as const)('atomically prepares Claude while the optimistic %s PATCH has not reached the server', async (panelType) => {
    await layout.patchTab('ws-a', 'pane-a', 'tab-old', { panelType });
    const { claudeProvider } = await import('@/lib/providers/claude');
    vi.spyOn(claudeProvider, 'buildLaunchCommand').mockResolvedValue('claude');
    vi.spyOn(await import('@/lib/agent-availability'), 'checkAgentAvailabilityForPanelType').mockResolvedValue({ ok: true, provider: null });
    const { default: launch } = await import('@/pages/api/claude/launch-command');
    const res = response();
    await launch({ method: 'POST', headers: {}, body: { workspaceId: 'ws-a', tabId: 'tab-old' } } as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(await readTab()).toMatchObject({ panelType: 'claude-code', orchestrationActivity: { launch: { at: 1000 } } });
    vi.resetModules(); // No in-memory status marker survives this restart.
    expect(await (await import('@/lib/orchestration-runtime')).observeOrchestrationRuntime(await readTab())).toMatchObject({ state: 'unknown' });
    await expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
  });
  it('Grok launch preparation survives an actual failed optimistic PATCH and refuses a failed atomic launch write', async () => {
    await layout.patchTab('ws-a', 'pane-a', 'tab-old', { panelType: 'agent-sessions' });
    const { default: patch } = await import('@/pages/api/layout/pane/[paneId]/tabs/[tabId]');
    const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('PATCH failed'));
    await expect(patch({ method: 'PATCH', query: { workspace: 'ws-a', paneId: 'pane-a', tabId: 'tab-old' }, body: { panelType: 'grok-cli' } } as unknown as NextApiRequest, response() as unknown as NextApiResponse)).rejects.toThrow('PATCH failed');
    write.mockRestore();
    const { default: launch } = await import('@/pages/api/status/agent-launch');
    const req = { method: 'POST', body: { tabId: 'tab-old', panelType: 'grok-cli' } } as NextApiRequest;
    const res = response();
    await launch(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(await readTab()).toMatchObject({ panelType: 'grok-cli', orchestrationActivity: { launch: { at: 1000 } } });
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('launch write failed'));
    const refused = response();
    await expect(launch(req, refused as unknown as NextApiResponse)).rejects.toThrow('launch write failed');
    expect(refused.status).not.toHaveBeenCalledWith(204);
  });
});

describe('actual authenticated app send and raw WebSocket paths', () => {
  it('attaches the PTY through the server-owned tmux socket without restoring tab identity', async () => {
    await connectRaw();
    const options = fixture.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.TMUX_TMPDIR).toBe(process.env.TMUX_TMPDIR);
    expect(options?.env?.PMUX_TAB_ID).toBeUndefined();
    expect(options?.env?.PMUX_TAB_TOKEN).toBeUndefined();
    expect(options?.env?.PMUX_WORKSPACE_ID).toBeUndefined();
  });
  it('visibly refuses input received before tmux attachment and never replays it', async () => {
    const attach = deferred();
    vi.mocked((await import('@/lib/tmux')).hasSession).mockImplementationOnce(async () => { await attach.promise; return true; });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    sockets.push(socket);
    const { handleConnection } = await import('@/lib/terminal-server');
    const connecting = handleConnection(socket as unknown as WebSocket, { url: '/api/terminal' } as IncomingMessage, SESSION);
    emitRaw(socket, 'too early');
    expect(fixture.write).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
    const refusal = socket.send.mock.calls[0][0] as Uint8Array;
    expect(refusal[0]).toBe(6);
    expect(new TextDecoder().decode(refusal.slice(1))).toContain('not sent');
    expect((await readTab()).orchestrationActivity).toBeUndefined();
    attach.resolve();
    await connecting;
    expect(fixture.write).not.toHaveBeenCalled();
    emitRaw(socket, 'after attach');
    await vi.waitFor(() => expect(fixture.write).toHaveBeenCalledWith('after attach'));
    expect(fixture.write).not.toHaveBeenCalledWith('too early');
  });
  it.each(['prompt', 'attachment-only'] as const)('app %s persists before bytes/Enter and blocks a queued off writer', async (kind) => {
    const { default: send } = await import('@/pages/api/tabs/[tabId]/send');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url, 'http://localhost');
      const res = response();
      await send({ method: 'POST', query: { workspaceId: parsed.searchParams.get('workspaceId'), tabId: 'tab-old' }, body: JSON.parse(init.body as string) } as unknown as NextApiRequest, res as unknown as NextApiResponse);
      return { ok: res.status.mock.calls.at(-1)?.[0] === 200, status: res.status.mock.calls.at(-1)?.[0] };
    }));
    const { sendWebPrompt } = await import('@/lib/web-prompt-client');
    const target = { workspaceId: 'ws-a', tabId: 'tab-old', sessionName: SESSION };
    if (kind === 'attachment-only') {
      await sendWebPrompt(target, '/tmp/image.png', { submit: false, literalPaste: true });
      expect((await readTab()).orchestrationActivity?.turn?.rawInput).toBe(true);
    }
    const entered = deferred(); const release = deferred();
    fixture.type.mockImplementation(async () => { expect((await readTab()).orchestrationActivity?.turn).toBeDefined(); });
    fixture.submit.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const sending = sendWebPrompt(target, kind === 'prompt' ? 'new work' : '');
    await Promise.race([entered.promise, sending.then(() => { throw new Error('app send did not reach submission'); })]);
    const off = expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
    release.resolve(); await sending; await off;
  });
  it('raw frames retain order, coalesce durable writes, and prevent queued off against stale done', async () => {
    const socket = await connectRaw();
    const entered = deferred(); const release = deferred();
    const original = fs.writeFile.bind(fs);
    const writes = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    const forwarded: string[] = [];
    const all = deferred(); fixture.write.mockImplementation((data: string) => { forwarded.push(data); if (forwarded.length === 3) all.resolve(); });
    emitRaw(socket, 'a'); await entered.promise;
    const off = expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
    emitRaw(socket, '\x1b[A', 5); emitRaw(socket, '\r');
    expect(forwarded).toEqual([]); release.resolve(); await all.promise; await off;
    expect(forwarded).toEqual(['a', '\x1b[A', '\r']);
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await readTab()).orchestrationActivity?.turn).toMatchObject({ rawInput: true });
  });
  it('a previous in-flight stop cannot clear later raw input; only its own accepted chain can', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    const socket = await connectRaw(); const forwarded = deferred(); fixture.write.mockImplementation(() => forwarded.resolve());
    fixture.now = 2000; emitRaw(socket, '\x1b'); await forwarded.promise;
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 2001);
    expect((await readTab()).orchestrationActivity?.turn).toMatchObject({ rawInput: true });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 2002);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'interrupt', 2003);
    expect((await readTab()).orchestrationActivity?.turn).toBeUndefined();
  });
  it('new raw input during delayed prompt acknowledgment cannot coalesce into the old accepted turn', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    const socket = await connectRaw();
    let forwarded = deferred(); fixture.write.mockImplementation(() => forwarded.resolve());
    emitRaw(socket, 'first'); await forwarded.promise;
    const old = (await readTab()).orchestrationActivity!.turn!.generation;
    const entered = deferred(); const release = deferred();
    fixture.process.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'present', identity: 'provider:123:456' }; });
    const accepted = activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    await entered.promise;
    fixture.now = 2000; forwarded = deferred(); emitRaw(socket, 'new input'); await forwarded.promise;
    expect((await readTab()).orchestrationActivity!.turn!.generation).not.toBe(old);
    release.resolve(); await accepted;
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 2001);
    expect((await readTab()).orchestrationActivity?.turn).toMatchObject({ rawInput: true, at: 2000 });
  });
  it('raw persistence refusal sends a visible protocol error and forwards no bytes', async () => {
    const socket = await connectRaw(); const error = deferred(); socket.send.mockImplementation(() => error.resolve());
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    emitRaw(socket, 'work\r'); await error.promise;
    expect(fixture.write).not.toHaveBeenCalled();
    expect(socket.send.mock.calls[0][0][0]).toBe(6);
    expect(new TextDecoder().decode(socket.send.mock.calls[0][0].slice(1))).toContain('not confirmed');
  });
  it('ordinary nonagent terminal bytes are unchanged; resize and heartbeat do not record activity', async () => {
    await layout.patchTab('ws-a', 'pane-a', 'tab-old', { panelType: 'terminal' });
    const socket = await connectRaw(); const forwarded = deferred(); fixture.write.mockImplementation(() => forwarded.resolve());
    const writes = vi.spyOn(fs, 'writeFile');
    socket.emit('message', Buffer.from([2, 0, 80, 0, 24])); socket.emit('message', Buffer.from([3]));
    emitRaw(socket, '\x1b[Aecho hi\r'); await forwarded.promise;
    expect(fixture.write).toHaveBeenCalledWith('\x1b[Aecho hi\r');
    expect(writes).not.toHaveBeenCalled(); expect((await readTab()).orchestrationActivity).toBeUndefined();
  });
});
