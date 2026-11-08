import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteError } from '@/lib/notes-store';
import { WorkerEventError } from '@/lib/worker-event-schema';
import { callRoute } from './leases-harness';

// The typed-event routes (ADR-0043): each refusal answers its status and code, with its details.

const service = vi.hoisted(() => ({
  send: vi.fn(),
  declareScope: vi.fn(),
  clearScope: vi.fn(),
  listScopes: vi.fn(),
}));
const caller = vi.hoisted(() => ({ value: { workspaceId: 'ws-1', tabId: 'tab-w1', verified: true, admin: false } as unknown }));

vi.mock('@/lib/worker-events-service', () => ({ getWorkerEventsService: async () => service }));
vi.mock('@/lib/lease-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lease-http')>()),
  requireCaller: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (!caller.value) {
      res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
      return null;
    }
    return caller.value;
  },
}));

const send = async () => (await import('@/pages/api/cli/worker-events/index')).default;
const scope = async () => (await import('@/pages/api/cli/worker-events/scope')).default;

beforeEach(() => {
  vi.clearAllMocks();
  caller.value = { workspaceId: 'ws-1', tabId: 'tab-w1', verified: true, admin: false };
});

describe('POST /api/cli/worker-events', () => {
  it('passes the type, target and payload, and answers the result', async () => {
    service.send.mockResolvedValue({ event: { noteId: 'n-1' } });
    const result = await callRoute(await send(), { method: 'POST', body: { type: 'landed', toEpic: 'beta', payload: { a: 1 }, extra: 'ignored' } });
    expect(result).toMatchObject({ status: 200, body: { event: { noteId: 'n-1' } } });
    expect(service.send).toHaveBeenCalledWith(caller.value, { type: 'landed', toEpic: 'beta', payload: { a: 1 } });
  });

  it.each([
    ['event-invalid', 400],
    ['event-scope-invalid', 400],
    ['event-refused', 422],
    ['event-out-of-scope', 403],
    ['event-stale', 409],
    ['event-no-recipient', 503],
    ['event-check-unavailable', 409],
    ['forbidden', 403],
  ] as const)('answers %s with %i', async (code, status) => {
    service.send.mockRejectedValue(new WorkerEventError(code, `why ${code}`, { failures: [{ check: 'x' }], code: 'not-this' }));
    const result = await callRoute(await send(), { method: 'POST', body: {} });
    expect(result).toEqual({ status, headers: {}, body: { failures: [{ check: 'x' }], error: `why ${code}`, code } });
  });

  it('answers a note refusal by the notes table, and an unknown failure as a 500 that says nothing', async () => {
    service.send.mockRejectedValue(new NoteError('note-cap', 'cap'));
    expect(await callRoute(await send(), { method: 'POST', body: {} })).toMatchObject({ status: 409, body: { code: 'note-cap' } });
    service.send.mockRejectedValue(new Error('disk on fire'));
    expect(await callRoute(await send(), { method: 'POST', body: {} })).toMatchObject({ status: 500, body: { code: 'note-internal' } });
  });

  it('refuses another method and an unresolved caller', async () => {
    expect(await callRoute(await send(), { method: 'GET' })).toMatchObject({ status: 405 });
    caller.value = null;
    expect(await callRoute(await send(), { method: 'POST', body: {} })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(service.send).not.toHaveBeenCalled();
  });
});

describe('/api/cli/worker-events/scope', () => {
  it('lists, declares and clears', async () => {
    service.listScopes.mockResolvedValue([{ tabId: 'tab-w1' }]);
    service.declareScope.mockResolvedValue({ tabId: 'tab-w1' });
    service.clearScope.mockResolvedValue(true);
    expect(await callRoute(await scope(), { method: 'GET' })).toMatchObject({ status: 200, body: { scopes: [{ tabId: 'tab-w1' }] } });
    expect(await callRoute(await scope(), { method: 'PUT', body: { tabId: 'tab-w1', epic: 'alpha', dependsOn: ['beta'], attempt: 2, story: 's' } }))
      .toMatchObject({ status: 200, body: { scope: { tabId: 'tab-w1' } } });
    expect(service.declareScope).toHaveBeenCalledWith(caller.value, { tabId: 'tab-w1', epic: 'alpha', story: 's', dependsOn: ['beta'], attempt: 2 });
    expect(await callRoute(await scope(), { method: 'DELETE', query: { tabId: 'tab-w1' } })).toMatchObject({ status: 200, body: { cleared: true } });
    expect(service.clearScope).toHaveBeenCalledWith(caller.value, 'tab-w1');
  });

  it('answers a refusal with its code, and refuses another method', async () => {
    service.declareScope.mockRejectedValue(new WorkerEventError('forbidden', 'coordinator only'));
    expect(await callRoute(await scope(), { method: 'PUT', body: {} })).toMatchObject({ status: 403, body: { code: 'forbidden', error: 'coordinator only' } });
    const other = await callRoute(await scope(), { method: 'POST' });
    expect(other).toMatchObject({ status: 405, headers: { Allow: 'GET, PUT, DELETE' } });
  });
});
