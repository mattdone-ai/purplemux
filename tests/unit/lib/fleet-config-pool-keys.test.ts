import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// ADR-0039: the pool's fleet keys and the per-workspace WIP cap are admin-only,
// and their values are checked at write time.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const orchestrator: ICaller = { scope: { type: 'workspace', workspaceId: 'ws-a' } as ICaller['scope'], workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false };
const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-pool-keys-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('pool fleet keys', () => {
  it.each([
    ['pool.slots.ai-lan.gate', '6'],
    ['pool.slots.mdserver1.build', '0'],
    ['pool.slots.ai-lan.test-service', '4'],
    ['pool.budget.ai-lan.threads', '64'],
    ['pool.budget.mdserver1.mem-gb', '91'],
    ['pool.budget.mdserver1.reserve-threads', '8'],
    ['pool.budget.mdserver1.reserve-mem-gb', '14.5'],
    ['pool.budget.ai-lan.max-load', '80'],
    ['pool.envelope.mutation.threads', '16'],
    ['pool.envelope.browser.mem-gb', '3'],
    ['pool.harness-share-pct', '25'],
    ['pool.mode', 'shadow'],
    ['pool.mode', 'enforce'],
    ['pool.fallback.ai-lan', 'ai-server'],
    ['pool.gate-host.ai-lan', 'gatehost-replica'],
    ['tabs.cap-per-workspace.ws-ldhziO', '14'],
    ['tabs.cap-per-workspace', '200'],
    ['tabs.cap-per-workspace.ws-a_B-9z', '1'],
  ])('the admin sets %s=%s', async (key, value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(admin, key, { value }, authority)).toMatchObject({ key, changed: true, value: { value } });
  });

  it.each(['pool.slots.ai-lan.gate', 'tabs.cap-per-workspace.ws-ldhziO'])('an orchestrator may not set %s', async (key) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator, key, { value: '6' }, authority)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each([
    ['pool.slots.ai-lan.gate', '65', 'whole number 0..64'],
    ['pool.slots.ai-lan.gate', 'six', 'whole number 0..64'],
    ['pool.fallback.ai-lan', '-oProxyCommand=x', 'ssh alias'],
    ['pool.gate-host.ai-lan', 'two words', 'ssh alias'],
    ['pool.slots.ai-lan.review', '2', 'not a pool key'],
    ['pool.anything', '2', 'not a pool key'],
    ['pool.budget.ai-lan.threads', '0', 'whole threads 1..4096'],
    ['pool.budget.ai-lan.mem-gb', 'lots', 'GiB 1..65536'],
    ['pool.budget.ai-lan.cores', '8', 'not a pool key'],
    ['pool.envelope.review.threads', '8', 'not a pool key'],
    ['pool.envelope.gate.threads', '1.5', 'whole threads'],
    ['pool.harness-share-pct', '150', 'a whole percent 0..100'],
    ['pool.mode', 'on', 'must be shadow or enforce'],
    ['pool.mode', 'Enforce', 'must be shadow or enforce'],
    ['remote.hosts', 'ai-lan,auto', 'cannot name a host "auto"'],
    ['tabs.cap-per-workspace', '0', 'integer 1..200'],
    ['tabs.cap-per-workspace', 'eight', 'integer 1..200'],
    ['tabs.cap-per-workspace.ws-ldhziO', '201', 'integer 1..200'],
    ['tabs.cap-per-workspace.ws-ldhziO', '2.5', 'integer 1..200'],
    ['tabs.cap-per-workspace.ws.x', '5', 'not a cap key'],
  ])('%s=%j is refused (%s)', async (key, value, message) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value }, authority)).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(message) });
  });
});
