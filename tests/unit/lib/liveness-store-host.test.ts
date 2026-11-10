import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobHoldsWork } from '@/lib/background-job-state';

let baseDir: string;

vi.mock('@/lib/layout-store', () => ({
  resolveLayoutDir: (wsId: string) => path.join(baseDir, wsId),
}));

import { readLivenessEvidence, upsertJob } from '@/lib/liveness-store';

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-store-host-'));
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('a saved job names its host (D63)', () => {
  it('round-trips the host and reads a job with none as before', async () => {
    await upsertJob({ workspaceId: 'ws-h', tabId: 'tab-1', pid: 1, host: 'host-b-lan', registeredAt: 1 });
    await upsertJob({ workspaceId: 'ws-h', tabId: 'tab-1', pid: 2, registeredAt: 1 });
    const evidence = await readLivenessEvidence('ws-h');
    expect(evidence).toEqual({ known: true, data: { probes: [], jobs: [
      { workspaceId: 'ws-h', tabId: 'tab-1', pid: 1, host: 'host-b-lan', registeredAt: 1 },
      { workspaceId: 'ws-h', tabId: 'tab-1', pid: 2, registeredAt: 1 },
    ] } });
  });

  it('round-trips host null, the local marker that hydration never fills in', async () => {
    await upsertJob({ workspaceId: 'ws-n', tabId: 'tab-1', pid: 3, host: null, registeredAt: 1 });
    expect(await readLivenessEvidence('ws-n')).toEqual({ known: true, data: { probes: [], jobs: [
      { workspaceId: 'ws-n', tabId: 'tab-1', pid: 3, host: null, registeredAt: 1 },
    ] } });
  });

  it.each([['-oProxyCommand=x'], ['ai lan'], [42]])('refuses the file when a job names the host %j', async (host) => {
    const dir = path.join(baseDir, 'ws-bad');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'liveness.json'), JSON.stringify({ probes: [], jobs: [{ workspaceId: 'ws-bad', tabId: 't', pid: 1, host, registeredAt: 1 }] }));
    expect(await readLivenessEvidence('ws-bad')).toEqual({ known: false });
  });
});

describe('jobHoldsWork', () => {
  it('holds for an attested-alive job and an unknown one, not for an exited one', () => {
    expect(jobHoldsWork({ alive: true, state: 'alive' })).toBe(true);
    expect(jobHoldsWork({ alive: false, state: 'unknown' })).toBe(true);
    expect(jobHoldsWork({ alive: false, state: 'exited' })).toBe(false);
    expect(jobHoldsWork({ alive: false })).toBe(false);
    expect(jobHoldsWork({ alive: true })).toBe(true);
  });
});
