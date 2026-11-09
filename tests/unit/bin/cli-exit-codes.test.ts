import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The installed entry point, never bin/cli.js: `~/.local/bin/purplemux`
// resolves to bin/purplemux.js, and a command it does not register answers
// `unknown command` before cli.js ever runs.
const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

type TStubReply = (req: IRecordedRequest, res: http.ServerResponse) => void;

let server: http.Server;
let port = 0;
let reply: TStubReply = (_req, res) => res.end();
const requests: IRecordedRequest[] = [];

const json = (status: number, body: unknown): TStubReply => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A port nothing listens on: bind it, then release it. */
const closedPort = async (): Promise<number> => {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-cli-exit-'));

const cli = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        HOME: home,
        NO_UPDATE_NOTIFIER: '1',
        PMUX_PORT: String(port),
        PMUX_TOKEN: 'test-token',
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined };
      requests.push(recorded);
      reply(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  requests.length = 0;
  reply = (_req, res) => res.end();
});

describe('tab send — permanent and retryable failures are distinct', () => {
  it('exits 4 for a tab that does not exist, and says not to retry', async () => {
    reply = json(404, { error: 'Tab not found', code: 'tab-not-found' });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(4);
    expect(stderr).toContain('tab-not-found');
    expect(stderr).toContain('do not retry');
  });

  it('exits 4 for a tab whose tmux session is dead', async () => {
    reply = json(409, {
      error: 'agent-not-ready',
      code: 'session-not-running',
      tabId: 'tab-x',
      cliState: null,
      detail: 'session-not-running',
    });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(4);
    expect(stderr).toContain('session-not-running');
    expect(stderr).toContain('do not retry');
  });

  it('exits 5 for an agent that never became ready, naming the waited milliseconds', async () => {
    reply = json(409, {
      error: 'agent-not-ready',
      code: 'readiness-timeout',
      tabId: 'tab-x',
      cliState: 'inactive',
      detail: 'readiness-timeout',
      waitedMs: 1000,
    });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', '--wait-ms', '1000', 'tab-x', 'hi']);

    expect(code).toBe(5);
    expect(stderr).toContain('readiness-timeout');
    expect(stderr).toContain('1000 ms');
    expect(requests[0].body).toEqual({ content: 'hi', waitMs: 1000 });
  });

  it('exits 5 at once for an agent at a startup prompt, naming the dialog and the fix the server served (story 05, D14)', async () => {
    reply = json(409, {
      error: 'agent-not-ready',
      code: 'startup-prompt',
      tabId: 'tab-x',
      cliState: 'startup-prompt',
      startupPrompt: 'folder-trust',
      startupPromptLabel: 'the folder-trust prompt',
      detail: 'the agent waits at the folder-trust prompt: answer it in the tab, or create the tab with --cwd under a workspace directory, which purplemux pre-trusts',
    });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(5);
    expect(stderr).toContain('error: startup-prompt (the agent waits at the folder-trust prompt: answer it in the tab, or create the tab with --cwd');
    expect(stderr).toContain('nothing was typed; a retry cannot help until the prompt is answered');
    expect(stderr).not.toContain('retry, bounded');
  });

  it('a startup-prompt refusal without a served sentence still names the prompt in words', async () => {
    reply = json(409, { error: 'agent-not-ready', code: 'startup-prompt', tabId: 'tab-x' });
    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);
    expect(code).toBe(5);
    expect(stderr).toContain('the agent waits at a Claude Code startup prompt');
  });

  it('exits 4 for a tab replaced while the send waited', async () => {
    reply = json(409, { error: 'agent-target-changed', code: 'target-changed', tabId: 'tab-x' });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(4);
    expect(stderr).toContain('target-changed');
  });

  it('still classifies the bodies a pre-contract server returns', async () => {
    reply = json(404, { error: 'Tab not found' });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(4);

    reply = json(409, { error: 'agent-not-ready', detail: 'readiness-timeout', waitedMs: 5 });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(5);

    reply = json(409, { error: 'agent-not-ready', detail: 'session-not-running' });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(4);

    reply = json(409, { error: 'agent-target-changed', tabId: 'tab-x' });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(4);

    reply = json(409, { error: 'Tab session is not running' });
    expect((await cli(['tab', 'result', '-w', 'WS', 'tab-x'])).code).toBe(4);

    reply = json(409, { error: 'session not found' });
    expect((await cli(['tab', 'steer', '-w', 'WS', 'tab-x', 'fix it'])).code).toBe(4);
  });

  it('tab result passes --raw / --no-suggestions as query flags and refuses both together', async () => {
    reply = json(200, { content: 'x', suggestion: null });
    requests.length = 0;
    expect((await cli(['tab', 'result', '-w', 'WS', 'tab-x', '--raw'])).code).toBe(0);
    expect((await cli(['tab', 'result', '--no-suggestions', '-w', 'WS', 'tab-x'])).code).toBe(0);
    expect((await cli(['tab', 'result', '-w', 'WS', 'tab-x'])).code).toBe(0);
    expect(requests.map((r) => r.url)).toEqual([
      '/api/cli/tabs/tab-x/result?workspaceId=WS&raw=1',
      '/api/cli/tabs/tab-x/result?workspaceId=WS&suggestions=0',
      '/api/cli/tabs/tab-x/result?workspaceId=WS',
    ]);
    const both = await cli(['tab', 'result', '-w', 'WS', 'tab-x', '--raw', '--no-suggestions']);
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain('exclusive');
  });

  it('grant list is read-only: one line per grant, --json passes the body, and nothing creates a grant', async () => {
    const future = Date.now() + 3_600_000;
    reply = json(200, { grants: [
      { id: 'g-aaaa1', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], reason: 'portfolio', expiresAt: future, revokedAt: null, revokeReason: null },
      { id: 'g-bbbb2', grantee: { workspaceId: 'ws-1', tabId: 'tab-b' }, workspaces: ['ws-3'], reason: 'old', expiresAt: future, revokedAt: 1, revokeReason: 'grantee-tab-closed' },
    ] });
    requests.length = 0;
    const listed = await cli(['grant', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/^g-aaaa1 {2}ws-1\/tab-a reads ws-2 {2}active until .+ {2}"portfolio"$/m);
    expect(listed.stdout).toMatch(/^g-bbbb2 .* ended \(grantee-tab-closed\)/m);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/cli/grants']);
    expect(JSON.parse((await cli(['grant', 'list', '--json'])).stdout).grants).toHaveLength(2);
    const create = await cli(['grant', 'create', '--tab', 'x']);
    expect(create.code).toBe(2);
    expect(create.stderr).toContain('web UI only');
  });

  it('grant list shows an owner grant as capability: owner workspaces: * (ADR-0029)', async () => {
    const future = Date.now() + 3_600_000;
    reply = json(200, { grants: [
      { id: 'g-drive1', capability: 'drive', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], reason: 'portfolio', expiresAt: future, revokedAt: null, revokeReason: null },
      { id: 'g-owner1', capability: 'owner', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaces: ['*'], reason: 'owner session', expiresAt: future, revokedAt: null, revokeReason: null },
    ] });
    const listed = await cli(['grant', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/^g-drive1 {2}ws-1\/tab-a reads ws-2 {2}active until /m);
    expect(listed.stdout).toMatch(/^g-owner1 {2}ws-1\/tab-o capability: owner workspaces: \* {2}active until .+ {2}"owner session"$/m);
    expect(JSON.parse((await cli(['grant', 'list', '--json'])).stdout).grants[1]).toMatchObject({ capability: 'owner', workspaces: ['*'] });
  });

  it('exits 1 for a success that is not JSON: another server holds the port', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    };

    const { code, stdout, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('without a JSON body');
  });

  it('exits 6 with routes-absent for a 404 without JSON: the server predates the route', async () => {
    reply = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>404</html>');
    };

    const { code, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(6);
    expect(stderr).toContain('routes-absent');
  });

  it('still exits 7 for a JSON not-found: the server answered, the thing is absent', async () => {
    reply = json(404, { error: 'no lease named merge:x/y', code: 'lease-not-found' });
    expect((await cli(['tab', 'status', '-w', 'WS', 'tab-x'])).code).toBe(7);
  });

  it('accepts the longest wait the CLI can hold open', async () => {
    reply = json(200, { status: 'sent', submitted: true, cliState: 'idle' });

    const { code } = await cli(['tab', 'send', '-w', 'WS', '--wait-ms', '240000', 'tab-x', 'hi']);

    expect(code).toBe(0);
    expect(requests[0].body).toEqual({ content: 'hi', waitMs: 240000 });
  });

  it('prints the success body and exits 0', async () => {
    reply = json(200, { status: 'sent', submitted: true, cliState: 'idle' });

    const { code, stdout } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: 'sent', submitted: true, cliState: 'idle' });
  });

  it('exits 0 for a submission the server proved (vel-RETRO-R3)', async () => {
    reply = json(200, { status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: false });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it.each([
    ['typed-not-submitted', 'the text is in the composer; do not resend; inspect the tab'],
    ['submit-unconfirmed', 'the text was typed and no turn was seen; do not resend; inspect the tab'],
  ])('exits 1 for %s, prints the body, and says not to resend (vel-RETRO-R3)', async (notSubmitted, hint) => {
    const body = { status: 'sent', submitted: false, cliState: 'idle', confirmation: null, resubmitted: true, notSubmitted };
    reply = json(200, body);

    const { code, stdout, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual(body);
    expect(stderr).toBe(`error: ${notSubmitted} (${hint}) — tab tab-x (Enter was pressed once more)\n`);
  });

  it('names the screen reading of a readiness timeout (vel-RETRO-R3)', async () => {
    reply = json(409, {
      error: 'agent-not-ready', code: 'readiness-timeout', tabId: 'tab-x', cliState: 'idle', detail: 'readiness-timeout', waitedMs: 60000, screen: 'composer-not-empty',
    });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(5);
    expect(stderr).toContain('not ready after 60000 ms, cliState idle, screen composer-not-empty');
  });
});

describe('tab send exit codes match the labels of a caller that retries (maintenance.sh deliver, review r1 F5)', () => {
  // The library's maintenance.sh reads tab send as: 0 sent (then reads `submitted`), 4 gone (never retried),
  // 5 and 6 retried in the next round, anything else failed:exit-<rc> once. A typed send without proof must
  // land in the last label: a 5 or 6 would type the brief twice.
  const reasons = Object.freeze({ 0: 'sent', 4: 'gone', 5: 'retried', 6: 'retried' } as Record<number, string>);
  const label = (rc: number): string => reasons[rc] ?? `failed:exit-${rc}`;

  it.each<[string, () => TStubReply, number, string]>([
    ['a proven submission', () => json(200, { status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: false }), 0, 'sent'],
    ['typed-not-submitted', () => json(200, { status: 'sent', submitted: false, cliState: 'idle', confirmation: null, resubmitted: true, notSubmitted: 'typed-not-submitted' }), 1, 'failed:exit-1'],
    ['submit-unconfirmed after the typing', () => json(200, { status: 'sent', submitted: false, cliState: 'idle', confirmation: null, resubmitted: false, notSubmitted: 'submit-unconfirmed' }), 1, 'failed:exit-1'],
    ['submit-unconfirmed before the typing', () => json(409, { error: 'submit-unconfirmed', code: 'submit-unconfirmed', tabId: 'tab-x', typed: false, detail: 'no-submit-evidence' }), 1, 'failed:exit-1'],
    ['tab-not-found', () => json(404, { error: 'tab-not-found', code: 'tab-not-found' }), 4, 'gone'],
    ['session-not-running', () => json(409, { error: 'agent-not-ready', code: 'session-not-running', tabId: 'tab-x' }), 4, 'gone'],
    ['target-changed', () => json(409, { error: 'target-changed', code: 'target-changed', tabId: 'tab-x' }), 4, 'gone'],
    ['readiness-timeout', () => json(409, { error: 'agent-not-ready', code: 'readiness-timeout', tabId: 'tab-x', cliState: 'busy', waitedMs: 100 }), 5, 'retried'],
    ['remote-host-unreachable', () => json(503, { error: 'remote-host-unreachable', code: 'remote-host-unreachable', host: 'h' }), 6, 'retried'],
  ])('%s exits %i (%s)', async (_name, served, expected, expectedLabel) => {
    reply = served();

    const { code } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(expected);
    expect(label(code)).toBe(expectedLabel);
  });

  it('says nothing was typed for a send refused before the typing (review r1 F4)', async () => {
    reply = json(409, { error: 'submit-unconfirmed', code: 'submit-unconfirmed', tabId: 'tab-x', typed: false, detail: 'no-submit-evidence' });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(1);
    expect(stderr).toContain('submit-unconfirmed (nothing was typed: the server holds no status for the tab to prove a turn against; inspect the tab)');
    expect(stderr).not.toContain('do not resend');
  });
});

describe('the code → exit table', () => {
  // The pinned table in architecture.md "CLI exit-code contract". Later
  // stories add routes that return these codes; the CLI already maps them.
  const TABLE: Array<[string, number]> = [
    ['gh-unavailable', 1],
    ['lease-policy', 2],
    ['watch-invalid', 2],
    ['reports-to-invalid', 2],
    ['report-on-invalid', 2],
    ['note-too-large', 2],
    ['config-invalid', 2],
    ['note-target-missing', 2],
    ['lease-held', 3],
    ['lease-held-by-other', 3],
    ['watch-cap', 3],
    ['forbidden', 3],
    ['inbox-not-held', 3],
    ['grant-tab-unverified', 3],
    ['config-version-conflict', 3],
    ['caller-unresolved', 3],
    ['grant-password-invalid', 3],
    ['grant-locked', 3],
    ['grant-owner-active', 3],
    ['tab-not-found', 4],
    ['session-not-running', 4],
    ['target-changed', 4],
    ['readiness-timeout', 5],
    ['startup-prompt', 5],
    ['lease-not-found', 7],
    ['note-not-found', 7],
    ['watch-not-found', 7],
    ['inbox-not-found', 7],
    ['deploy-not-found', 7],
    ['config-not-found', 7],
  ];

  it.each(TABLE)('maps %s to exit %i', async (code, exit) => {
    reply = json(409, { error: `server said ${code}`, code });

    const result = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
    expect(result.stderr).toContain(`server said ${code}`);
  });

  it('exits 1 for a code the table does not know', async () => {
    reply = json(409, { error: 'agent-model-mismatch', tabId: 'tab-x' });

    const { code, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stderr).toContain('agent-model-mismatch');
  });

  it('exits 1 for a 5xx without a body', async () => {
    reply = (_req, res) => { res.writeHead(500); res.end(); };

    const { code, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stderr).toContain('HTTP 500');
  });

  it('does not let an inherited prototype key pass as a code', async () => {
    reply = json(409, { error: 'odd', code: 'constructor' });

    expect((await cli(['tab', 'status', '-w', 'WS', 'tab-x'])).code).toBe(1);
  });
});

describe('server unreachable', () => {
  it.each([
    [['workspaces']],
    [['tab', 'list', '-w', 'WS']],
    [['tab', 'send', '-w', 'WS', 'tab-x', 'hi']],
    [['tab', 'close', '-w', 'WS', 'tab-x']],
    [['api-guide']],
    [['tab', 'browser', 'screenshot', '-w', 'WS', 'tab-x', '-o', path.join(home, 'shot.png')]],
  ])('exits 6 for %j when nothing listens on the port', async (args) => {
    const { code, stderr } = await cli(args, { PMUX_PORT: String(await closedPort()) });

    expect(code).toBe(6);
    expect(stderr).toContain('server-unreachable');
  });

  it('exits 6 when no port is configured at all', async () => {
    const { code } = await cli(['workspaces'], { PMUX_PORT: '' });
    expect(code).toBe(6);
  });

  it('exits 6 when no token is configured at all', async () => {
    const { code, stderr } = await cli(['workspaces'], { PMUX_TOKEN: '' });
    expect(code).toBe(6);
    expect(stderr).toContain('server-unreachable');
    expect(requests).toHaveLength(0);
  });

  it.each([
    [['tab', 'status', '-w', 'WS', 'tab-x']],
    [['tab', 'send', '-w', 'WS', 'tab-x', 'hi']],
  ])('exits 1 for %j when the request could never be sent (a malformed port)', async (args) => {
    const { code, stderr } = await cli(args, { PMUX_PORT: 'abc' });

    expect(code).toBe(1);
    expect(stderr).toContain('request not sent');
    expect(stderr).not.toContain('outcome unknown');
  });

  it('exits 1 for a write to a port fetch refuses: `fetch failed` with an uncoded cause', async () => {
    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'], { PMUX_PORT: '1' });

    expect(code).toBe(1);
    expect(stderr).toContain('request not sent');
    expect(stderr).not.toContain('outcome unknown');
  });

  it('exits 6 when a screenshot download loses its connection mid-body', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '100000' });
      res.write(Buffer.alloc(10));
      setTimeout(() => res.socket?.destroy(), 20);
    };

    const { code, stderr } = await cli(
      ['tab', 'browser', 'screenshot', '-w', 'WS', 'tab-x', '-o', path.join(home, 'partial.png')],
    );

    expect(code).toBe(6);
    expect(stderr).toContain('server-unreachable');
  });

  it('exits 6 when a read loses its connection mid-request', async () => {
    reply = (_req, res) => res.socket?.destroy();

    const { code } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(6);
  });

  it('exits 1, not 6, when a write loses its connection: the outcome is unknown', async () => {
    reply = (_req, res) => res.socket?.destroy();

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(1);
    expect(stderr).toContain('outcome unknown');
  });
});

