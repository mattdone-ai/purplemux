import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_FLEET_ORDERS } from '@/lib/standing-orders-seed';

// Review r1, R4: the seed is written once and never rewritten, so every `purplemux ...` command a seed order tells
// a tab to run must be one the CLI accepts as a tab runs it (PMUX_WORKSPACE_ID set, no -w). With no server to
// answer, an accepted command exits 6 (server unreachable); a refused one exits 2 (usage).

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
let home: string;

beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-seed-cmd-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

const commands = SEED_FLEET_ORDERS.flatMap((order) => [...order.text.matchAll(/`(purplemux [^`]+)`/g)].map((m) => ({ id: order.id, command: m[1] })));

describe('the seed orders\' commands run as written (R4)', () => {
  it('names at least one command', () => {
    expect(commands.map((c) => c.id)).toContain('SO-7');
  });

  it.each(commands)('$id: $command is accepted by the CLI parser in a tab', async ({ command }) => {
    const argv = command.split(/\s+/).slice(1);
    const code = await run(process.execPath, [ENTRY, ...argv], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, PMUX_PORT: '59999', PMUX_TOKEN: 'x', PMUX_WORKSPACE_ID: 'ws-a', NO_UPDATE_NOTIFIER: '1' },
    }).then(() => 0, (err: { code?: number; stderr?: string }) => (err.code === 2 ? `usage: ${err.stderr}` : err.code));
    expect(code).toBe(6);
  });
});
