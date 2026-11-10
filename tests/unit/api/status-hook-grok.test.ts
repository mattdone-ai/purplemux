import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const statusManager = vi.hoisted(() => ({
  applyAgentHookMeta: vi.fn(),
  handleToolActivity: vi.fn(),
  handleProviderEvent: vi.fn(),
  poll: vi.fn(async () => {}),
}));

vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => statusManager }));
vi.mock('@/lib/cli-token', () => ({ verifyCliToken: () => true }));
vi.mock('@/lib/access-filter', () => ({ isRequestAllowed: () => true }));

const TMUX_SESSION = 'pt-ws-hook-pane-1';
const SESSION_ID = '01a008c3-8e98-7220-a0d3-e0b36fa3aa99';

/**
 * A `post_tool_use` body as Grok Build pipes it: camelCase envelope, snake_case
 * event value. The route guard used to test `hook_event_name === 'PostToolUse'`,
 * which this payload can never satisfy on either the key or the value.
 */
const POST_TOOL_USE_BODY = {
  hookEventName: 'post_tool_use',
  sessionId: SESSION_ID,
  cwd: '/repo',
  workspaceRoot: '/repo',
  permissionMode: 'default',
  toolName: 'search_replace',
  toolInput: {
    target_file: '/repo/src/app.ts',
    old_string: 'const a = 1',
    new_string: 'const a = 2',
  },
  toolResult: { type: 'SearchReplace', success: true },
};

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
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
  return { state, res };
};

describe('POST /api/status/hook?provider=grok', () => {
  let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    statusManager.applyAgentHookMeta.mockReturnValue({ cliState: 'busy' });
    ({ default: handler } = await import('@/pages/api/status/hook'));
  });

  const post = async (body: unknown, query: Record<string, string> = {}) => {
    const { state, res } = fakeResponse();
    await handler({
      method: 'POST',
      query: { provider: 'grok', tmuxSession: TMUX_SESSION, ...query },
      body,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as NextApiRequest, res);
    return state;
  };

  it('feeds a recorded post_tool_use body to the signal engine', async () => {
    const state = await post(POST_TOOL_USE_BODY);

    expect(state.statusCode).toBe(204);
    expect(statusManager.handleToolActivity).toHaveBeenCalledWith('grok', TMUX_SESSION, expect.objectContaining({
      tool: 'search_replace',
      paths: ['/repo/src/app.ts'],
      failed: false,
    }), undefined);
  });

  it('also accepts the PascalCase event spelling the hook file registers under', async () => {
    await post({ ...POST_TOOL_USE_BODY, hookEventName: 'PostToolUse' });
    expect(statusManager.handleToolActivity).toHaveBeenCalledTimes(1);
  });

  it('reports a failed shell command as a failure signal', async () => {
    await post({
      hookEventName: 'post_tool_use',
      sessionId: SESSION_ID,
      toolName: 'run_terminal_command',
      toolInput: { command: 'pnpm test' },
      toolResult: { exit_code: 1 },
    });

    expect(statusManager.handleToolActivity).toHaveBeenCalledWith('grok', TMUX_SESSION, expect.objectContaining({
      tool: 'run_terminal_command',
      failed: true,
    }), undefined);
  });

  it('does not raise tool activity for a work-state event', async () => {
    await post({ hookEventName: 'stop', sessionId: SESSION_ID });

    expect(statusManager.handleToolActivity).not.toHaveBeenCalled();
    expect(statusManager.handleProviderEvent).toHaveBeenCalledWith('grok', TMUX_SESSION, { kind: 'stop' }, undefined, { replayed: false });
  });

  it('refuses a hook that names no tmux session', async () => {
    const { state, res } = fakeResponse();
    await handler({
      method: 'POST',
      query: { provider: 'grok' },
      body: POST_TOOL_USE_BODY,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as NextApiRequest, res);

    expect(state.statusCode).toBe(400);
    expect(statusManager.handleToolActivity).not.toHaveBeenCalled();
  });

  it('drops the hook when the tmux session is not one purplemux tracks', async () => {
    statusManager.applyAgentHookMeta.mockReturnValue(null);

    const state = await post(POST_TOOL_USE_BODY);

    expect(state.statusCode).toBe(204);
    expect(statusManager.handleToolActivity).not.toHaveBeenCalled();
  });

  it('returns a stranded needs-input tab to busy when a tool completes', async () => {
    statusManager.applyAgentHookMeta.mockReturnValue({ cliState: 'needs-input' });

    const state = await post(POST_TOOL_USE_BODY);

    expect(state.statusCode).toBe(204);
    expect(statusManager.handleToolActivity).toHaveBeenCalledTimes(1);
    expect(statusManager.handleProviderEvent).toHaveBeenCalledWith('grok', TMUX_SESSION, { kind: 'prompt-submit' }, undefined);
  });

  it('does not synthesise a prompt-submit while the tab is already busy', async () => {
    await post(POST_TOOL_USE_BODY);
    expect(statusManager.handleProviderEvent).not.toHaveBeenCalled();
  });
});