describe('usage errors exit 2', () => {
  it.each([
    [['tab', 'send', '-w', 'WS']],
    [['tab', 'send', '-w', 'WS', 'tab-x']],
    [['tab', 'send', 'tab-x', 'hi']],
    [['tab', 'send', '-w', 'WS', 'tab-x', '--wait-ms']],
    [['tab', 'send', '-w', 'WS', '--wait-ms', '240001', 'tab-x', 'hi']],
    [['nonsense']],
    [['tab', 'status']],
    [['tab', 'probe', 'set', '-w', 'WS', 'tab-x']],
    [['tab', 'nonsense']],
    [['workspace', 'nonsense']],
    [['mission', 'ack', '-w', 'WS']],
    [['orchestration', 'nonsense', '-w', 'WS']],
  ])('%j', async (args) => {
    const { code, stderr } = await cli(args);

    expect(code).toBe(2);
    expect(stderr).toContain('usage error');
    expect(requests).toHaveLength(0);
  });
});

describe('tab close', () => {
  it('prints ok when the server confirms the close', async () => {
    reply = json(200, { ok: true });

    const { code, stdout } = await cli(['tab', 'close', '-w', 'WS', 'tab-x']);

    expect(code).toBe(0);
    expect(stdout).toBe('ok\n');
  });

  it('does not print ok when the server answered ok: false', async () => {
    reply = json(200, { ok: false });

    const { code, stdout, stderr } = await cli(['tab', 'close', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('close-not-confirmed');
  });

  it('exits 4 for a tab that is already gone', async () => {
    reply = json(404, { error: 'Tab not found', code: 'tab-not-found' });

    expect((await cli(['tab', 'close', '-w', 'WS', 'tab-x'])).code).toBe(4);
  });

  it('prints ok, then every process the close reaped and any survivor (ADR-0016)', async () => {
    reply = json(200, {
      ok: true, reaper: 'linux', envMarker: 'present',
      killed: [{ pid: 101, comm: 'sleep', args: 'sleep 600' }],
      survivors: [{ pid: 102, comm: 'D-state', args: 'stuck' }],
    });
    const { code, stdout } = await cli(['tab', 'close', '-w', 'WS', 'tab-x']);
    expect(code).toBe(0);
    expect(stdout).toBe('ok\nkilled 101 sleep sleep 600\nsurvivor 102 D-state stuck\n');
    expect(requests[0].url).toBe('/api/cli/tabs/tab-x?workspaceId=WS');
  });

  it('asks for keepProcesses with --keep-processes, and names an absent marker and an unavailable reaper', async () => {
    reply = json(200, { ok: true, reaper: 'unavailable', envMarker: 'absent', killed: [], survivors: [] });
    const { stdout } = await cli(['tab', 'close', '-w', 'WS', 'tab-x', '--keep-processes']);
    expect(requests[0].url).toBe('/api/cli/tabs/tab-x?workspaceId=WS&keepProcesses=1');
    expect(stdout).toContain('reaper: unavailable');
    expect(stdout).toContain('envMarker: absent');
  });
});

describe('api-guide', () => {
  it('prints the guide and exits 0', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('# guide');
    };

    const { code, stdout } = await cli(['api-guide']);

    expect(code).toBe(0);
    expect(stdout).toBe('# guide\n');
    expect(requests[0].url).toBe('/api/cli/api-guide');
  });

  it('maps a refusal through the table', async () => {
    reply = json(403, { error: 'Forbidden', code: 'forbidden' });

    expect((await cli(['api-guide'])).code).toBe(3);
  });
});

