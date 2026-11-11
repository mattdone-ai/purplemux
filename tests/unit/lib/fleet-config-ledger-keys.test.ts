import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import { V2_DEFAULT_ROUTE } from '@/lib/ledger-alarms';

// ADR-HFL-03 decision 1: `ledger.route.<ws>` and `ledger.threshold.<reason>` are checked at write time; the writers
// are ADR-0019's (the admin token or an enabled orchestrator).

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const orchestrator = (workspaceId: string): ICaller => ({
  scope: { type: 'workspace', workspaceId } as ICaller['scope'], workspaceId, tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false,
});
const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-keys-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('ledger alarm fleet keys', () => {
  it('an enabled orchestrator sets the v2 default table', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(orchestrator('ws-L7eUOX'), 'ledger.route.ws-ldhziO', { value: V2_DEFAULT_ROUTE }, authority))
      .toMatchObject({ key: 'ledger.route.ws-ldhziO', changed: true, value: { value: V2_DEFAULT_ROUTE } });
  });

  it.each([
    [admin, 'ledger.route.ws-ldhziO', '$holder=not-armed'],
    [admin, 'ledger.threshold.not-armed', '45'],
    [orchestrator('ws-a'), 'ledger.threshold.chain-down', 'off'],
    [orchestrator('ws-a'), 'ledger.threshold.red-main', '0'],
    [admin, 'ledger.chain-holds.ws-ldhziO', '/srv/v2/.v2/chain-holds.txt'],
  ])('%#: sets %s=%s', async (caller, key, value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(caller, key, { value }, authority)).toMatchObject({ key, changed: true });
  });

  it.each([
    ['ledger.route.ws-ldhziO', '$lander=red-main', 'unknown target $lander'],
    ['ledger.route.ws-ldhziO', 'v2-kit=no-such-reason', 'is not a wait reason'],
    ['ledger.threshold.not-armed', 'soon', 'off or minutes in 0..10080'],
    ['ledger.threshold.land-queue', '10081', 'off or minutes in 0..10080'],
    ['ledger.threshold.no-such-reason', '5', 'names no wait reason'],
    ['ledger.threshold.unknown', '5', 'names no wait reason'],
    ['ledger.route.', '$holder=not-armed', 'names no workspace'],
    ['ledger.route.ws.a', '$holder=not-armed', 'names no workspace'],
    ['ledger.chain-holds.ws-ldhziO', 'chain-holds.txt', 'must be an absolute file path'],
    ['ledger.chain-holds.ws-ldhziO', '/srv/../etc/passwd', 'must be an absolute file path'],
    ['ledger.chain-holds.', '/srv/v2/.v2/chain-holds.txt', 'names no workspace'],
  ])('%s=%j is refused (%s)', async (key, value, message) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value }, authority)).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(message) });
  });

  it('ledger.chain-holds.<ws> makes the server read a file: the admin token sets it, an orchestrator cannot', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator('ws-ldhziO'), 'ledger.chain-holds.ws-ldhziO', { value: '/srv/v2/.v2/chain-holds.txt' }, authority))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});
