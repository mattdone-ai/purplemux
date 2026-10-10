import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import {
  hasSession,
  createSession,
  killSession,
  defaultSessionName,
  exitCopyMode,
} from './tmux';
import { buildShellEnv } from '@/lib/shell-env';
import { PRISTINE_ENV } from '@/lib/pristine-env';
import { withRecordedTerminalInput } from '@/lib/terminal-input';
import { encodeStdout, encodeInputError } from '@/lib/terminal-protocol';
import { reconcileTabCwd } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { sessionUsesTypedDelivery } from '@/lib/agent-prompt-delivery';
import { remoteTmuxCommand, sshArgv } from '@/lib/remote-host';
import { sessionHostOf } from '@/lib/session-host';
import { createStdinTypedWriter } from '@/lib/stdin-typed-writer';

const log = createLogger('terminal');

const MSG_STDIN = 0x00;
const MSG_RESIZE = 0x02;
const MSG_HEARTBEAT = 0x03;
const MSG_KILL_SESSION = 0x04;
const MSG_WEB_STDIN = 0x05;

const MAX_CONNECTIONS = 32;
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 90_000;
const BACKPRESSURE_HIGH = 1024 * 1024;
const BACKPRESSURE_LOW = 256 * 1024;
const THROTTLE_WINDOW_MS = 500;
const THROTTLE_FLUSH_INTERVAL_MS = 250;

const TMUX_SOCKET = 'purple';
const textDecoder = new TextDecoder();

// The server selects its tmux socket at process start. Keep that server-owned value for the PTY
// attach client without broadening the shell allowlist or accepting a socket from the browser.
const terminalAttachEnv = (): NodeJS.ProcessEnv => ({
  ...buildShellEnv(),
  ...(PRISTINE_ENV.TMUX_TMPDIR ? { TMUX_TMPDIR: PRISTINE_ENV.TMUX_TMPDIR } : {}),
});

interface IActiveConnection {
  ws: WebSocket;
  pty: pty.IPty;
  sessionName: string;
  clientId: string | null;
  heartbeatTimer: ReturnType<typeof setInterval>;
  cleaned: boolean;
  detaching: boolean;
  disposables: pty.IDisposable[];
  backpressurePaused: boolean;
  capturePaused: boolean;
  currentCols: number;
  currentRows: number;
  throttleUntil: number;
  throttleBuffer: string;
  throttleInterval: ReturnType<typeof setInterval> | null;
}

const globalStore = globalThis as unknown as {
  __purplemux_terminal_connections?: Map<WebSocket, IActiveConnection>;
  __purplemux_terminal_output_ts?: Map<string, number>;
};

const connections = globalStore.__purplemux_terminal_connections ??= new Map<WebSocket, IActiveConnection>();
const terminalOutputTimestamps = globalStore.__purplemux_terminal_output_ts ??= new Map<string, number>();

export const getLastTerminalOutput = (sessionName: string): number | undefined =>
  terminalOutputTimestamps.get(sessionName);

/** A remote session attaches through `ssh -tt <host> tmux … attach-session` (ADR-0022 §10). */
const attachToSession = (sessionName: string, cols: number, rows: number, host: string | null = null): pty.IPty => {
  const [file, args] = host
    ? ['ssh', sshArgv(host, remoteTmuxCommand(['-u', 'attach-session', '-t', sessionName]), { tty: true })]
    : ['tmux', ['-u', '-L', TMUX_SOCKET, 'attach-session', '-t', sessionName]];
  return pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: PRISTINE_ENV.HOME || '/',
    env: terminalAttachEnv(),
  });
};

const cleanup = (conn: IActiveConnection, sessionExited = false) => {
  if (conn.cleaned) return;
  conn.cleaned = true;
  terminalOutputTimestamps.delete(conn.sessionName);

  clearInterval(conn.heartbeatTimer);
  if (conn.throttleInterval) {
    clearInterval(conn.throttleInterval);
    conn.throttleInterval = null;
  }
  conn.throttleBuffer = '';

  for (const d of conn.disposables) {
    d.dispose();
  }
  conn.disposables = [];

  if (sessionExited && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.close(1000, 'Session exited');
  }

  try {
    if ('destroy' in conn.pty) {
      (conn.pty as pty.IPty & { destroy: () => void }).destroy();
    } else {
      conn.pty.kill();
    }
  } catch {
    // PTY already exited
  }

  connections.delete(conn.ws);
};


