import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ skip: true }));
vi.mock('@/lib/config-store', () => ({ getDangerouslySkipPermissions: vi.fn(async () => config.skip) }));
vi.mock('@/lib/hook-settings', () => ({ HOOK_SETTINGS_PATH: '/home/u/.purplemux/hooks.json' }));
vi.mock('@/lib/claude-prompt', () => ({
  getClaudePromptPath: (wsId: string) => `/home/u/.purplemux/workspaces/${wsId}/claude-prompt.md`,
  writeClaudePromptFile: vi.fn(),
}));

import { buildClaudeFlags } from '@/lib/claude-command';
import { claudeProvider } from '@/lib/providers/claude';
import { agentLaunchOptionsForTab } from '@/lib/agent-launch-policy';
import { buildFreshLaunchCommand } from '@/lib/agent-launch';
import {
  CHROME_DEVTOOLS_MCP_PACKAGE,
  checkEvaluatorBrowser,
  checkTabRole,
  evaluatorChromeMcpPath,
  EVALUATOR_MCP_FILTER_SCRIPT,
  evaluatorChromeMcpScript,
  evaluatorEvidenceRoot,
  evaluatorMcpFilterPath,
  evaluatorSqlPath,
  headlessChromePath,
  PG_CLIENT_DIR,
} from '@/lib/tab-role';

const userPsql = () => path.join(os.homedir(), PG_CLIENT_DIR, 'usr/lib/postgresql/18/bin/psql');
import type { TPanelType } from '@/types/terminal';

const run = promisify(execFile);
const SESSION = '01a008c1-bb96-71d1-9769-b63ff478fd9f';

/** The flags as the tab's shell would split them. */
const argv = async (command: string): Promise<string[]> => {
  const { stdout } = await run('sh', ['-c', `printf '%s\\0' ${command}`]);
  return stdout.split('\0').slice(0, -1);
};

const valueAfter = (args: string[], flag: string): string => {
  const at = args.indexOf(flag);
  expect(at, `${flag} in ${args.join(' ')}`).toBeGreaterThanOrEqual(0);
  return args[at + 1];
};

beforeEach(() => { config.skip = true; });

const ORIGIN = 'http://localhost:3100';
const EVALUATOR = { role: 'evaluator' as const, previewOrigin: ORIGIN };