describe('help', () => {
  it('lists the eight exit codes with the retry column', async () => {
    const { code, stdout } = await cli(['help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Exit codes:');
    const section = stdout.slice(stdout.indexOf('Exit codes:'));
    for (const exit of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(section).toMatch(new RegExp(`^\\s+${exit}\\s`, 'm'));
    }
    expect(section).toMatch(/^\s+4\s.*never/m);
    expect(section).toMatch(/^\s+5\s.*bounded/m);
    expect(section).toMatch(/^\s+6\s.*bounded/m);
  });

  it('tells a tab send caller not to loop on exit 4', async () => {
    const { stdout } = await cli(['help']);
    const send = stdout.slice(stdout.indexOf('tab send -w WS'), stdout.indexOf('tab status -w WS'));
    expect(send).toMatch(/exit 4/i);
    expect(send).toMatch(/never retry/i);
  });

  it.each([['--help'], ['-h']])('answers %s through the installed entry point', async (flag) => {
    const { code, stdout } = await cli([flag]);
    expect(code).toBe(0);
    expect(stdout).toContain('Exit codes:');
  });
});

describe('reportsTo and bg --notify (ADR-0018)', () => {
  it('exits 2 when tab create names a reports-to tab of another workspace, and sends the id', async () => {
    reply = json(400, { error: 'reportsTo tab-o is not a tab of workspace WS', code: 'reports-to-invalid', reportsTo: 'tab-o' });

    const { code, stderr } = await cli(['tab', 'create', '-w', 'WS', '-t', 'terminal', '--reports-to', 'tab-o']);

    expect(code).toBe(2);
    expect(stderr).toContain('reports-to-invalid');
    expect(requests[0].body).toEqual({ workspaceId: 'WS', panelType: 'terminal', reportsTo: 'tab-o' });
  });

  it('refuses a bare --reports-to before sending anything', async () => {
    const { code } = await cli(['tab', 'create', '-w', 'WS', '--reports-to']);

    expect(code).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('patches and clears reportsTo with tab reports-to', async () => {
    reply = json(200, { tabId: 'tab-w', workspaceId: 'WS', reportsTo: 'tab-o' });
    expect((await cli(['tab', 'reports-to', '-w', 'WS', 'tab-w', 'tab-o'])).code).toBe(0);
    expect((await cli(['tab', 'reports-to', '-w', 'WS', 'tab-w', '--clear'])).code).toBe(0);

    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['PATCH', '/api/cli/tabs/tab-w?workspaceId=WS', { reportsTo: 'tab-o' }],
      ['PATCH', '/api/cli/tabs/tab-w?workspaceId=WS', { reportsTo: null }],
    ]);
  });

  it.each([
    [['tab', 'reports-to', '-w', 'WS', 'tab-w']],
    [['tab', 'reports-to', '-w', 'WS', 'tab-w', 'tab-o', '--clear']],
    [['tab', 'reports-to', '-w', 'WS', 'tab-w', '--on']],
  ])('refuses an ambiguous reports-to call: %j', async (args) => {
    expect((await cli(args)).code).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('sends --on as reportOn, alone or with a target, and --on all as null (ADR-0025)', async () => {
    reply = json(200, { tabId: 'tab-w', workspaceId: 'WS', reportsTo: 'tab-o', reportOn: ['DONE', 'BLOCKED'] });
    expect((await cli(['tab', 'reports-to', '-w', 'WS', 'tab-w', 'tab-o', '--on', 'DONE,BLOCKED'])).code).toBe(0);
    expect((await cli(['tab', 'reports-to', '-w', 'WS', 'tab-w', '--on', 'NEEDS-DECISION'])).code).toBe(0);
    expect((await cli(['tab', 'reports-to', '-w', 'WS', 'tab-w', '--on', 'all'])).code).toBe(0);
    expect((await cli(['tab', 'reports-to', '-w', 'WS', 'tab-w', '--clear', '--on', 'DONE'])).code).toBe(0);

    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['PATCH', '/api/cli/tabs/tab-w?workspaceId=WS', { reportsTo: 'tab-o', reportOn: 'DONE,BLOCKED' }],
      ['PATCH', '/api/cli/tabs/tab-w?workspaceId=WS', { reportOn: 'NEEDS-DECISION' }],
      ['PATCH', '/api/cli/tabs/tab-w?workspaceId=WS', { reportOn: null }],
      ['PATCH', '/api/cli/tabs/tab-w?workspaceId=WS', { reportsTo: null, reportOn: 'DONE' }],
    ]);
  });

  it('sends --report-on on tab create and exits 2 on report-on-invalid; a bare flag is refused before any request', async () => {
    reply = json(400, { error: 'reportOn: unknown marker "FINISHED"', code: 'report-on-invalid', reportOn: 'FINISHED' });
    const { code, stderr } = await cli(['tab', 'create', '-w', 'WS', '-t', 'claude-code', '--report-on', 'FINISHED']);
    expect(code).toBe(2);
    expect(stderr).toContain('report-on-invalid');
    expect(requests[0].body).toEqual({ workspaceId: 'WS', panelType: 'claude-code', reportOn: 'FINISHED' });

    expect((await cli(['tab', 'create', '-w', 'WS', '--report-on'])).code).toBe(2);
    expect(requests).toHaveLength(1);
  });

  it('sends --notify self on tab bg add, and refuses any other value', async () => {
    reply = json(200, { ok: true });
    expect((await cli(['tab', 'bg', 'add', '-w', 'WS', 'tab-w', '--pid', '42', '--notify', 'self'])).code).toBe(0);
    expect(requests[0].body).toEqual({ pid: 42, notify: 'self' });

    expect((await cli(['tab', 'bg', 'add', '-w', 'WS', 'tab-w', '--pid', '42', '--notify', 'me'])).code).toBe(2);
    expect(requests).toHaveLength(1);
  });
});

describe('inbox (ADR-0012)', () => {
  it('lists with --all through the read route', async () => {
    reply = json(200, { workspaceId: 'WS', items: [] });
    expect((await cli(['inbox', 'list', '-w', 'WS', '--all'])).code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/cli/inbox?workspaceId=WS&all=1' });
  });

  it.each([
    [409, 'inbox-not-held', 3],
    [404, 'inbox-not-found', 7],
  ])('maps a retry refused with %i %s to exit %i', async (status, code, exit) => {
    reply = json(status, { error: code, code });
    const result = await cli(['inbox', 'retry', 'i-abc123']);
    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/cli/inbox/i-abc123/retry' });
  });

  it.each([[['inbox', 'retry', 'n-not-an-inbox-id']], [['inbox', 'list']], [['inbox']]])('refuses %j before sending', async (args) => {
    expect((await cli(args)).code).toBe(2);
    expect(requests).toHaveLength(0);
  });
});