export const pauseSession = (sessionName: string): { cols: number; rows: number } | null => {
  for (const conn of connections.values()) {
    if (conn.sessionName === sessionName && !conn.cleaned) {
      if (conn.capturePaused) return null;
      conn.capturePaused = true;
      return { cols: conn.currentCols, rows: conn.currentRows };
    }
  }
  return null;
};

export const resumeSession = (sessionName: string): void => {
  for (const conn of connections.values()) {
    if (conn.sessionName === sessionName && !conn.cleaned) {
      if (!conn.capturePaused) return;
      conn.capturePaused = false;
      return;
    }
  }
};

export const resizeSessionPty = (sessionName: string, cols: number, rows: number): void => {
  for (const conn of connections.values()) {
    if (conn.sessionName === sessionName && !conn.cleaned) {
      conn.pty.resize(cols, rows);
      return;
    }
  }
};

export const getActiveSessionSize = (sessionName: string): { cols: number; rows: number } | null => {
  for (const conn of connections.values()) {
    if (conn.sessionName === sessionName && !conn.cleaned) {
      return { cols: conn.currentCols, rows: conn.currentRows };
    }
  }
  return null;
};

export const gracefulShutdown = (): Promise<void> => {
  if (connections.size === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let remaining = 0;
    const timer = setTimeout(resolve, 2000);
    const done = () => {
      if (--remaining <= 0) {
        clearTimeout(timer);
        resolve();
      }
    };

    connections.forEach((conn) => {
      if (conn.cleaned) return;
      conn.cleaned = true;
      conn.detaching = true;
      terminalOutputTimestamps.delete(conn.sessionName);

      clearInterval(conn.heartbeatTimer);
      if (conn.throttleInterval) {
        clearInterval(conn.throttleInterval);
        conn.throttleInterval = null;
      }

      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1001, 'Server shutting down');
      }

      remaining++;
      // Wait for onExit callback — ensures native ThreadSafeFunction is fully drained
      conn.pty.onExit(() => done());

      // Kill PTY without disposing existing onData/onExit disposables.
      // kill → native exit event → onExit callback above → done.
      // Existing onData disposable is ignored because cleaned=true.
      try {
        if ('destroy' in conn.pty) {
          (conn.pty as pty.IPty & { destroy: () => void }).destroy();
        } else {
          conn.pty.kill();
        }
      } catch {
        done();
      }

      connections.delete(conn.ws);
    });

    if (remaining === 0) {
      clearTimeout(timer);
      resolve();
    }
  });
};

