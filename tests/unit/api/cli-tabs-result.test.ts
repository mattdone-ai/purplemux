import fs from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `tab result` (story 17, L7): the pane is captured with escapes so dim
// composer text reads as a suggestion, not as text someone typed.

const cliUtils = vi.hoisted(() => ({ authorizeWorkspace: vi.fn(), findTab: vi.fn() }));
const tmux = vi.hoisted(() => ({ hasSession: vi.fn(), capturePaneContentAnsi: vi.fn() }));
vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));

const CAPTURE = fs.readFileSync(path.join(__dirname, '../../fixtures/panes/claude-dim-suggestion.ansi'), 'utf-8');
const SUGGESTION = 'Billing cleared: re-run the listed runs and continue M2';

const get = async (query: Record<string, string>) => {
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/result');
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', query: { workspaceId: 'ws-1', tabId: 'tab-1', ...query } } as unknown as NextApiRequest, res);
  return state as { statusCode: number; body: { content: string | null; suggestion: string | null } };
};

describe('GET /api/cli/tabs/[tabId]/result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliUtils.authorizeWorkspace.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cliUtils.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'p', tab: { id: 'tab-1', sessionName: 's-1', panelType: 'claude-code' } });
    tmux.hasSession.mockResolvedValue(true);
    tmux.capturePaneContentAnsi.mockResolvedValue(CAPTURE);
  });

  it('marks the dim composer text and returns it as `suggestion`', async () => {
    const { statusCode, body } = await get({});
    expect(statusCode).toBe(200);
    expect(tmux.capturePaneContentAnsi).toHaveBeenCalledWith('s-1');
    expect(body.suggestion).toBe(SUGGESTION);
    expect(body.content).toContain(`[suggestion] ${SUGGESTION}`);
    expect(body.content).not.toContain('\x1b');
  });

  it('suggestions=0 (--no-suggestions) drops it', async () => {
    const { body } = await get({ suggestions: '0' });
    expect(body.suggestion).toBeNull();
    expect(body.content).not.toContain(SUGGESTION);
  });

  it('raw=1 (--raw) returns the escapes', async () => {
    const { body } = await get({ raw: '1' });
    expect(body.content).toBe(CAPTURE);
    expect(body.suggestion).toBe(SUGGESTION);
  });

  it('answers null content when the capture fails', async () => {
    tmux.capturePaneContentAnsi.mockResolvedValue(null);
    expect((await get({})).body).toEqual({ content: null, suggestion: null });
  });
});
