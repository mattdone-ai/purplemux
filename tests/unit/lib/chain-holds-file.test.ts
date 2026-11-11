import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => log };
});

const { readChainHoldsFile } = await import('@/lib/flag-alerts');
const { CHAIN_HOLDS_MAX_BYTES } = await import('@/lib/chain-down-quiet');

// vel-WATCHDOG-F6-NOISE review r1: the hold-list reader is bounded in bytes AND in time. A path an agent can replace
// (a FIFO with no writer, a directory) is refused at once, never waited on.
const dir = mkdtempSync(join(tmpdir(), 'chain-holds-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, data: string | Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};

describe('readChainHoldsFile', () => {
  it('returns the text of a regular file', async () => {
    await expect(readChainHoldsFile(file('ok.txt', 'visa:abcdef01 held 2026-11-13T09:00:00Z x\n'))).resolves.toBe(
      'visa:abcdef01 held 2026-11-13T09:00:00Z x\n',
    );
  });

  it('returns null for an absent file', async () => {
    await expect(readChainHoldsFile(join(dir, 'absent.txt'))).resolves.toBeNull();
  });

  it('accepts exactly the byte cap and refuses one byte more', async () => {
    await expect(readChainHoldsFile(file('cap.txt', 'a'.repeat(CHAIN_HOLDS_MAX_BYTES)))).resolves.toHaveLength(CHAIN_HOLDS_MAX_BYTES);
    await expect(readChainHoldsFile(file('big.txt', 'a'.repeat(CHAIN_HOLDS_MAX_BYTES + 1)))).rejects.toThrow(/larger than/);
  });

  it('refuses invalid UTF-8', async () => {
    await expect(readChainHoldsFile(file('bad.txt', Buffer.from([0x61, 0xff, 0x62])))).rejects.toThrow();
  });

  it('refuses a NUL', async () => {
    await expect(readChainHoldsFile(file('nul.txt', 'a\u0000b'))).rejects.toThrow(/NUL/);
  });

  it('refuses a directory', async () => {
    await expect(readChainHoldsFile(dir)).rejects.toThrow();
  });

  it('refuses a FIFO with no writer at once, without a wait', async () => {
    const fifo = join(dir, 'holds.fifo');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    await expect(readChainHoldsFile(fifo)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
