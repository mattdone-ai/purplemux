import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 review r1 B1: a remote attach whose ssh exits is NOT the session's end. 1000 makes the
// client close the tab, which reaps the live remote work; only tmux on the host saying the session
// is gone may send it. Anything else is a disconnect the client retries (4001).

const REMOTE = 'pt-ws-r-pane-p-tab-remote1';
const LOCAL = 'pt-ws-l-pane-p-tab-local1';

const fx = vi.hoisted(() => ({
  spawn: vi.fn(),
  presence: vi.fn(async (_name: string): Promise<'present' | 'absent' | 'unknown'> => 'present'),
  kill: vi.fn(async () => null),
  exit: null as null | ((e: { exitCode: number; signal?: number }) => void),
}));

vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => fx.spawn(...args) }));
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  killSession: fx.kill,
  defaultSessionName: () => 'pt-x-y-z',
  exitCopyMode: vi.fn(async () => {}),
  sessionPresence: fx.presence,
}));
vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (s === REMOTE ? 'ai-server' : null) }));
vi.mock('@/lib/layout-store', () => ({ reconcileTabCwd: vi.fn(async () => {}) }));
vi.mock('@/lib/agent-prompt-delivery', () => ({ sessionUsesTypedDelivery: async () => false }));
vi.mock('@/lib/terminal-input', () => ({ withRecordedTerminalInput: async (_s: string, _d: string, work: () => Promise<void>) => work() }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, hostname: () => 'mdserver1' }, hostname: () => 'mdserver1' };
});

const connect = async (session: string) => {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
  const { handleConnection } = await import('@/lib/terminal-server');
  await handleConnection(ws as unknown as WebSocket, { url: '/api/terminal' } as IncomingMessage, session);
  return ws;
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('remote attach (ADR-0022 §10, review r1 B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.exit = null;
    fx.presence.mockResolvedValue('present');
    fx.spawn.mockImplementation(() => ({
      pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      onData: () => ({ dispose: vi.fn() }),
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { fx.exit = cb; return { dispose: vi.fn() }; },
    }));
  });

  it('attaches a remote session through ssh -tt to the remote socket, never the local purple socket', async () => {
    await connect(REMOTE);
    const [file, args] = fx.spawn.mock.calls[0] as [string, string[]];
    expect(file).toBe('ssh');
    expect(args[0]).toBe('-tt');
    expect(args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']));
    expect(args.slice(-3)).toEqual(['--', 'ai-server', `'tmux' '-L' 'pmux-mdserver1' '-u' 'attach-session' '-t' '${REMOTE}'`]);
  });

  it('a local session still attaches with tmux on purple', async () => {
    await connect(LOCAL);
    expect(fx.spawn.mock.calls[0].slice(0, 2)).toEqual(['tmux', ['-u', '-L', 'purple', 'attach-session', '-t', LOCAL]]);
  });

  it('a dropped ssh while the host cannot say: 4001 (retry), never 1000, and nothing is killed', async () => {
    const ws = await connect(REMOTE);
    fx.presence.mockResolvedValue('unknown');
    fx.exit!({ exitCode: 255 });
    await settle();
    expect(ws.close).toHaveBeenCalledWith(4001, 'Remote attach lost');
    expect(ws.close).not.toHaveBeenCalledWith(1000, expect.anything());
    expect(fx.kill).not.toHaveBeenCalled();
  });

  it('an ssh that exits while tmux still has the session (killed client, sshd limit): 4001', async () => {
    const ws = await connect(REMOTE);
    fx.presence.mockResolvedValue('present');
    fx.exit!({ exitCode: 0, signal: 15 });
    await settle();
    expect(ws.close).toHaveBeenCalledWith(4001, 'Remote attach lost');
  });

  it('only tmux proving the session gone ends it with 1000', async () => {
    const ws = await connect(REMOTE);
    fx.presence.mockResolvedValue('absent');
    fx.exit!({ exitCode: 0 });
    await settle();
    expect(ws.close).toHaveBeenCalledWith(1000, 'Session exited');
  });

  it('a connect while the host does not answer: 4001 and no attach; a session tmux says is gone: 1011', async () => {
    fx.presence.mockResolvedValue('unknown');
    const ws = await connect(REMOTE);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Remote host unreachable');
    expect(fx.spawn).not.toHaveBeenCalled();
    fx.presence.mockResolvedValue('absent');
    const gone = await connect(REMOTE);
    expect(gone.close).toHaveBeenCalledWith(1011, 'Session not found');
  });

  it('a local pty exit keeps today\'s 1000 without asking tmux', async () => {
    const ws = await connect(LOCAL);
    fx.presence.mockClear();
    fx.exit!({ exitCode: 0 });
    expect(ws.close).toHaveBeenCalledWith(1000, 'Session exited');
    expect(fx.presence).not.toHaveBeenCalled();
  });
});
