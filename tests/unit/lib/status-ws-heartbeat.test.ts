import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createServer, type Server } from 'http';
import type { IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import type { IAlert, INotificationAlertMessage, TStatusServerMessage } from '@/types/status';

const manager = vi.hoisted(() => ({
  clients: [] as unknown[],
  addClient: vi.fn(),
  removeClient: vi.fn(),
  getAllForClient: vi.fn(() => ({})),
  getStandupsForClient: vi.fn(() => ({})),
  dismissTab: vi.fn(),
  ackNotificationInput: vi.fn(),
}));

vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => manager }));
vi.mock('@/lib/session-history', () => ({ getSessionHistory: async () => [] }));

const { handleStatusConnection } = await import('@/lib/status-server');
const { DEFAULT_PING_INTERVAL_MS, DEFAULT_PING_TIMEOUT_MS, LONG_PING_INTERVAL_MS, LONG_PING_TIMEOUT_MS } =
  await import('@/lib/status-keepalive');

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  autoPong = false;
  send = vi.fn();
  ping = vi.fn(() => {
    if (this.autoPong) this.emit('pong');
  });
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = WebSocket.CLOSED;
  });
}

const connect = (query?: string, autoPong = false) => {
  const socket = new FakeSocket();
  socket.autoPong = autoPong;
  const request = query === undefined ? undefined : ({ url: `/api/status${query}` } as IncomingMessage);
  handleStatusConnection(socket as unknown as WebSocket, request);
  return socket;
};

describe('status websocket heartbeat cadence', () => {
  beforeEach(() => {
    manager.addClient.mockClear();
    manager.removeClient.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings a plain connection every 30s and closes it after 90s of silence — the web client cadence', () => {
    const socket = connect('');

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(3);
    expect(socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(socket.close).toHaveBeenCalledWith(1001, 'Heartbeat timeout');
  });

  it('gives a keepalive=long connection a 240s ping and a 600s timeout', () => {
    const socket = connect('?keepalive=long');

    vi.advanceTimersByTime(DEFAULT_PING_TIMEOUT_MS);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LONG_PING_INTERVAL_MS - DEFAULT_PING_TIMEOUT_MS);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LONG_PING_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LONG_PING_TIMEOUT_MS - LONG_PING_INTERVAL_MS);
    expect(socket.close).toHaveBeenCalledWith(1001, 'Heartbeat timeout');
  });

  it('falls back to the default cadence for an unknown or empty keepalive value', () => {
    const unknown = connect('?keepalive=turbo');
    const empty = connect('?keepalive=');
    const missing = connect();

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(unknown.ping).toHaveBeenCalledTimes(1);
    expect(empty.ping).toHaveBeenCalledTimes(1);
    expect(missing.ping).toHaveBeenCalledTimes(1);
  });

  it('keeps the timer per connection — a long client does not slow the web client down', () => {
    const web = connect('', true);
    const phone = connect('?keepalive=long', true);

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(web.ping).toHaveBeenCalledTimes(1);
    expect(phone.ping).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LONG_PING_INTERVAL_MS - DEFAULT_PING_INTERVAL_MS);
    expect(web.ping).toHaveBeenCalledTimes(LONG_PING_INTERVAL_MS / DEFAULT_PING_INTERVAL_MS);
    expect(phone.ping).toHaveBeenCalledTimes(1);
    expect(web.close).not.toHaveBeenCalled();
    expect(phone.close).not.toHaveBeenCalled();
  });

  it('extends the deadline on every pong', () => {
    const socket = connect('');

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS * 2);
    socket.emit('pong');

    vi.advanceTimersByTime(DEFAULT_PING_TIMEOUT_MS);
    expect(socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_PING_INTERVAL_MS);
    expect(socket.close).toHaveBeenCalledWith(1001, 'Heartbeat timeout');
  });

  it('stops the timer and drops the client when the socket closes', () => {
    const socket = connect('?keepalive=long');

    socket.readyState = WebSocket.CLOSED;
    socket.emit('close');
    expect(manager.removeClient).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LONG_PING_TIMEOUT_MS * 3);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});

const ALERT: IAlert = {
  id: 'alert-1',
  seq: 1,
  kind: 'needs-input',
  tabId: 'tab-1',
  workspaceId: 'ws-1',
  workspaceName: 'acme',
  tabName: 'orchestrator',
  providerId: 'claude',
  isOrchestrator: true,
  title: 'Needs input',
  body: 'The orchestrator is waiting on you.',
  at: 1_700_000_000_000,
};

describe('status websocket delivery is not paced by the heartbeat', () => {
  let server: Server;
  let wss: WebSocketServer;
  let client: WebSocket;
  let url: string;

  beforeEach(async () => {
    manager.clients = [];
    manager.addClient.mockImplementation((ws: unknown) => {
      manager.clients.push(ws);
    });

    // Only the heartbeat's interval is faked; socket I/O, setTimeout and Date stay
    // real so a frame can be pushed and awaited in the gap between two real pings.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    server = createServer();
    wss = new WebSocketServer({ noServer: true });
    wss.on('connection', handleStatusConnection);
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/status`;
  });

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  });

  const openClient = async (query: string) => {
    const received: TStatusServerMessage[] = [];
    let pings = 0;

    client = new WebSocket(`${url}${query}`);
    client.on('message', (data) => received.push(JSON.parse(String(data)) as TStatusServerMessage));
    client.on('ping', () => {
      pings += 1;
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    return { received, pingCount: () => pings };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const countOf = (received: TStatusServerMessage[], type: TStatusServerMessage['type'], from: number) =>
    received.slice(from).filter((msg) => msg.type === type).length;

  const cases = [
    { mode: 'default', query: '', intervalMs: DEFAULT_PING_INTERVAL_MS },
    { mode: 'keepalive=long', query: '?keepalive=long', intervalMs: LONG_PING_INTERVAL_MS },
  ];

  it.each(cases)('pushes status and alert frames to a $mode client in the gap between two pings', async ({
    query,
    intervalMs,
  }) => {
    const { received, pingCount } = await openClient(query);
    await waitFor(() => countOf(received, 'status:sync', 0) === 1, 'the initial status:sync');

    vi.advanceTimersByTime(intervalMs - 1);
    await settle();
    expect(pingCount()).toBe(0);

    vi.advanceTimersByTime(1);
    await waitFor(() => pingCount() === 1, 'the first keepalive ping');

    const gapStart = received.length;
    const alert: INotificationAlertMessage = { type: 'notification:alert', alert: ALERT };
    (manager.clients[0] as WebSocket).send(JSON.stringify(alert));
    await waitFor(() => countOf(received, 'notification:alert', gapStart) === 1, 'the alert frame');

    client.send(JSON.stringify({ type: 'status:request-sync' }));
    await waitFor(() => countOf(received, 'status:sync', gapStart) === 1, 'the re-sync frame');

    expect(received.slice(gapStart)).toContainEqual(alert);
    expect(pingCount()).toBe(1);

    vi.advanceTimersByTime(intervalMs);
    await waitFor(() => pingCount() === 2, 'the second keepalive ping');
  });
});