export const handleConnection = async (ws: WebSocket, request: IncomingMessage, sessionId: string | null) => {
  const url = new URL(request.url || '', 'http://localhost');
  const clientId = url.searchParams.get('clientId');
  const urlCols = parseInt(url.searchParams.get('cols') || '', 10);
  const urlRows = parseInt(url.searchParams.get('rows') || '', 10);

  connections.forEach((conn, key) => {
    if (key.readyState === WebSocket.CLOSED || key.readyState === WebSocket.CLOSING) {
      cleanup(conn);
    }
  });

  if (clientId) {
    connections.forEach((conn) => {
      if (conn.clientId === clientId && !conn.cleaned) {
        log.debug(`replacing existing connection for clientId: ${clientId}`);
        conn.detaching = true;
        cleanup(conn);
      }
    });
  }

  if (connections.size >= MAX_CONNECTIONS) {
    // Close frames may arrive late during workspace switch, temporarily exceeding the limit.
    // Evict oldest connections to accommodate the new one.
    const toEvict = connections.size - MAX_CONNECTIONS + 1;
    let evicted = 0;
    for (const [oldWs, oldConn] of connections) {
      if (evicted >= toEvict) break;
      log.debug(`evicting stale connection for session: ${oldConn.sessionName}`);
      oldConn.detaching = true;
      cleanup(oldConn);
      if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
        oldWs.close(1001, 'Replaced by new connection');
      }
      evicted++;
    }
  }

  if (connections.size >= MAX_CONNECTIONS) {
    log.warn(`connection rejected: max connections (${MAX_CONNECTIONS}) reached`);
    ws.close(1013, 'Max connections exceeded');
    return;
  }

  const pending = { resize: null as { cols: number; rows: number } | null };
  let ptyProcess: pty.IPty | null = null;
  let conn: IActiveConnection | null = null;
  let lastHeartbeat = Date.now();
  let sessionName = '';
  let inputQueue = Promise.resolve();
  const writeStdin = createStdinTypedWriter({
    write: (data) => { ptyProcess?.write(data); },
    usesTyped: () => sessionUsesTypedDelivery(sessionName),
  });
  let currentCols = 80;
  let currentRows = 24;

  const parseMessage = (raw: Buffer | ArrayBuffer) => {
    const data = new Uint8Array(
      raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    );
    if (data.length === 0) return;
    return { type: data[0], payload: data.slice(1) };
  };

  const handleMessage = (raw: Buffer | ArrayBuffer) => {
    const msg = parseMessage(raw);
    if (!msg) return;

    if (!ptyProcess) {
      if (msg.type === MSG_RESIZE && msg.payload.length >= 4) {
        const view = new DataView(msg.payload.buffer, msg.payload.byteOffset, msg.payload.byteLength);
        pending.resize = { cols: view.getUint16(0), rows: view.getUint16(2) };
      } else if ((msg.type === MSG_STDIN || msg.type === MSG_WEB_STDIN) && msg.payload.length > 0) {
        log.warn({ sessionName }, 'terminal input refused before tmux attachment completed');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeInputError('Terminal is still attaching. Input was not sent; retry after terminal output appears.'));
        }
      }
      return;
    }

    switch (msg.type) {
      case MSG_STDIN:
      case MSG_WEB_STDIN: {
        const data = textDecoder.decode(msg.payload);
        if (!data) break;
        const prior = inputQueue;
        inputQueue = withRecordedTerminalInput(sessionName, data, async () => {
          if (conn?.cleaned || ws.readyState !== WebSocket.OPEN) return;
          if (msg.type === MSG_WEB_STDIN) await exitCopyMode(sessionName);
          await writeStdin(data);
        }, prior).catch((err) => {
          log.warn({ err, sessionName }, 'terminal input refused or delivery uncertain');
          if (ws.readyState === WebSocket.OPEN) ws.send(encodeInputError('Terminal input was not confirmed. Pending activity is retained; check the terminal before retrying.'));
        });
        break;
      }
      case MSG_RESIZE: {
        if (msg.payload.length >= 4) {
          const view = new DataView(msg.payload.buffer, msg.payload.byteOffset, msg.payload.byteLength);
          const newCols = view.getUint16(0);
          const newRows = view.getUint16(2);
          if (newCols > 0 && newRows > 0) {
            if (conn) {
              const sizeChanged = conn.currentCols !== newCols || conn.currentRows !== newRows;
              conn.currentCols = newCols;
              conn.currentRows = newRows;
              if (!conn.capturePaused) {
                ptyProcess.resize(newCols, newRows);
                if (sizeChanged) startThrottleWindow('resize');
              }
            } else {
              ptyProcess.resize(newCols, newRows);
            }
          }
        }
        break;
      }
      case MSG_HEARTBEAT: {
        lastHeartbeat = Date.now();
        ws.send(new Uint8Array([MSG_HEARTBEAT]));
        break;
      }
      case MSG_KILL_SESSION: {
        log.debug(`kill session requested: ${sessionName}`);
        killSession(sessionName).catch((err) => {
          log.error(`kill session failed: ${err instanceof Error ? err.message : err}`);
        });
        break;
      }
    }
  };

  ws.on('message', handleMessage);
  ws.on('close', () => {
    if (!conn) return;
    conn.detaching = true;
    cleanup(conn);
  });
  ws.on('error', (err) => {
    log.error(`websocket error: ${err.message}`);
    if (!conn) return;
    conn.detaching = true;
    cleanup(conn);
  });

  if (sessionId) {
    sessionName = sessionId;
    const exists = await hasSession(sessionId);
    if (!exists) {
      log.warn(`session not found: ${sessionName}`);
      await reconcileTabCwd(sessionName).catch((err) => {
        log.warn(`reconcile cwd failed: ${err instanceof Error ? err.message : err}`);
      });
      ws.close(1011, 'Session not found');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    currentCols = urlCols > 0 ? urlCols : (pending.resize?.cols || 80);
    currentRows = urlRows > 0 ? urlRows : (pending.resize?.rows || 24);
    try {
      ptyProcess = attachToSession(sessionName, currentCols, currentRows, await sessionHostOf(sessionName));
    } catch (err) {
      log.error(`tmux attach failed: ${err instanceof Error ? err.message : err}`);
      ws.close(1011, 'Session attach failed');
      return;
    }
  } else {
    sessionName = defaultSessionName();
    currentCols = urlCols > 0 ? urlCols : (pending.resize?.cols || 80);
    currentRows = urlRows > 0 ? urlRows : (pending.resize?.rows || 24);
    try {
      await createSession(sessionName, currentCols, currentRows);
      if (ws.readyState !== WebSocket.OPEN) return;
      ptyProcess = attachToSession(sessionName, currentCols, currentRows);
    } catch (err) {
      log.error(`tmux session creation failed: ${err instanceof Error ? err.message : err}`);
      ws.close(1011, 'Session create failed');
      return;
    }
  }

  if (pending.resize && pending.resize.cols > 0 && pending.resize.rows > 0) {
    currentCols = pending.resize.cols;
    currentRows = pending.resize.rows;
    ptyProcess.resize(currentCols, currentRows);
  }

  const heartbeatTimer = setInterval(() => {
    if (conn && Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT) {
      conn.detaching = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Heartbeat timeout');
      }
      cleanup(conn);
    }
  }, HEARTBEAT_INTERVAL);

  conn = {
    ws,
    pty: ptyProcess,
    sessionName,
    clientId,
    heartbeatTimer,
    cleaned: false,
    detaching: false,
    disposables: [],
    backpressurePaused: false,
    capturePaused: false,
    currentCols,
    currentRows,
    throttleUntil: 0,
    throttleBuffer: '',
    throttleInterval: null,
  };

  connections.set(ws, conn);

  const ptyPid = ptyProcess.pid;

  const sendStdout = (data: string) => {
    ws.send(encodeStdout(data));

    if (ws.bufferedAmount > BACKPRESSURE_HIGH && !conn.backpressurePaused) {
      conn.backpressurePaused = true;
      ptyProcess!.pause();
    } else if (ws.bufferedAmount < BACKPRESSURE_LOW && conn.backpressurePaused) {
      conn.backpressurePaused = false;
      ptyProcess!.resume();
    }
  };

  const flushThrottleBuffer = () => {
    if (conn.throttleBuffer.length === 0) return;
    sendStdout(conn.throttleBuffer);
    conn.throttleBuffer = '';
  };

  // tmux pane reflow는 새 사이즈로 재렌더링하면서 중간 frame들을 빠르게 보냄.
  // 이 동안 데이터를 모아서 일정 간격으로만 flush해 화면 떨림을 줄임.
  const startThrottleWindow = (reason: string) => {
    const now = Date.now();
    const wasActive = now < conn.throttleUntil;
    const newEnd = now + THROTTLE_WINDOW_MS;
    if (newEnd <= conn.throttleUntil) return;
    conn.throttleUntil = newEnd;
    if (!wasActive) {
      log.debug(`[throttle] window started ${THROTTLE_WINDOW_MS}ms reason=${reason} session=${sessionName} pid=${ptyPid}`);
    }
    if (conn.throttleInterval) return;
    conn.throttleInterval = setInterval(() => {
      flushThrottleBuffer();
      if (Date.now() < conn.throttleUntil) return;
      clearInterval(conn.throttleInterval!);
      conn.throttleInterval = null;
      log.debug(`[throttle] window ended session=${sessionName} pid=${ptyPid}`);
    }, THROTTLE_FLUSH_INTERVAL_MS);
  };

  startThrottleWindow('initial');

  conn.disposables.push(
    ptyProcess.onData((data: string) => {
      if (conn.cleaned || ws.readyState !== WebSocket.OPEN) return;
      terminalOutputTimestamps.set(sessionName, Date.now());
      if (conn.capturePaused) return;

      if (Date.now() < conn.throttleUntil) {
        conn.throttleBuffer += data;
        return;
      }
      sendStdout(data);
    }),
  );

  conn.disposables.push(
    ptyProcess.onExit(({ exitCode, signal }) => {
      if (conn.cleaned) return;
      log.debug(
        `pty exited (pid: ${ptyProcess!.pid}, code: ${exitCode}, signal: ${signal}, detaching: ${conn.detaching})`,
      );
      cleanup(conn, !conn.detaching);
    }),
  );
};