describe('checkTabRole (ADR-0040)', () => {
  it('accepts a plain host on another port than this server; refuses a bracketed IPv6 host, naming the MCP limit', () => {
    const ipv6 = checkTabRole('evaluator', undefined, undefined, 'http://[::1]:3100/');
    expect(ipv6).toMatchObject({ ok: false, body: { code: 'invalid-request', error: expect.stringMatching(/IPv6.*chrome-devtools-mcp 1\.12\.0 cannot compile.*URL pattern.*use a hostname/) } });
    expect(checkTabRole('evaluator', undefined, undefined, 'http://preview-1.ai-server.ts.net:9000')).toMatchObject({ ok: true, previewOrigin: 'http://preview-1.ai-server.ts.net:9000' });
    const saved = process.env.PORT;
    process.env.PORT = '18555';
    try {
      expect(checkTabRole('evaluator', undefined, undefined, 'http://localhost:18555').ok).toBe(false);
      expect(checkTabRole('evaluator', undefined, undefined, 'http://localhost:8022')).toMatchObject({ ok: true, previewOrigin: 'http://localhost:8022' });
    } finally {
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });

  it('stores a valid pgService with the role and refuses a bad one or one without the role (AC 6)', () => {
    expect(checkTabRole('evaluator', undefined, undefined, ORIGIN, 'preview_42-ro')).toEqual({ ok: true, role: 'evaluator', previewOrigin: ORIGIN, pgService: 'preview_42-ro' });
    for (const bad of ['', 'a b', 'x;y', 'svc=1', 'a'.repeat(64), 42]) {
      expect(checkTabRole('evaluator', undefined, undefined, ORIGIN, bad), String(bad)).toMatchObject({ ok: false, body: { error: expect.stringMatching(/pgService must name/) } });
    }
    expect(checkTabRole(undefined, undefined, undefined, undefined, 'svc')).toMatchObject({ ok: false, body: { error: 'pgService goes with role evaluator' } });
  });

  it('names the reason a preview URL is refused', () => {
    const reason = (preview: unknown) => {
      const checked = checkTabRole('evaluator', undefined, undefined, preview);
      return checked.ok ? null : checked.body.error;
    };
    expect(reason(undefined)).toMatch(/previewUrl is required/);
    expect(reason('not a url')).toMatch(/is not a URL/);
    expect(reason('file:///etc/passwd')).toMatch(/must be http or https, not file:/);
    expect(reason('http://u:p@localhost:3100')).toMatch(/must not carry credentials/);
    expect(reason('http://*:9000')).toMatch(/host "\*" must be a hostname/);
    expect(reason('http://localhost:8022')).toMatch(/port 8022 is purplemux's own/);
  });

  it('passes an absent role and implies claude-code for evaluator, reducing the preview URL to its origin', () => {
    expect(checkTabRole(undefined, undefined, undefined, undefined)).toEqual({ ok: true });
    expect(checkTabRole('evaluator', undefined, undefined, 'http://localhost:3100/batches?x=1')).toEqual({ ok: true, role: 'evaluator', previewOrigin: ORIGIN });
    expect(checkTabRole('evaluator', 'claude-code', undefined, 'https://preview.example.test')).toEqual({ ok: true, role: 'evaluator', previewOrigin: 'https://preview.example.test' });
  });

  it('refuses an unknown role, another engine, a remote host, a missing or non-http preview, and a preview without the role', () => {
    const cases: Array<[unknown, TPanelType | undefined, unknown, unknown]> = [
      ['reviewer', undefined, undefined, ORIGIN], ['evaluator', 'codex-cli', undefined, ORIGIN], ['evaluator', 'terminal', undefined, ORIGIN],
      ['evaluator', 'claude-code', 'ai-server', ORIGIN], ['evaluator', undefined, undefined, undefined], ['evaluator', undefined, undefined, 'file:///etc/passwd'],
      ['evaluator', undefined, undefined, 'http://user:pw@localhost:3100'], ['evaluator', undefined, undefined, 'not a url'], [undefined, undefined, undefined, ORIGIN],
    ];
    for (const preview of ['http://*:8022', 'http://(x):9000', 'http://a+b:9000', 'http://localhost:8022', 'http://127.0.0.1:8022/x']) {
      cases.push(['evaluator', undefined, undefined, preview]);
    }
    for (const [role, type, host, preview] of cases) {
      const checked = checkTabRole(role, type, host, preview);
      expect(checked.ok, JSON.stringify([role, type, host, preview])).toBe(false);
      if (!checked.ok) expect(checked.body.code).toBe('invalid-request');
    }
  });
});

describe('the evaluator launch (AC 1)', () => {
  it('limits the built-ins, denies the edit tools and credential paths, allows only the read-only set, and drops bypass even when it is on', async () => {
    const args = await argv(await buildClaudeFlags('ws-1', { model: 'claude-opus-5-5', effort: 'xhigh', ...EVALUATOR }));
    expect(valueAfter(args, '--tools').split(',')).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(valueAfter(args, '--disallowedTools').split(',')).toEqual([
      'Edit', 'Write', 'NotebookEdit',
      'Read(~/.purplemux/**)', 'Read(~/.config/**)', 'Read(~/.aws/**)', 'Read(~/.ssh/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)',
      'Read(~/.gnupg/**)', 'Read(~/.netrc)', 'Read(~/.git-credentials)', 'Read(~/.docker/**)',
      'Read(~/.pg_service.conf)', 'Read(~/.pgpass)',
      'Read(//**/*token*)', 'Read(//**/*secret*)', 'Read(//**/*.pem)', 'Read(//**/*.key)',
      'Bash(docker:*)', 'Bash(ps:*)', 'Bash(pgrep:*)', 'Bash(lsof:*)', 'Bash(ss:*)',
    ]);
    expect(valueAfter(args, '--permission-mode')).toBe('dontAsk');
    expect(valueAfter(args, '--allowedTools').split(',')).toEqual([
      `Bash(${evaluatorSqlPath()}:*)`, 'mcp__chrome-devtools', 'Read', 'Grep', 'Glob',
    ]);
    expect(args).toContain('--strict-mcp-config');
    expect(valueAfter(args, '--setting-sources')).toBe('');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toEqual(expect.arrayContaining(['--settings', '/home/u/.purplemux/hooks.json', '--model', 'claude-opus-5-5', '--effort', 'xhigh']));
  });

  it('configures exactly one MCP server: chrome-devtools through the evaluator launcher, allowed the preview origin only', async () => {
    const args = await argv(await buildClaudeFlags('ws-1', EVALUATOR));
    expect(JSON.parse(valueAfter(args, '--mcp-config'))).toEqual({
      mcpServers: { 'chrome-devtools': { command: evaluatorChromeMcpPath(), args: [`${ORIGIN}/*`] } },
    });
  });

  it('fails closed: an evaluator launch without its preview origin is not built', async () => {
    await expect(buildClaudeFlags('ws-1', { role: 'evaluator' })).rejects.toThrow(/preview origin/);
    await expect(buildClaudeFlags('ws-1', { role: 'evaluator', previewOrigin: 'http://localhost:3100/x' })).rejects.toThrow(/preview origin/);
  });

  it('keeps bypass for an ordinary tab', async () => {
    const args = await argv(await buildClaudeFlags('ws-1', {}));
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--disallowedTools');
    expect(args).not.toContain('--tools');
  });

  it('carries the role, its origin and its PGSERVICE prefix on every path that relaunches the tab (AC 6)', async () => {
    const tab = { agentLaunchConfig: { model: 'claude-opus-5-5' }, ...EVALUATOR, pgService: 'preview_42' };
    const options = agentLaunchOptionsForTab(tab);
    expect(options).toEqual({ model: 'claude-opus-5-5', ...EVALUATOR, pgService: 'preview_42' });
    const resumed = await argv(await claudeProvider.buildResumeCommand(SESSION, { workspaceId: 'ws-1', ...options }));
    const launched = await argv(await claudeProvider.buildLaunchCommand({ workspaceId: 'ws-1', ...options }));
    const fresh = await argv((await buildFreshLaunchCommand('ws-1', { panelType: 'claude-code', ...tab }))!);
    expect(launched.slice(0, 2)).toEqual(['PGSERVICE=preview_42', 'claude']);
    expect(fresh.slice(0, 2)).toEqual(['PGSERVICE=preview_42', 'claude']);
    for (const args of [resumed, launched, fresh]) {
      expect(valueAfter(args, '--tools')).toBe('Read,Grep,Glob,Bash');
      expect(valueAfter(args, '--permission-mode')).toBe('dontAsk');
      expect(JSON.parse(valueAfter(args, '--mcp-config')).mcpServers['chrome-devtools'].args).toEqual([`${ORIGIN}/*`]);
      expect(args).not.toContain('--dangerously-skip-permissions');
    }
    expect(resumed.slice(0, 4)).toEqual(['PGSERVICE=preview_42', 'claude', '--resume', SESSION]);
  });

  it('gives an evaluator without --pg-service and an ordinary tab no environment prefix', async () => {
    expect((await claudeProvider.buildLaunchCommand({ workspaceId: 'ws-1', ...EVALUATOR })).startsWith('claude ')).toBe(true);
    expect((await claudeProvider.buildLaunchCommand({ workspaceId: 'ws-1', pgService: 'preview_42' })).startsWith('claude ')).toBe(true);
    await expect(claudeProvider.buildLaunchCommand({ workspaceId: 'ws-1', ...EVALUATOR, pgService: 'x;rm' })).rejects.toThrow(/not a service name/);
  });

  it('never launches an evaluator through the remote kit', async () => {
    await expect(buildFreshLaunchCommand('ws-1', { panelType: 'claude-code', host: 'ai-server', ...EVALUATOR }))
      .rejects.toThrow(/cannot run on remote host ai-server/);
  });
});

describe('checkEvaluatorBrowser (Chrome 149+ for --allowedUrlPattern)', () => {
  const fakeChrome = async (body: string | null) => {
    await fs.mkdir(path.dirname(headlessChromePath()), { recursive: true });
    await fs.rm(headlessChromePath(), { force: true });
    if (body !== null) await fs.writeFile(headlessChromePath(), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };

  it('accepts 149 and later, naming the version', async () => {
    await fakeChrome('echo "Google Chrome for Testing 156.0.8078.4"');
    expect(await checkEvaluatorBrowser()).toEqual({ ok: true, version: 'Google Chrome for Testing 156.0.8078.4' });
  });

  it('refuses an older or missing headless Chrome with a reason naming what it found', async () => {
    await fakeChrome('echo "Google Chrome for Testing 147.0.7727.15"');
    expect(await checkEvaluatorBrowser()).toEqual({ ok: false, error: expect.stringMatching(/needs Chrome 149\+.*147\.0\.7727\.15/) });
    await fakeChrome(null);
    expect(await checkEvaluatorBrowser()).toEqual({ ok: false, error: expect.stringContaining(headlessChromePath()) });
  });
});

describe('the evaluator scripts', () => {
  let fakeBin = '';
  let record = '';

  beforeEach(async () => {
    await buildClaudeFlags('ws-1', EVALUATOR);
    await fs.mkdir(path.dirname(headlessChromePath()), { recursive: true });
    await fs.writeFile(headlessChromePath(), '#!/bin/sh\necho "Google Chrome for Testing 156.0.8078.4"\n', { mode: 0o755 });
    fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-eval-bin-'));
    record = path.join(fakeBin, 'record');
    const recorder = `#!/bin/sh\n{ echo "PGOPTIONS=\${PGOPTIONS:-}"; echo "TMPDIR=\${TMPDIR:-}"; for a in "$@"; do echo "$a"; done; } > ${record}\n`;
    await fs.writeFile(path.join(fakeBin, 'npx'), recorder, { mode: 0o755 });
    // The user-space psql the wrapper runs by absolute path: it records its whole environment and argv.
    await fs.mkdir(path.dirname(userPsql()), { recursive: true });
    await fs.writeFile(userPsql(), `#!/bin/sh\n{ env | grep -v -E '^(PWD|SHLVL|_)=' | sort; echo --; for a in "$@"; do echo "$a"; done; } > ${record}\n`, { mode: 0o755 });
  });

  const script = async (file: string, args: string[], env: Record<string, string> = {}) => {
    try {
      await run(file, args, { env: { NODE_ENV: 'test', PATH: `${fakeBin}:/usr/bin:/bin`, HOME: os.homedir(), ...env } });
      return { code: 0, record: (await fs.readFile(record, 'utf-8')).split('\n').filter(Boolean), stderr: '' };
    } catch (err) {
      const failure = err as { code?: number; stderr?: string };
      return { code: failure.code ?? -1, record: [], stderr: failure.stderr ?? '' };
    }
  };

  it('evaluator-sql runs the user-space psql with a scrubbed environment, on the tab service, read-only, one statement (AC 7)', async () => {
    const result = await script(evaluatorSqlPath(), ['select count(*) from batches;  '], { PGSERVICE: 'preview_42', PGHOST: 'elsewhere', PGOPTIONS: '-c default_transaction_read_only=off' });
    expect(result.code, result.stderr).toBe(0);
    const client = path.join(os.homedir(), PG_CLIENT_DIR);
    expect(result.record).toEqual([
      `HOME=${os.homedir()}`, `LD_LIBRARY_PATH=${client}/usr/lib/x86_64-linux-gnu`, 'PGOPTIONS=-c default_transaction_read_only=on', '--',
      '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', 'service=preview_42', '-c', 'select count(*) from batches',
    ]);
  });

  it('evaluator-sql refuses without a service, with a bad one, and without the user-space psql', async () => {
    expect(await script(evaluatorSqlPath(), ['select 1'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/created without --pg-service/) });
    for (const bad of ['a b', 'x;y', 'service=evil host=h', 'a'.repeat(64)]) {
      expect(await script(evaluatorSqlPath(), ['select 1'], { PGSERVICE: bad }), bad).toMatchObject({ code: 2, stderr: expect.stringMatching(/PGSERVICE is not a service name/) });
    }
    await fs.rm(userPsql());
    expect(await script(evaluatorSqlPath(), ['select 1'], { PGSERVICE: 'preview_42' })).toMatchObject({ code: 2, stderr: expect.stringMatching(/no psql at .*postgresql\/18\/bin\/psql/) });
  });

  it('evaluator-sql refuses a second argument, a meta-command and a second statement', async () => {
    const refusals = [
      [['select 1', '-o', 'out.txt'], /exactly one argument/],
      [['\\! touch x'], /backslash is refused/],
      [['select 1; commit; insert into t values (1)'], /one statement only/],
      [[], /exactly one argument/],
    ] as const;
    for (const [args, message] of refusals) {
      const result = await script(evaluatorSqlPath(), [...args]);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr).toMatch(message);
    }
  });

  it('writes the launcher to run the filter on the server node, with its directory first on PATH', async () => {
    expect(await fs.readFile(evaluatorChromeMcpPath(), 'utf-8')).toBe(evaluatorChromeMcpScript({ node: process.execPath, pathPrefix: path.dirname(process.execPath) }));
    expect(await fs.readFile(evaluatorMcpFilterPath(), 'utf-8')).toBe(EVALUATOR_MCP_FILTER_SCRIPT);
    const script = evaluatorChromeMcpScript({ node: '/opt/node/bin/node', pathPrefix: '/opt/node/bin' });
    expect(script).toContain(`PATH='/opt/node/bin':"$PATH"`);
    expect(script).toContain(`exec '/opt/node/bin/node' "$HOME/.purplemux/bin/evaluator-mcp-filter.cjs" npx`);
    expect(evaluatorChromeMcpScript({ node: 'node', pathPrefix: null })).not.toContain('PATH=');
  });

  it('the filter drops the client roots capability from initialize and passes every other line through', async () => {
    const echo = "process.stdin.pipe(process.stdout)";
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, elicitation: {} }, clientInfo: { name: 'claude-code' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'take_screenshot', arguments: { roots: 'kept' } } }),
      'not json',
    ];
    const child = execFile(process.execPath, [evaluatorMcpFilterPath(), process.execPath, '-e', echo]);
    let out = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stdin!.end(`${lines.join('\n')}\n`);
    await new Promise((resolve) => child.on('close', resolve));
    const [init, call, raw] = out.trim().split('\n');
    expect(JSON.parse(init).params.capabilities).toEqual({ elicitation: {} });
    expect(call).toBe(lines[1]);
    expect(raw).toBe('not json');
  });

  it('evaluator-chrome-mcp starts the pinned chrome-devtools MCP on headless Chrome, writing under the tab evidence directory', async () => {
    const launcher = path.join(fakeBin, 'launcher');
    await fs.writeFile(launcher, evaluatorChromeMcpScript({ node: process.execPath, pathPrefix: fakeBin }), { mode: 0o755 });
    const result = await script(launcher, [`${ORIGIN}/*`], { PMUX_TAB_ID: 'tab-eval1' });
    expect(result.code).toBe(0);
    const evidence = path.join(evaluatorEvidenceRoot(), 'tab-eval1');
    expect(result.record).toEqual([
      'PGOPTIONS=', `TMPDIR=${evidence}/tmp`, '-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--headless', '--isolated',
      '--executablePath', path.join(os.homedir(), '.local/bin/headless-chrome'),
      '--workspace', evidence, '--allowedUrlPattern', `${ORIGIN}/*`, '--no-usage-statistics', '--no-performance-crux',
    ]);
    expect((await fs.stat(path.join(evidence, 'tmp'))).isDirectory()).toBe(true);
  });

  it('evaluator-chrome-mcp refuses to start outside a tab', async () => {
    for (const env of [{}, { PMUX_TAB_ID: '../repo' }] as Array<Record<string, string>>) {
      const result = await script(evaluatorChromeMcpPath(), [`${ORIGIN}/*`], env);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/PMUX_TAB_ID/);
    }
  });

  it('evaluator-chrome-mcp refuses to start without the allow-list or on a headless Chrome under 149', async () => {
    const none = await script(evaluatorChromeMcpPath(), [], { PMUX_TAB_ID: 'tab-eval1' });
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/one argument, the preview URL pattern/);
    await fs.writeFile(headlessChromePath(), '#!/bin/sh\necho "Google Chrome for Testing 147.0.7727.15"\n', { mode: 0o755 });
    const old = await script(evaluatorChromeMcpPath(), [`${ORIGIN}/*`], { PMUX_TAB_ID: 'tab-eval1' });
    expect(old.code).toBe(2);
    expect(old.stderr).toMatch(/needs Chrome 149\+; ~\/.local\/bin\/headless-chrome is Google Chrome for Testing 147.0.7727.15/);
  });
});
