vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import os from 'os';
import createHandler from '@/pages/api/workspace/index';
import validateHandler from '@/pages/api/workspace/validate';
import { createWorkspace, validateDirectory } from '@/lib/workspace-store';
import {
  DIRECTORY_MISSING_ERROR,
  NOT_A_DIRECTORY_ERROR,
  OUTSIDE_HOME_ERROR,
  directoryError,
} from '@/lib/path-safety';

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  validateDirectory: vi.fn(),
}));
vi.mock('@/lib/layout-store', () => ({
  readLayoutFile: vi.fn(async () => null),
  resolveLayoutFile: vi.fn(() => '/tmp/layout.json'),
  collectAllTabs: vi.fn(() => []),
  updateTabAgentSessionId: vi.fn(),
}));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => null) }));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/tmux', () => ({ sendKeys: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ registerTab: vi.fn(), markAgentLaunch: vi.fn() }) }));

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

const workspace = { id: 'ws-abc123', name: 'Workspace 1', directories: ['/home/user/fresh'] };

const post = async (body: unknown): Promise<IFakeResponse> => {
  const state = fakeResponse();
  await createHandler({ method: 'POST', query: {}, body } as unknown as NextApiRequest, state.res);
  return state;
};

describe('POST /api/workspace mkdir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createWorkspace).mockResolvedValue(workspace);
  });

  it('opts the create in when mkdir is true', async () => {
    const state = await post({ directory: '/home/user/fresh', mkdir: true });

    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual(workspace);
    expect(createWorkspace).toHaveBeenCalledWith('/home/user/fresh', undefined, undefined, { mkdir: true });
  });

  it('leaves the create opted out when mkdir is absent or false', async () => {
    await post({ directory: '/home/user/fresh' });
    expect(createWorkspace).toHaveBeenLastCalledWith('/home/user/fresh', undefined, undefined, { mkdir: false });

    await post({ directory: '/home/user/fresh', mkdir: false });
    expect(createWorkspace).toHaveBeenLastCalledWith('/home/user/fresh', undefined, undefined, { mkdir: false });
  });

  it('only accepts a real boolean as opt-in', async () => {
    await post({ directory: '/home/user/fresh', mkdir: 'true' });
    expect(createWorkspace).toHaveBeenLastCalledWith('/home/user/fresh', undefined, undefined, { mkdir: false });
  });

  it('still defaults the directory to the home directory', async () => {
    await post({ mkdir: true });
    expect(createWorkspace).toHaveBeenLastCalledWith(os.homedir(), undefined, undefined, { mkdir: true });
  });

  it.each([
    ['a missing directory without mkdir', DIRECTORY_MISSING_ERROR],
    ['a path outside home with mkdir', OUTSIDE_HOME_ERROR],
    ['an existing file', NOT_A_DIRECTORY_ERROR],
  ])('answers 400 with the message preserved for %s', async (_case, message) => {
    vi.mocked(createWorkspace).mockRejectedValue(directoryError(message));

    const state = await post({ directory: '/home/user/fresh', mkdir: true });

    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: message });
  });

  it('keeps answering 500 for a failure that is not about the directory', async () => {
    vi.mocked(createWorkspace).mockRejectedValue(new Error('EACCES: permission denied'));

    const state = await post({ directory: '/home/user/fresh', mkdir: true });

    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ error: 'EACCES: permission denied' });
  });
});

describe('GET /api/workspace/validate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the existing fields and the new triplet straight through', async () => {
    vi.mocked(validateDirectory).mockResolvedValue({
      valid: false,
      error: DIRECTORY_MISSING_ERROR,
      exists: false,
      isDirectory: false,
      canCreate: true,
    });

    const state = fakeResponse();
    await validateHandler(
      { method: 'GET', query: { directory: '/home/user/fresh' } } as unknown as NextApiRequest,
      state.res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      valid: false,
      error: DIRECTORY_MISSING_ERROR,
      exists: false,
      isDirectory: false,
      canCreate: true,
    });
    expect(validateDirectory).toHaveBeenCalledWith('/home/user/fresh');
  });

  it('still keeps suggestedName for a valid directory', async () => {
    vi.mocked(validateDirectory).mockResolvedValue({
      valid: true,
      suggestedName: 'code',
      exists: true,
      isDirectory: true,
      canCreate: true,
    });

    const state = fakeResponse();
    await validateHandler(
      { method: 'GET', query: { directory: '/home/user/code' } } as unknown as NextApiRequest,
      state.res,
    );

    expect(state.body).toMatchObject({ valid: true, suggestedName: 'code' });
  });

  it('still rejects a missing directory parameter', async () => {
    const state = fakeResponse();
    await validateHandler({ method: 'GET', query: {} } as unknown as NextApiRequest, state.res);

    expect(state.statusCode).toBe(400);
    expect(validateDirectory).not.toHaveBeenCalled();
  });
});
