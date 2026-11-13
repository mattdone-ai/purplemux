import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/cli/workspaces/[workspaceId]/directories';
import { authorizeOwnWorkspaceWrite } from '@/lib/cli-utils';
import {
  getWorkspaceById,
  updateWorkspaceDirectories,
  validateDirectory,
} from '@/lib/workspace-store';

vi.mock('@/lib/cli-utils', () => ({ authorizeOwnWorkspaceWrite: vi.fn() }));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(),
  updateWorkspaceDirectories: vi.fn(),
  validateDirectory: vi.fn(),
}));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = { statusCode: 0, body: undefined, res: undefined as unknown as NextApiResponse };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const run = async (method: string, body?: unknown): Promise<IFakeResponse> => {
  const state = fakeResponse();
  await handler({ method, query: { workspaceId: 'ws-test' }, body } as unknown as NextApiRequest, state.res);
  return state;
};

describe('/api/cli/workspaces/[workspaceId]/directories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeOwnWorkspaceWrite).mockResolvedValue({ type: 'admin' });
    vi.mocked(validateDirectory).mockResolvedValue({ valid: true, exists: true, isDirectory: true, canCreate: true });
    vi.mocked(updateWorkspaceDirectories).mockResolvedValue(true);
    vi.mocked(getWorkspaceById).mockResolvedValue({ id: 'ws-test', name: 'test', directories: ['/a', '/b'] });
  });

  it('rejects an out-of-scope caller before touching the store', async () => {
    // authorizeOwnWorkspaceWrite writes the 403 itself and returns null
    vi.mocked(authorizeOwnWorkspaceWrite).mockImplementation(async (_req, res) => {
      (res as unknown as { status: (n: number) => { json: (b: unknown) => void } })
        .status(403).json({ error: 'out of scope' });
      return null;
    });
    const { statusCode } = await run('PATCH', { directories: ['/a'] });
    expect(statusCode).toBe(403);
    expect(updateWorkspaceDirectories).not.toHaveBeenCalled();
  });

  it('returns the current directories on GET', async () => {
    const { statusCode, body } = await run('GET');
    expect(statusCode).toBe(200);
    expect(body).toEqual({ workspaceId: 'ws-test', name: 'test', directories: ['/a', '/b'] });
  });

  it('returns 404 on GET for an unknown workspace', async () => {
    vi.mocked(getWorkspaceById).mockResolvedValue(undefined);
    const { statusCode } = await run('GET');
    expect(statusCode).toBe(404);
  });

  it('repoints the workspace on PATCH', async () => {
    const { statusCode, body } = await run('PATCH', { directories: ['/a', '/b'] });
    expect(updateWorkspaceDirectories).toHaveBeenCalledWith('ws-test', ['/a', '/b']);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ workspaceId: 'ws-test', directories: ['/a', '/b'] });
  });

  it('rejects an invalid payload with 400', async () => {
    const { statusCode } = await run('PATCH', { directories: [] });
    expect(statusCode).toBe(400);
    expect(updateWorkspaceDirectories).not.toHaveBeenCalled();
  });

  it('rejects a non-existent path with 400', async () => {
    vi.mocked(validateDirectory).mockResolvedValue({ valid: false, error: 'Directory does not exist', exists: false, isDirectory: false, canCreate: false });
    const { statusCode, body } = await run('PATCH', { directories: ['/nope'] });
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({ error: '/nope: Directory does not exist' });
  });

  it('maps a primary-directory conflict to 409', async () => {
    vi.mocked(updateWorkspaceDirectories).mockRejectedValue(new Error('primary directories must be unique'));
    const { statusCode, body } = await run('PATCH', { directories: ['/a'] });
    expect(statusCode).toBe(409);
    expect(body).toMatchObject({ error: 'primary directories must be unique' });
  });

  it('rejects other methods with 405', async () => {
    const { statusCode } = await run('DELETE');
    expect(statusCode).toBe(405);
  });
});
