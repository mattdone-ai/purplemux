import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// F6 change 2 deletes the standup due line, so no `standup.*` key is read: a write is refused, never silently kept.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const orchestrator: ICaller = {
  scope: { type: 'workspace', workspaceId: 'ws-a' } as ICaller['scope'], workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false,
};
const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-standup-keys-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the retired standup fleet key', () => {
  it.each(['standup.dueMin', 'standup.due-min'])('the admin token cannot set %s: it reads nothing', async (key) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value: '45' }, authority))
      .rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('the standup due line (standup.dueMin) was deleted by F6') });
  });

  it('a workspace orchestrator cannot set it either', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator, 'standup.dueMin', { value: '0' }, authority)).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|config-invalid/) });
  });
});
