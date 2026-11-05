import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Story 23 AC 2: a product rule is appended to ~/.purplemux/workspaces/<ws>/spec-queue.md with its message id.

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-spec-queue-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  delete (globalThis as Record<string, unknown>).__ptSpecQueueLock;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the spec queue (AC 2)', () => {
  it('appends each rule under its message id, quoted, after a header; a repeat of the same id is left as it is', async () => {
    vi.resetModules();
    const { appendProductRule, specQueuePath } = await import('@/lib/spec-queue');
    const at = Date.parse('2026-11-03T04:05:06.789Z');
    expect(await appendProductRule('ws-a', 'm1', at, 'The board must show AEDT times.\nNever UTC.')).toBe(true);
    expect(await appendProductRule('ws-a', 'm2', at, 'Payouts need a reference.')).toBe(true);
    expect(await appendProductRule('ws-a', 'm1', at, 'again')).toBe(false);
    const text = fs.readFileSync(specQueuePath('ws-a'), 'utf-8');
    expect(specQueuePath('ws-a')).toBe(path.join(home, '.purplemux/workspaces/ws-a/spec-queue.md'));
    expect(text.startsWith('# Spec queue: ws-a\n')).toBe(true);
    expect(text).toContain('## m1\n- at: 2026-11-03T04:05:06Z\n- source: owner message ws-a/m1\n\n> The board must show AEDT times.\n> Never UTC.');
    expect(text.indexOf('## m1')).toBeLessThan(text.indexOf('## m2'));
    expect(text).not.toContain('again');
  });

  it('two appends at once both land (one lock serialises them)', async () => {
    vi.resetModules();
    const { appendProductRule, specQueuePath } = await import('@/lib/spec-queue');
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => appendProductRule('ws-a', id, 0, `rule ${id}`)));
    const text = fs.readFileSync(specQueuePath('ws-a'), 'utf-8');
    expect(['a', 'b', 'c', 'd'].every((id) => text.includes(`## ${id}\n`))).toBe(true);
  });

  it('refuses a workspace that is not an id, so no path leaves the workspaces directory', async () => {
    vi.resetModules();
    const { appendProductRule } = await import('@/lib/spec-queue');
    await expect(appendProductRule('../etc', 'm1', 0, 'x')).rejects.toThrow('is not a workspace id');
    await expect(appendProductRule('ws-a', '../m', 0, 'x')).rejects.toThrow('the message id is not an id');
  });
});
