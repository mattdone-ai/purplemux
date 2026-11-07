import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBackgroundJob } from '@/types/liveness';
import type { ITab } from '@/types/terminal';

const cli = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  authorizeWorkspaceInput: vi.fn(),
  findTab: vi.fn(),
}));
const liveness = vi.hoisted(() => ({ registerJob: vi.fn(async (_job: IBackgroundJob) => {}) }));

vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const hosts: Record<string, string | undefined> = { 'tab-remote': 'ai-lan', 'tab-local': undefined, 'tab-other-remote': 'gpu-1' };
const tab = (id: string): ITab => ({
  id, name: id, order: 0, sessionName: `pt-ws-1-pane-a-${id}`, panelType: 'claude-code', ...(hosts[id] ? { host: hosts[id] } : {}),
});

const register = async (target: string, scope: Record<string, unknown>) => {
  cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1', ...scope });
  const { state, res } = fakeResponse();
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/bg');
  await handler({ method: 'POST', query: { workspaceId: 'ws-1', tabId: target }, body: { pid: 157985 } } as unknown as NextApiRequest, res);
  return { state, job: liveness.registerJob.mock.calls.at(-1)?.[0] };
};

describe('tab bg add names the host the pid lives on (D63)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cli.findTab.mockImplementation(async (ws: string, id: string) => (ws === 'ws-1' && id in hosts ? { workspaceId: ws, paneId: 'pane-a', tab: tab(id) } : null));
  });

  it('a remote tab registering its own pid names its host; a local tab marks itself local with host null', async () => {
    expect((await register('tab-remote', { tabId: 'tab-remote', tabVerified: true })).job).toMatchObject({ pid: 157985, host: 'ai-lan' });
    const local = await register('tab-local', { tabId: 'tab-local', tabVerified: true });
    expect(local.state.statusCode).toBe(200);
    expect(local.job).toHaveProperty('host', null);
  });

  it('takes the verified caller tab\'s host over the target\'s: the pid was taken where the caller runs', async () => {
    expect((await register('tab-remote', { tabId: 'tab-local', tabVerified: true })).job).toHaveProperty('host', null);
    expect((await register('tab-local', { tabId: 'tab-remote', tabVerified: true })).job).toMatchObject({ host: 'ai-lan' });
    expect((await register('tab-remote', { tabId: 'tab-other-remote', tabVerified: true })).job).toMatchObject({ host: 'gpu-1' });
  });

  it('uses the target tab\'s host when the token is not a verified tab', async () => {
    expect((await register('tab-remote', {})).job).toMatchObject({ host: 'ai-lan' });
    expect((await register('tab-remote', { tabId: 'tab-local' })).job).toMatchObject({ host: 'ai-lan' });
    expect((await register('tab-local', { type: 'admin' })).job).toHaveProperty('host', null);
  });

  it('refuses a registration from a verified caller tab that no longer exists, saying why', async () => {
    const { state } = await register('tab-remote', { tabId: 'tab-closed', tabVerified: true });
    expect(state.statusCode).toBe(409);
    expect(state.body).toMatchObject({ code: 'caller-tab-gone', error: expect.stringContaining('tab-closed no longer exists') });
    expect(liveness.registerJob).not.toHaveBeenCalled();
  });
});
