import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/layout-store', () => ({ resolveLayoutDir: () => state.dir }));

import { getClaudePromptPath, writeClaudePromptFile } from '@/lib/claude-prompt';
import type { IWorkspace } from '@/types/terminal';

const workspace = { id: 'ws-prompt', name: 'prompt', directories: ['/srv/prompt'] } as unknown as IWorkspace;

beforeEach(async () => {
  state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-prompt-'));
});
afterEach(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

const written = async (): Promise<string> => {
  await writeClaudePromptFile(workspace);
  return fs.readFile(getClaudePromptPath(workspace.id), 'utf8');
};

describe('the workspace prompt (story 15, AC 2)', () => {
  it('tells a tab once how to wait, and never to poll', async () => {
    const body = await written();
    expect(body).not.toMatch(/\bpoll\b/i);
    expect(body.match(/not a shell poller/g)).toHaveLength(1);
  });

  it('lists grok-cli among the tab types it creates and the tmux tabs', async () => {
    const body = await written();
    expect(body).toContain('claude-code | codex-cli | grok-cli | agent-sessions');
    expect(body).toContain('`terminal` / `claude-code` / `codex-cli` / `grok-cli` tabs');
  });
});
