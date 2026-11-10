import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0028 §12: a restart is never a session end for an attached client. 1000 makes the web client
// close the tab; while a restart of the tab is open, an attach end and a connect both get 4002.

const LOCAL = 'pt-ws-l-pane-p-tab-local1';
const REMOTE = 'pt-ws-r-pane-p-tab-remote1';

const fx = vi.hoisted(() => ({
  spawn: vi.fn(),
  presence: vi.fn(async (_name: string): Promise<'present' | 'absent' | 'unknown'> => 'present'),
  kill: vi.fn(async () => null),
  reconcile: vi.fn(async () => {}),
  exits: [] as Array<(e: { exitCode: number; signal?: number }) => void>,
}));

vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => fx.spawn(...args) }));
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  killSession: fx.kill,
  defaultSessionName: () => 'pt-x-y-z',
  exitCopyMode: vi.fn(async () => {}),
  sessionPresence: fx.presence,
}));
vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (s === REMOTE ? 'host-b' : null) }));
vi.mock('@/lib/layout-store', () => ({ reconcileTabCwd: fx.reconcile }));
vi.mock('@/lib/agent-prompt-delivery', () => ({ sessionUsesTypedDelivery: async () => false }));
vi.mock('@/lib/terminal-input', () => ({ withRecordedTerminalInput: async (_s: string, _d: string, work: () => Promise<void>) => work() }));

const connect = async (session: string) => {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
  const { handleConnection } = await import('@/lib/terminal-server');
  await handleConnection(ws as unknown as WebSocket, { url: '/api/terminal' } as IncomingMessage, session);
  return ws;
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const lastExit = () => fx.exits[fx.exits.length - 1];

const restart = async (session: string, restartId: string, phase: 'restarting' | 'restarted' | 'failed') => {
  const { emitTabRestart } = await import('@/lib/tab-lifecycle');
  emitTabRestart({ workspaceId: 'ws-l', tabId: session.slice(session.indexOf('tab-')), sessionName: session, restartId, phase });
};

describe('attached terminals across a restart (ADR-0028 §12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { __ptTabLifecycle?: unknown }).__ptTabLifecycle;
    vi.resetModules();
    fx.exits = [];
    fx.presence.mockResolvedValue('present');
    fx.spawn.mockImplementation(() => ({
      pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      onData: () => ({ dispose: vi.fn() }),
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { fx.exits.push(cb); return { dispose: vi.fn() }; },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([['local', LOCAL], ['remote', REMOTE]])('a %s attach that ends while the tab restarts closes 4002, never 1000, with no tmux probe', async (_label, session) => {
    const ws = await connect(session);
    await restart(session, 'r-1', 'restarting');
    fx.presence.mockClear();
    fx.presence.mockResolvedValue('absent');
    lastExit()({ exitCode: 0 });
    await settle();
    expect(ws.close).toHaveBeenCalledWith(4002, 'Tab restarting');
    expect(ws.close).not.toHaveBeenCalledWith(1000, expect.anything());
    expect(fx.presence).not.toHaveBeenCalled();
    expect(fx.kill).not.toHaveBeenCalled();
  });

  it('a restart that starts during the presence probe wins: 4002', async () => {
    const ws = await connect(LOCAL);
    let answer: (presence: 'absent') => void = () => {};
    fx.presence.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    lastExit()({ exitCode: 0 });
    await settle();
    await restart(LOCAL, 'r-1', 'restarting');
    answer('absent');
    await settle();
    expect(ws.close).toHaveBeenCalledWith(4002, 'Tab restarting');
    expect(ws.close).not.toHaveBeenCalledWith(1000, expect.anything());
  });

  it.each(['absent', 'present'] as const)('a connect while the tab restarts gets 4002 with no spawn, no probe and no cwd reconcile (session %s)', async (presence) => {
    fx.presence.mockResolvedValue(presence);
    await restart(LOCAL, 'r-1', 'restarting');
    const ws = await connect(LOCAL);
    expect(ws.close).toHaveBeenCalledWith(4002, 'Tab restarting');
    expect(fx.spawn).not.toHaveBeenCalled();
    expect(fx.presence).not.toHaveBeenCalled();
    expect(fx.reconcile).not.toHaveBeenCalled();
  });

  it('a remote connect while the tab restarts gets 4002 before any ssh', async () => {
    await restart(REMOTE, 'r-1', 'restarting');
    const ws = await connect(REMOTE);
    expect(ws.close).toHaveBeenCalledWith(4002, 'Tab restarting');
    expect(fx.spawn).not.toHaveBeenCalled();
    expect(fx.presence).not.toHaveBeenCalled();
  });

  it.each(['restarted', 'failed'] as const)('after the matching %s a connect attaches to the same session name', async (phase) => {
    await restart(LOCAL, 'r-1', 'restarting');
    await restart(LOCAL, 'r-1', phase);
    const ws = await connect(LOCAL);
    expect(ws.close).not.toHaveBeenCalled();
    expect(fx.spawn.mock.calls[0].slice(0, 2)).toEqual(['tmux', ['-u', '-L', 'purple', 'attach-session', '-t', LOCAL]]);
  });

  it('overlapping restarts: the end of the first while the second is open still answers 4002', async () => {
    await restart(LOCAL, 'r-1', 'restarting');
    await restart(LOCAL, 'r-2', 'restarting');
    await restart(LOCAL, 'r-1', 'restarted');
    const ws = await connect(LOCAL);
    expect(ws.close).toHaveBeenCalledWith(4002, 'Tab restarting');
  });

  it('an open restart stops counting after 120 s (backstop for a lost end event)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    await restart(LOCAL, 'r-1', 'restarting');
    const { isSessionRestarting, isTabRestarting } = await import('@/lib/tab-lifecycle');
    vi.setSystemTime(1_000_000 + 119_999);
    expect(isSessionRestarting(LOCAL)).toBe(true);
    expect(isTabRestarting('tab-local1')).toBe(true);
    vi.setSystemTime(1_000_000 + 120_000);
    expect(isSessionRestarting(LOCAL)).toBe(false);
    expect(isTabRestarting('tab-local1')).toBe(false);
  });

  it('an attach that ends with no restart open and tmux saying the session is gone still closes 1000', async () => {
    const ws = await connect(LOCAL);
    fx.presence.mockResolvedValue('absent');
    lastExit()({ exitCode: 0 });
    await settle();
    expect(ws.close).toHaveBeenCalledWith(1000, 'Session exited');
  });
});
