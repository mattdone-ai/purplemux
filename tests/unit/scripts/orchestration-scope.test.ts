import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repo = process.cwd();
let home: string;
let server: http.Server;
let port: number;
let requests: { method: string; url: string; token: string; body: string }[];
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-orchestration-'));
  fs.mkdirSync(path.join(home, '.purplemux'));
  fs.writeFileSync(path.join(home, '.purplemux/cli-token'), 'global');
  fs.writeFileSync(path.join(home, '.purplemux/workspace-tokens.json'), JSON.stringify({ 'ws-target': 'target-token' }));
  requests = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const token = String(req.headers['x-pmux-token']);
      requests.push({ method: req.method ?? '', url, token, body });
      const status = req.method === 'POST' || req.method === 'PATCH' ? (token === 'target-token' ? 200 : 403) : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(url.includes('/status?') ? { cliState: 'needs-input', alive: true }
        : url.startsWith('/api/cli/tabs?') ? { tabs: [{ tabId: 'tab-worker', name: 'worker', panelType: 'codex-cli' }] }
          : url.endsWith('/orchestration') && req.method === 'GET' ? { orchestration: { enabled: false, orchestratorTabId: null, revision: 4 } }
            : status >= 400 ? { code: 'forbidden', error: 'Own workspace required' } : {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(home, '.purplemux/port'), String(port));
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, NODE_ENV: 'test', NO_UPDATE_NOTIFIER: '1', ...extra });
describe('shipped orchestration lifecycle authority', () => {
  it('executes the documented plain-shell lifecycle through the production CLI without global token exports', async () => {
    const doc = fs.readFileSync(path.join(repo, 'orchestration/ORCHESTRATION.md'), 'utf8');
    const kickoff = /## Kickoff \(step by step\)[\s\S]*?```bash\n([\s\S]*?)```/.exec(doc)![1]
      .replaceAll('WS_ID', 'ws-target').replaceAll('ORCH_TAB_ID', 'tab-orch');
    expect(doc).not.toMatch(/export PMUX_TOKEN=/);
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin/purplemux'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(repo, 'bin/purplemux.js')}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'kickoff-prompt.md'), 'isolated fixture kickoff');
    await run('bash', ['-eu', '-c', kickoff], { cwd: home, env: env({ PATH: `${home}/bin:${process.env.PATH}` }) });
    expect(requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.url, r.token])).toEqual([
      ['POST', '/api/cli/tabs', 'target-token'],
      ['PATCH', '/api/cli/workspaces/ws-target/orchestration', 'target-token'],
      ['POST', '/api/cli/tabs/tab-orch/send?workspaceId=ws-target', 'target-token'],
    ]);
    // Story 15 review R2: the headless kickoff enables the server's watchdog, which nudges only an enabled workspace.
    expect(JSON.parse(requests.find((r) => r.method === 'PATCH')!.body)).toMatchObject({ enabled: true, orchestratorTabId: 'tab-orch', expectedRevision: 4 });
  });
  it('starts no watchdog process and names no model switch or prose worker cap (story 15, AC 2 and 3)', () => {
    const doc = fs.readFileSync(path.join(repo, 'orchestration/ORCHESTRATION.md'), 'utf8');
    expect(fs.existsSync(path.join(repo, 'orchestration/pmux-watch.sh'))).toBe(false);
    expect(doc).not.toMatch(/pmux-watch|\/model\b|N_PARALLEL/);
    expect(doc).toContain('tabs.cap-per-workspace');
    expect(doc).toContain('purplemux tab count -w');
  });
});
