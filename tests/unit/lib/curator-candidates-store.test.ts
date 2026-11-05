import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Review r1 F8: the v2 candidate de-dup is keyed by message id, on disk (a restart never sends twice), bounded to 500.

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-candidates-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  delete (globalThis as Record<string, unknown>).__ptCuratorCandidatesLock;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the candidates-sent store', () => {
  it('remembers a key across a fresh module load, and keeps only the newest 500', async () => {
    vi.resetModules();
    const store = await import('@/lib/curator-store');
    expect(await store.candidateSent('ws-ldhziO/m1')).toBe(false);
    await Promise.all(Array.from({ length: 503 }, (_, i) => store.markCandidateSent(`ws-ldhziO/m${i}`)));
    await store.markCandidateSent('ws-ldhziO/m502');
    vi.resetModules();
    const again = await import('@/lib/curator-store');
    expect(await again.candidateSent('ws-ldhziO/m502')).toBe(true);
    expect(await again.candidateSent('ws-ldhziO/m2')).toBe(false);
    const keys = JSON.parse(fs.readFileSync(path.join(home, '.purplemux/curator/candidates-sent.json'), 'utf8')).keys as string[];
    expect(keys).toHaveLength(store.CANDIDATES_SENT_MAX);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
