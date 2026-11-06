import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// Story hfl2-10: `standup.dueMin` is checked at write time and written by the admin token only, so the orchestrator
// that the due line nags cannot turn it off for every workspace (ADR-0027 ruling R2).

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

describe('the standup fleet key', () => {
  it.each(['45', '0', '0.05', '1440'])('the admin token sets standup.dueMin = %j', async (value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(admin, 'standup.dueMin', { value }, authority)).toMatchObject({ key: 'standup.dueMin', changed: true });
  });

  it.each([
    ['standup.dueMin', '-1', 'must be minutes 0..1440 (0 turns the due line off), got "-1"'],
    ['standup.dueMin', '1441', 'must be minutes 0..1440'],
    ['standup.dueMin', 'off', 'must be minutes 0..1440'],
    ['standup.due-min', '45', 'is not a standup key: standup.dueMin'],
  ])('%s = %j is refused: %s', async (key, value, message) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value }, authority)).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(message) });
  });

  it('a workspace orchestrator can neither set nor unset it', async () => {
    const { putValue, deleteValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator, 'standup.dueMin', { value: '0' }, authority)).rejects.toMatchObject({ code: 'forbidden' });
    await putValue(admin, 'standup.dueMin', { value: '45' }, authority);
    await expect(deleteValue(orchestrator, 'standup.dueMin', {}, authority)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
