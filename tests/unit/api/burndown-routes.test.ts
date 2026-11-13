import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BURNDOWN_HISTORY } from '@/lib/burndown';

const mockHome = vi.hoisted(() => ({ value: '' }));
const auth = vi.hoisted(() => ({ allow: true, human: true }));
const portfolio = vi.hoisted(() => ({ selection: null as null | { managerWorkspaceId: string } }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/cli-utils', () => ({
  authorizeOwnWorkspaceWrite: async (_req: unknown, res: NextApiResponse) => {
    if (auth.allow) return { type: 'workspace', workspaceId: 'ws-sm' };
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  },
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async (id: string) => (id === 'ws-sm' ? { id } : null),
}));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(),
  verifySessionToken: vi.fn(async () => (auth.human ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/portfolio-store', () => ({
  getPortfolioStore: () => ({
    currentSelection: () => portfolio.selection && { actor: 'human', updatedAt: 1,
      selection: { ...portfolio.selection, managerTabId: 'tab-sm', workspaceIds: [] } },
  }),
}));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: unknown) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const generatedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const snapshot = () => ({
  generated_at: generatedAt,
  epics: [{ slug: 'epic-a', name: 'Epic A', stories: 3, unpointed: 0, total: 5, burned: 2, remaining: 3, pct: 40,
    in_progress: 1, blocked: 0, done_events: [{ at: generatedAt, points: 2 }], undated_burned: 0 }],
  history: [{ at: generatedAt, slug: 'epic-a', total: 5, burned: 2, remaining: 3, pct: 40, stories: 3, unpointed: 0 }],
});

const cliCall = async (method: string, body?: unknown, workspaceId = 'ws-sm') => {
  const { default: handler } = await import('@/pages/api/cli/workspaces/[workspaceId]/burndown');
  const { state, res } = fakeResponse();
  await handler({ method, query: { workspaceId }, body, headers: {} } as unknown as NextApiRequest, res);
  return state;
};

const missionCall = async (method = 'GET') => {
  const { default: handler } = await import('@/pages/api/mission-control/burndown');
  const { state, res } = fakeResponse();
  await handler({ method, query: {}, headers: { cookie: 'session-token=t' } } as unknown as NextApiRequest, res);
  return state;
};

describe('burndown routes', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-burndown-api-'));
    auth.allow = true;
    auth.human = true;
    portfolio.selection = null;
    process.env.NEXTAUTH_SECRET = 'burndown-route-test-secret-at-least-32-bytes';
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('publishes a snapshot and serves it back', async () => {
    expect((await cliCall('GET')).body).toEqual({ burndown: null });
    const published = await cliCall('POST', snapshot());
    expect(published.statusCode).toBe(200);
    expect(published.body).toMatchObject({ ok: true, workspaceId: 'ws-sm', epics: 1, historyRows: 1, historyDropped: 0 });
    const read = await cliCall('GET');
    expect(read.statusCode).toBe(200);
    expect((read.body as { burndown: { snapshot: unknown; workspaceId: string } }).burndown)
      .toMatchObject({ workspaceId: 'ws-sm', snapshot: snapshot() });
  });

  it('refuses a malformed snapshot with the field that failed and stores nothing', async () => {
    const bad = snapshot();
    bad.epics[0].remaining = 9;
    const result = await cliCall('POST', bad);
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ error: 'Invalid burndown: epics[0]: saw burned 2 + remaining 9 = 11, expected total 5',
      code: 'invalid-burndown' });
    expect((await cliCall('GET')).body).toEqual({ burndown: null });
  });

  it('caps history at the newest rows', async () => {
    const body = snapshot();
    const start = Date.now() - (MAX_BURNDOWN_HISTORY + 10) * 60_000;
    body.history = Array.from({ length: MAX_BURNDOWN_HISTORY + 10 }, (_, index) => ({ ...body.history[0],
      at: new Date(start + index * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
    const result = await cliCall('POST', body);
    expect(result.body).toMatchObject({ historyRows: MAX_BURNDOWN_HISTORY, historyDropped: 10 });
  });

  it('refuses a snapshot that exceeds the stored size ceiling', async () => {
    const body = snapshot();
    const doneEvents = Array.from({ length: 1000 }, (_, index) => ({ at: generatedAt, points: index === 0 ? 2 : 0 }));
    body.epics = Array.from({ length: 100 }, (_, index) => ({ ...body.epics[0], slug: `epic-${index}`, done_events: doneEvents }));
    const result = await cliCall('POST', body);
    expect(result.statusCode).toBe(413);
    expect((result.body as { error: string }).error).toMatch(/^Burndown too large: saw \d+ bytes after capping history, expected at most 1048576$/);
  });

  it('enforces the workspace boundary and the method list', async () => {
    auth.allow = false;
    expect((await cliCall('POST', snapshot())).statusCode).toBe(403);
    auth.allow = true;
    expect((await cliCall('POST', snapshot(), 'ws-gone')).statusCode).toBe(404);
    expect((await cliCall('DELETE')).statusCode).toBe(405);
  });

  it('reports damaged storage as an error, not as nothing published', async () => {
    const dir = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-sm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'burndown.json'), 'not json');
    const result = await cliCall('GET');
    expect(result.statusCode).toBe(500);
    expect(result.body).toMatchObject({ code: 'burndown-unreadable' });
  });

  describe('mission control read', () => {
    it('requires a signed-in human', async () => {
      auth.human = false;
      expect((await missionCall()).statusCode).toBe(401);
    });

    it('answers no workspace before a Scrum Master is selected', async () => {
      const result = await missionCall();
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ workspaceId: null, burndown: null });
      expect(result.headers['Cache-Control']).toBe('no-store');
    });

    it('serves the selected Scrum Master workspace burndown', async () => {
      portfolio.selection = { managerWorkspaceId: 'ws-sm' };
      expect((await missionCall()).body).toEqual({ workspaceId: 'ws-sm', burndown: null });
      await cliCall('POST', snapshot());
      const result = await missionCall();
      expect(result.body).toMatchObject({ workspaceId: 'ws-sm', burndown: { workspaceId: 'ws-sm', snapshot: snapshot() } });
    });

    it('answers storage-unavailable for a damaged file', async () => {
      portfolio.selection = { managerWorkspaceId: 'ws-sm' };
      const dir = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-sm');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'burndown.json'), 'not json');
      const result = await missionCall();
      expect(result.statusCode).toBe(503);
      expect(result.body).toMatchObject({ code: 'storage-unavailable' });
    });

    it('refuses writes', async () => {
      expect((await missionCall('POST')).statusCode).toBe(405);
    });
  });
});
