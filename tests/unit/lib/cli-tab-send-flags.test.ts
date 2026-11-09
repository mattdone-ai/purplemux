import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
// The installed entry point: ~/.local/bin/purplemux resolves to bin/purplemux.js.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'purplemux.js');

/** fetch refuses port 1 before connecting, so a command that reaches the network still fails fast. */
const ENV: NodeJS.ProcessEnv = { ...process.env, PMUX_PORT: '1', PMUX_TOKEN: 'test-token', NO_UPDATE_NOTIFIER: '1' };
// A remote tab's pane carries PMUX_URL (ADR-0022 §15), which wins over PMUX_PORT and names a live server; the
// caller's tab token wins over PMUX_TOKEN. Neither may leak in.
delete ENV.PMUX_URL;
delete ENV.PMUX_TAB_TOKEN;

const cli = async (args: string[]): Promise<{ code: number; stderr: string }> => {
  try {
    await run('node', [CLI, ...args], { env: ENV });
    return { code: 0, stderr: '' };
  } catch (err) {
    const failure = err as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? '' };
  }
};

describe('purplemux tab send --wait-ms', () => {
  it('rejects the flag with no value instead of silently using the default', async () => {
    // Flags are read only before the content (story 14 r2), so the value-less flag is the last word.
    const { code, stderr } = await cli(['tab', 'send', '-w', 'ws-x', 'tab-1', '--wait-ms']);

    expect(code).toBe(2);
    expect(stderr).toContain('--wait-ms must be a whole number of milliseconds');
  });

  it('rejects a value that is not a whole number', async () => {
    const { stderr } = await cli(['tab', 'send', '-w', 'ws-x', '--wait-ms', 'soon', 'tab-1', 'hello']);
    expect(stderr).toContain('--wait-ms must be a whole number of milliseconds');
  });

  it('still refuses --no-wait together with --wait-ms', async () => {
    const { stderr } = await cli([
      'tab', 'send', '-w', 'ws-x', '--wait-ms', '500', '--no-wait', 'tab-1', 'hello',
    ]);
    expect(stderr).toContain('--no-wait and --wait-ms are mutually exclusive');
  });

  it('accepts a whole number and gets as far as the request', async () => {
    const { stderr } = await cli(['tab', 'send', '-w', 'ws-x', '--wait-ms', '500', 'tab-1', 'hello']);
    expect(stderr).not.toContain('--wait-ms must be');
  });
});
