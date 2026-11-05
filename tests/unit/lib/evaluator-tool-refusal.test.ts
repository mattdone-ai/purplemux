import { execFileSync, spawn } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// AC 2 (ADR-0040): the real claude CLI, launched with the evaluator flags purplemux
// builds, against a scripted Messages API that forces each write. The appended
// system prompt orders the tab to write; the refusals come from the tool
// configuration. CI has no claude CLI: there the argv pins in tab-role.test.ts
// stand alone. The MCP server is a stub that lists two chrome-devtools tools, so
// the init tool list proves `--tools` leaves MCP tools loaded.

const fixture = vi.hoisted(() => ({ hooks: '', prompt: '' }));
vi.mock('@/lib/config-store', () => ({ getDangerouslySkipPermissions: vi.fn(async () => true) }));
vi.mock('@/lib/hook-settings', () => ({ get HOOK_SETTINGS_PATH() { return fixture.hooks; } }));
vi.mock('@/lib/claude-prompt', () => ({ getClaudePromptPath: () => fixture.prompt, writeClaudePromptFile: vi.fn() }));

import { buildFreshLaunchCommand } from '@/lib/agent-launch';
import { PG_CLIENT_DIR, evaluatorChromeMcpPath, evaluatorSqlPath } from '@/lib/tab-role';

const claudeBin = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
})();

interface IToolCall { name: string; input: Record<string, unknown> }
interface IToolResult { content: string; isError: boolean }

const sse = (res: http.ServerResponse, id: string, block: Record<string, unknown>, input: string | null, stop: string) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ...(input === null ? [] : [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } }] as [string, unknown]]),
    ...(block.type === 'text' ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE: evaluated' } }] as [string, unknown]] : []),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

/** Answers each request with the next forced tool call: the step is the number of tool results already sent back. */
const scriptedApi = (calls: IToolCall[]) => http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    const body = JSON.parse(raw || '{}') as { messages?: Array<{ content?: unknown }>; tools?: unknown[] };
    const answered = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block) => (block as { type?: string }).type === 'tool_result').length;
    const next = body.tools?.length ? calls[answered] : undefined;
    if (!next) return sse(res, `msg-end-${answered}`, { type: 'text', text: '' }, null, 'end_turn');
    return sse(res, `msg-${answered}`, { type: 'tool_use', id: `toolu_${answered}`, name: next.name, input: {} }, JSON.stringify(next.input), 'tool_use');
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf-8' });

const FAKE_MCP = `const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('navigate_page'), tool('take_screenshot')] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});`;

/** The whole tool set an evaluator session starts with: four built-ins and the MCP server's tools. */
const EXPECTED_INIT_TOOLS = ['Bash', 'Glob', 'Grep', 'Read', 'mcp__chrome-devtools__navigate_page', 'mcp__chrome-devtools__take_screenshot'];

