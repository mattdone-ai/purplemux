import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/cli/workspaces';
import { resolveCliScope } from '@/lib/workspace-token';
import { createWorkspace, validateDirectory } from '@/lib/workspace-store';
import { readDefaultTab, registerDefaultTab } from '@/lib/workspace-default-tab';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { directoryError } from '@/lib/path-safety';

vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: vi.fn() }));
vi.mock('@/lib/cli-utils', () => ({ canAccessWorkspace: vi.fn(async () => true) }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  createWorkspace: vi.fn(),
  validateDirectory: vi.fn(),
  isWorkspaceNameTakenError: (err: unknown) => (err as { code?: unknown })?.code === 'WORKSPACE_NAME_TAKEN',
}));
vi.mock('@/lib/workspace-default-tab', () => ({ readDefaultTab: vi.fn(), registerDefaultTab: vi.fn() }));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

interface IResult { statusCode: number; body: Record<string, unknown> }

const call = async (method: string, body?: unknown): Promise<IResult> => {
  const state: IResult = { statusCode: 0, body: {} };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { state.body = payload; return res; },
    setHeader() { return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  await handler({ method, headers: { 'x-pmux-token': 't' }, query: {}, body } as unknown as NextApiRequest, res);
  return state;
};

const valid = { valid: true, exists: true, isDirectory: true, canCreate: true };
const missing = { valid: false, error: 'Directory does not exist', exists: false, isDirectory: false, canCreate: true };
const created = { id: 'ws-new123', name: 'Acme-ledger v2', directories: ['/srv/a', '/srv/b'] };
const tab = { id: 'tab-first', sessionName: 'pt-ws-new123-pane-1-tab-first', name: '', order: 0 };

describe('POST /api/cli/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCliScope).mockReturnValue({ type: 'admin' });
    vi.mocked(validateDirectory).mockResolvedValue(valid);
    vi.mocked(createWorkspace).mockResolvedValue(created);
    vi.mocked(readDefaultTab).mockResolvedValue(tab);
  });

  it('creates through the store call the UI uses, registers the first tab and audits the admin write', async () => {
    const r = await call('POST', { name: '  Acme-ledger v2 ', directories: ['/srv/a', '/srv/b/'] });

    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ...created, defaultTabId: 'tab-first' });
    expect(createWorkspace).toHaveBeenCalledWith('/srv/a', 'Acme-ledger v2', undefined, { uniqueName: true, extraDirectories: ['/srv/b'] });
    expect(registerDefaultTab).toHaveBeenCalledWith(created, tab);
    expect(appendCoordinationAudit).toHaveBeenCalledWith(expect.objectContaining({ event: 'workspace-create', workspaceId: 'ws-new123', by: 'admin' }));
  });

  it('answers a null defaultTabId when the layout has no tab', async () => {
    vi.mocked(readDefaultTab).mockResolvedValue(null);
    const r = await call('POST', { name: 'x', directories: ['/srv/a'] });
    expect(r.body.defaultTabId).toBeNull();
  });

  it('answers 200 with the created workspace when the first-tab registration fails afterwards', async () => {
    vi.mocked(readDefaultTab).mockRejectedValue(new Error('layout unreadable'));
    const r = await call('POST', { name: 'x', directories: ['/srv/a'] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ...created, defaultTabId: null });
    expect(appendCoordinationAudit).toHaveBeenCalled();
  });

  it.each([
    ['a workspace token', { type: 'workspace', workspaceId: 'ws-a' }],
    ['a tab token', { type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-a', tabVerified: true, tabIdentity: 'launch' }],
    ['no valid token', null],
  ] as const)('refuses %s with 403 forbidden before touching the store', async (_label, scope) => {
    vi.mocked(resolveCliScope).mockReturnValue(scope as ReturnType<typeof resolveCliScope>);
    const r = await call('POST', { name: 'x', directories: ['/srv/a'] });
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('forbidden');
    expect(r.body.error).toContain('admin token');
    expect(validateDirectory).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('maps a taken name to 409 conflict', async () => {
    vi.mocked(createWorkspace).mockRejectedValue(
      Object.assign(new Error('a workspace named "Acme-ledger v2" already exists (ws-old)'), { code: 'WORKSPACE_NAME_TAKEN' }),
    );
    const r = await call('POST', { name: 'acme-ledger V2', directories: ['/srv/a'] });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: 'a workspace named "Acme-ledger v2" already exists (ws-old)', code: 'conflict' });
    expect(appendCoordinationAudit).not.toHaveBeenCalled();
  });

  it('refuses a missing primary directory with 400 invalid-request and creates nothing', async () => {
    vi.mocked(validateDirectory).mockResolvedValueOnce(missing);
    const r = await call('POST', { name: 'x', directories: ['/srv/nope', '/srv/b'] });
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'primary directory /srv/nope: Directory does not exist', code: 'invalid-request' });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a missing later directory', async () => {
    vi.mocked(validateDirectory).mockResolvedValueOnce(valid).mockResolvedValueOnce(missing);
    const r = await call('POST', { name: 'x', directories: ['/srv/a', '/srv/nope'] });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('directory /srv/nope: Directory does not exist');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('maps a store directory refusal to 400 invalid-request', async () => {
    vi.mocked(createWorkspace).mockRejectedValue(directoryError('Directory does not exist'));
    const r = await call('POST', { name: 'x', directories: ['/srv/a'] });
    expect(r.statusCode).toBe(400);
    expect(r.body.code).toBe('invalid-request');
  });

  it('answers an unexpected store failure with 500', async () => {
    vi.mocked(createWorkspace).mockRejectedValue(new Error('disk full'));
    const r = await call('POST', { name: 'x', directories: ['/srv/a'] });
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'disk full', code: 'workspace-create-failed' });
  });

  it.each([
    ['no body', undefined, 'name is required'],
    ['a blank name', { name: '  ', directories: ['/srv/a'] }, 'name is required'],
    ['a non-string name', { name: 7, directories: ['/srv/a'] }, 'name is required'],
    ['a name over 100 characters', { name: 'n'.repeat(101), directories: ['/srv/a'] }, 'longer than 100'],
    ['a control character in the name', { name: 'a\nb', directories: ['/srv/a'] }, 'control characters'],
    ['no directories', { name: 'x' }, 'non-empty array'],
    ['an empty directory list', { name: 'x', directories: [] }, 'non-empty array'],
    ['a relative directory', { name: 'x', directories: ['srv/a'] }, 'absolute paths'],
    ['a non-string directory', { name: 'x', directories: [3] }, 'absolute paths'],
  ])('refuses %s with 400 invalid-request', async (_label, body, message) => {
    const r = await call('POST', body);
    expect(r.statusCode).toBe(400);
    expect(r.body.code).toBe('invalid-request');
    expect(String(r.body.error)).toContain(message);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('keeps GET as the scoped list and refuses other methods with 405', async () => {
    expect((await call('GET')).body).toEqual({ workspaces: [] });
    expect((await call('DELETE')).statusCode).toBe(405);
  });
});