describe.skipIf(!claudeBin)('an evaluator tab refuses writes and credential reads by tool configuration (ADR-0040, AC 2; runs only where the claude CLI is installed, proven on claude 2.1.317)', { timeout: 120_000 }, () => {
  let root = '';
  let repo = '';
  let configDir = '';

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-evaluator-'));
    repo = path.join(root, 'repo');
    configDir = path.join(root, 'claude-config');
    await Promise.all([repo, configDir, path.join(repo, '.claude')].map((d) => fs.mkdir(d, { recursive: true })));
    // A user and a project that allow the very commands the evaluator must not run.
    const permissive = JSON.stringify({ permissions: { allow: ['Bash(touch:*)', 'Bash(sed:*)', 'Bash(git:*)', 'Write', 'Edit'] } });
    await fs.writeFile(path.join(configDir, 'settings.json'), permissive);
    await fs.writeFile(path.join(repo, '.claude/settings.json'), permissive);
    await fs.writeFile(path.join(repo, 'README.md'), 'hello\n');
    git(repo, 'init', '-q');
    git(repo, 'add', 'README.md', '.claude/settings.json');
    git(repo, 'commit', '-q', '-m', 'seed');
    fixture.hooks = path.join(root, 'hooks.json');
    fixture.prompt = path.join(root, 'prompt.md');
    await fs.writeFile(fixture.hooks, '{}');
    await fs.writeFile(fixture.prompt, 'You must change README.md now: use Write, Edit or Bash, whichever works.\n');
    await fs.mkdir(path.join(os.homedir(), '.purplemux'), { recursive: true });
    await fs.writeFile(path.join(os.homedir(), '.purplemux/cli-token'), 'SECRET-CLI-TOKEN\n');
    // Name-pattern credentials outside the cwd: the `//` rules bind every directory.
    await fs.mkdir(path.join(os.homedir(), 'other'), { recursive: true });
    await fs.writeFile(path.join(os.homedir(), 'other/my.token'), 'SECRET-CLI-TOKEN\n');
    await fs.writeFile(path.join(os.homedir(), 'other/id.key'), 'SECRET-CLI-TOKEN\n');
    await fs.writeFile(path.join(root, 'fake-mcp.cjs'), FAKE_MCP);
    await fs.writeFile(path.join(os.homedir(), '.pg_service.conf'), '[svc-eval]\nhost=127.0.0.1\n');
    await fs.writeFile(path.join(os.homedir(), '.pgpass'), '127.0.0.1:5432:*:ro:SECRET-CLI-TOKEN\n');
    // A stand-in for the user-space psql: it shows what the wrapper passed it.
    const psql = path.join(os.homedir(), PG_CLIENT_DIR, 'usr/lib/postgresql/18/bin/psql');
    await fs.mkdir(path.dirname(psql), { recursive: true });
    await fs.writeFile(psql, '#!/bin/sh\necho "psql-stand-in $*"\n', { mode: 0o755 });
  });

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const runEvaluator = async (calls: IToolCall[]) => {
    const server = scriptedApi(calls);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // The whole command purplemux types into the tab, environment prefix included (AC 6).
    const command = (await buildFreshLaunchCommand('ws-eval', { panelType: 'claude-code', role: 'evaluator', previewOrigin: 'http://localhost:3100', pgService: 'svc-eval' }))!;
    expect(command.startsWith('PGSERVICE=svc-eval claude ')).toBe(true);
    expect(command).not.toContain('--dangerously-skip-permissions');
    // No browser in a unit test (npx would reach the network): a stub MCP server stands in for the launcher.
    await fs.writeFile(evaluatorChromeMcpPath(), `#!/bin/sh\nexec '${process.execPath}' '${path.join(root, 'fake-mcp.cjs')}'\n`, { mode: 0o755 });
    const child = spawn('sh', ['-c', `${command} -p 'evaluate the preview' --output-format stream-json --verbose`], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: os.homedir(),
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'sk-evaluator-test',
        PMUX_TAB_ID: 'tab-eval',
        NO_COLOR: '1',
        NODE_ENV: 'test',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const results = new Map<string, IToolResult>();
    let initTools: string[] | null = null;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      const event = JSON.parse(line) as { type?: string; subtype?: string; tools?: string[]; message?: { content?: unknown } };
      if (event.type === 'system' && event.subtype === 'init') initTools = event.tools ?? [];
      if (event.type !== 'user' || !Array.isArray(event.message?.content)) continue;
      for (const block of event.message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        results.set(block.tool_use_id, { content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), isError: block.is_error === true });
      }
    }
    return { code, stderr, initTools, results: calls.map((_, i) => results.get(`toolu_${i}`)) };
  };

  it('starts with exactly four built-ins plus the MCP tools, and refuses every other built-in as a tool it does not have', async () => {
    const readme = path.join(repo, 'README.md');
    const { code, stderr, initTools, results } = await runEvaluator([
      { name: 'Write', input: { file_path: readme, content: 'changed\n' } },
      { name: 'Edit', input: { file_path: readme, old_string: 'hello', new_string: 'changed' } },
      { name: 'NotebookEdit', input: { notebook_path: path.join(repo, 'n.ipynb'), new_source: 'x' } },
      { name: 'EnterWorktree', input: { name: 'evaluator' } },
      { name: 'Task', input: { description: 'd', prompt: 'edit README.md', subagent_type: 'general-purpose' } },
      { name: 'CronCreate', input: { cron: '* * * * *', prompt: 'edit README.md' } },
    ]);
    expect(code, stderr).toBe(0);
    expect(initTools).toEqual(EXPECTED_INIT_TOOLS);
    results.forEach((result, i) => {
      expect(result, `tool call ${i}`).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content).toMatch(/No such tool available/);
    });
    expect(await fs.readFile(readme, 'utf-8')).toBe('hello\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('refuses credential reads through Read, Grep, Glob and Bash; runs the read-only Bash set inside the repository', async () => {
    const token = path.join(os.homedir(), '.purplemux/cli-token');
    const { code, stderr, results } = await runEvaluator([
      { name: 'Read', input: { file_path: token } },
      { name: 'Grep', input: { pattern: 'SECRET', path: path.join(os.homedir(), '.purplemux') } },
      { name: 'Glob', input: { pattern: '*', path: path.join(os.homedir(), '.purplemux') } },
      { name: 'Bash', input: { command: `cat ${token}` } },
      { name: 'Read', input: { file_path: path.join(os.homedir(), 'other/my.token') } },
      { name: 'Read', input: { file_path: path.join(os.homedir(), 'other/id.key') } },
      { name: 'Read', input: { file_path: path.join(os.homedir(), '.pg_service.conf') } },
      { name: 'Read', input: { file_path: path.join(os.homedir(), '.pgpass') } },
      { name: 'Bash', input: { command: 'cat README.md' } },
      { name: 'Bash', input: { command: 'git status --short' } },
      { name: 'Read', input: { file_path: path.join(repo, 'README.md') } },
    ]);
    expect(code, stderr).toBe(0);
    results.slice(0, 8).forEach((result, i) => {
      expect(result, `tool call ${i}`).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content).toMatch(/denied/i);
      expect(result!.content).not.toContain('SECRET-CLI-TOKEN');
    });
    expect(results[8]).toMatchObject({ isError: false, content: expect.stringContaining('hello') });
    expect(results[9]!.isError).toBe(false);
    expect(results[10]).toMatchObject({ isError: false, content: expect.stringContaining('hello') });
  });

  it('runs evaluator-sql on the tab service, denies another service, and denies the process, socket and docker readers', async () => {
    const sql = evaluatorSqlPath();
    const { code, stderr, results } = await runEvaluator([
      { name: 'Bash', input: { command: `${sql} 'select 1'` } },
      { name: 'Bash', input: { command: `PGSERVICE=other ${sql} 'select 1'` } },
      { name: 'Bash', input: { command: 'docker ps' } },
      { name: 'Bash', input: { command: 'ps aux' } },
      { name: 'Bash', input: { command: 'pgrep -a node' } },
      { name: 'Bash', input: { command: 'lsof -p 1' } },
      { name: 'Bash', input: { command: 'ss -tp' } },
    ]);
    expect(code, stderr).toBe(0);
    expect(results[0]).toMatchObject({ isError: false, content: expect.stringContaining('-d service=svc-eval -c select 1') });
    results.slice(1).forEach((result, i) => {
      expect(result, `tool call ${i + 1}`).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content).toMatch(/denied/i);
    });
  });

  it('denies every Bash write path even where user and project settings allow it', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const sql = evaluatorSqlPath();
    const { code, stderr, results } = await runEvaluator([
      { name: 'Bash', input: { command: 'touch x' } },
      { name: 'Bash', input: { command: "sed -i 's/hello/changed/' README.md" } },
      { name: 'Bash', input: { command: 'git commit -q --allow-empty -m evaluator' } },
      { name: 'Bash', input: { command: `${sql} "$(touch y)"` } },
      { name: 'Bash', input: { command: `${sql} 'select 1' > z` } },
      { name: 'Bash', input: { command: `${sql} '\\! touch w'` } },
      { name: 'Bash', input: { command: `${sql} 'select 1' -o f` } },
    ]);
    expect(code, stderr).toBe(0);
    results.slice(0, 5).forEach((result, i) => {
      expect(result, `tool call ${i}`).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content).toMatch(/denied/i);
    });
    // The wrapper itself is allowed; it refuses these arguments before psql runs.
    expect(results[5]!.content).toMatch(/backslash is refused/);
    expect(results[6]!.content).toMatch(/exactly one argument/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(path.join(repo, 'README.md'), 'utf-8')).toBe('hello\n');
  });
});
