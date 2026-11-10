import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_SCRIPT_CONTENT,
  GROK_HOOK_SCRIPT_CONTENT,
  HOOK_SCRIPT_CONTENT,
} from '@/lib/hook-scripts';
import { installHookScripts } from '@/lib/hook-scripts-install';
import { parseSpooledHook } from '@/lib/hook-spool';

// ADR-0020: the rendered hook scripts, run with a fake curl on PATH. A POST no
// server answers leaves one spool file with the payload and the time the hook
// fired; a POST a server answered leaves nothing.

const SESSION = 'pt-ws-1-pane-a-tab-w';

interface ICurlBehaviour {
  /** What `-w '%{http_code} %{time_connect}'` prints. */
  out: string;
  exit: number;
}

const REFUSED: ICurlBehaviour = { out: '000 0.000000', exit: 7 };
const DELIVERED: ICurlBehaviour = { out: '204 0.000130', exit: 0 };

describe('hook scripts spool an event no server answered (ADR-0020)', () => {
  let dir: string;
  let home: string;
  let bin: string;
  let spool: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-hook-spool-script-'));
    home = path.join(dir, 'home');
    bin = path.join(dir, 'bin');
    spool = path.join(home, '.purplemux', 'hook-spool');
    fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), '8022');
    fs.writeFileSync(path.join(home, '.purplemux', 'cli-token'), 'tok');
    // The fake curl records its arguments and the body it read, then answers as told.
    fs.writeFileSync(path.join(bin, 'curl'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${path.join(dir, 'curl-args')}'`,
      `cat > '${path.join(dir, 'curl-body')}'`,
      'printf \'%s\' "$FAKE_CURL_OUT"',
      'exit "$FAKE_CURL_EXIT"',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho "$FAKE_SESSION"\n', { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const spoolFiles = () => (fs.existsSync(spool) ? fs.readdirSync(spool).sort() : []);
  /** The hook writes a dot-named temporary, then renames it: wait for the renamed file, not the temporary. */
  const spoolLanded = () => spoolFiles().some((name) => name.endsWith('.json') && !name.startsWith('.'));

  /**
   * Detached POSTs finish after the script exits; wait for their file or their curl call. It
   * returns as soon as they land; the deadline only has to outlast a loaded host (3 s flaked at
   * load ~137 on 2026-09-29).
   */
  const settle = (until: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!until() && Date.now() < deadline) spawnSync('sleep', ['0.05']);
  };

  const run = (
    content: string,
    args: string[],
    stdin: string,
    curl: ICurlBehaviour,
    extraEnv: Record<string, string> = {},
    shell = 'sh',
  ) => {
    const script = path.join(dir, 'hook.sh');
    fs.writeFileSync(script, content);
    const env: Record<string, string> = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_CURL_OUT: curl.out,
      FAKE_CURL_EXIT: String(curl.exit),
      FAKE_SESSION: SESSION,
      ...extraEnv,
    };
    const before = Date.now();
    const r = spawnSync(shell, [script, ...args], { input: stdin, env: env as NodeJS.ProcessEnv, encoding: 'utf-8' });
    const after = Date.now();
    expect(r.status, r.stderr).toBe(0);
    // Claude adds SessionStart and UserPromptSubmit hook stdout to the model's context; Codex reads it too.
    expect(r.stdout).toBe('');
    return { before, after };
  };

  const readOnly = () => {
    const files = spoolFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{13}-\d+-[0-9a-f]*\.json$/);
    const text = fs.readFileSync(path.join(spool, files[0]), 'utf-8');
    const parsed = parseSpooledHook(text);
    expect(parsed, text).not.toBeNull();
    expect(files[0].startsWith(`${parsed!.at}-`)).toBe(true);
    return parsed!;
  };

  it('a refused connect writes one spool file: the payload, the session, and the time the hook fired', () => {
    const { before, after } = run(HOOK_SCRIPT_CONTENT, ['stop'], '{"hook_event_name":"Stop"}', REFUSED);
    const spooled = readOnly();
    // F6: the stop posts the hook's own JSON, with its kind and the session in the query.
    expect(spooled.body).toEqual({ hook_event_name: 'Stop' });
    expect(spooled.session).toBe(SESSION);
    expect(spooled.query).toBe(`kind=stop&session=${SESSION}&occurredAt=${spooled.at}`);
    expect(spooled.at).toBeGreaterThanOrEqual(before - 1);
    expect(spooled.at).toBeLessThanOrEqual(after);
    // Nothing half-written is left behind.
    expect(fs.readdirSync(spool).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('a delivered POST writes nothing, and sends the same body a server reads', () => {
    run(HOOK_SCRIPT_CONTENT, ['notification'], '{"notification_type":"permission_prompt"}', DELIVERED);
    expect(spoolFiles()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'curl-body'), 'utf-8')))
      .toEqual({ event: 'notification', session: SESSION, notificationType: 'permission_prompt' });
    expect(fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8')).toMatch(/http:\/\/localhost:8022\/api\/status\/hook\?occurredAt=\d{13}/);
  });

  it.each([
    ['a 5xx answer', { out: '503 0.000200', exit: 0 }],
    ['a connect timeout (exit 28, never connected)', { out: '000 0.000000', exit: 28 }],
    ['an unresolved host name (exit 6)', { out: '000 0.000000', exit: 6 }],
    ['a failed TLS handshake (exit 35)', { out: '000 0.000140', exit: 35 }],
  ])('spools on %s', (_label, curl: ICurlBehaviour) => {
    run(HOOK_SCRIPT_CONTENT, ['prompt-submit'], '{}', curl);
    expect(readOnly().body).toEqual({ event: 'prompt-submit', session: SESSION });
  });

  it.each([
    ['a timeout after the connect (the server may have applied it)', { out: '000 0.000180', exit: 28 }],
    ['a 4xx refusal', { out: '403 0.000200', exit: 0 }],
  ])('does not spool on %s', (_label, curl: ICurlBehaviour) => {
    run(HOOK_SCRIPT_CONTENT, ['stop'], '{}', curl);
    expect(spoolFiles()).toEqual([]);
  });

  // The server may already have applied an event whose POST timed out after the connect (curl
  // 28 with a non-zero time_connect) or whose connection the server cut while it exited (52:
  // empty reply, 56: receive failure). A replay or a retry would apply it twice. Codex Astra
  // consult 2026-09-29 (note n-TkRGbP0Fsp): the --max-time bound must keep this.
  it.each([
    ['28 after the connect', { out: '000 0.000180', exit: 28 }],
    ['52 (empty reply: the server cut the connection)', { out: '000 0.000150', exit: 52 }],
    ['56 (receive failure)', { out: '000 0.000150', exit: 56 }],
  ])('curl %s: one POST, never retried, never spooled (claude and codex hooks)', (_label, curl: ICurlBehaviour) => {
    const curlCalls = () => (fs.existsSync(path.join(dir, 'curl-args'))
      ? fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8').trim().split('\n').length
      : 0);
    run(HOOK_SCRIPT_CONTENT, ['stop'], '{}', curl);
    expect(curlCalls()).toBe(1);
    run(CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"Stop"}', curl, {}, 'bash');
    expect(curlCalls()).toBe(2);
    expect(spoolFiles()).toEqual([]);
  });

  it('spools when no server is running at all (the port file is gone), without calling curl', () => {
    fs.rmSync(path.join(home, '.purplemux', 'port'));
    run(HOOK_SCRIPT_CONTENT, ['session-start'], '{"source":"resume"}', DELIVERED);
    expect(readOnly().body).toEqual({ event: 'session-start', session: SESSION, source: 'resume' });
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(false);
  });

  it('spools a detached post-tool event with its kind and the raw tool JSON, quotes and newlines intact', () => {
    const tool = { tool_name: 'Bash', tool_input: { command: 'echo "a\\b"\nls' }, tool_response: { exit_code: 1 } };
    run(HOOK_SCRIPT_CONTENT, ['post-tool'], JSON.stringify(tool), REFUSED);
    settle(spoolLanded);
    const spooled = readOnly();
    expect(spooled.query).toBe(`kind=tool&session=${SESSION}&occurredAt=${spooled.at}`);
    expect(spooled.body).toEqual(tool);
  });

  it('a delivered post-tool event writes nothing', () => {
    run(HOOK_SCRIPT_CONTENT, ['post-tool'], '{"tool_name":"Edit"}', DELIVERED);
    settle(() => fs.existsSync(path.join(dir, 'curl-body')));
    expect(spoolFiles()).toEqual([]);
  });

  it('never spools a poll, nor an event from a session purplemux does not own', () => {
    run(HOOK_SCRIPT_CONTENT, [], '', REFUSED);
    run(HOOK_SCRIPT_CONTENT, ['stop'], '{}', REFUSED, { FAKE_SESSION: 'my-own-tmux' });
    expect(spoolFiles()).toEqual([]);
  });

  it('the codex hook spools its stdin body with the provider query', () => {
    const body = { hook_event_name: 'Stop', session_id: 's-1', last_assistant_message: 'DONE: "x"' };
    run(CODEX_HOOK_SCRIPT_CONTENT, [], JSON.stringify(body), REFUSED, { PURPLEMUX_CODEX_GENERATION: 'gen-1' }, 'bash');
    const spooled = readOnly();
    expect(spooled.query).toBe(`provider=codex&tmuxSession=${SESSION}&generation=gen-1&occurredAt=${spooled.at}`);
    expect(spooled.body).toEqual(body);
  });

  it('the codex hook spools an empty stdin as a null body, and writes nothing on delivery', () => {
    run(CODEX_HOOK_SCRIPT_CONTENT, [], '', REFUSED, {}, 'bash');
    expect(readOnly().body).toBeNull();
    fs.rmSync(spool, { recursive: true });
    run(CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"Stop"}', DELIVERED, {}, 'bash');
    expect(spoolFiles()).toEqual([]);
  });

  it('the codex hook never spools PreToolUse (one per tool call, no state), and still spools PostToolUse', () => {
    run(CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name": "PreToolUse","tool_name":"shell"}', REFUSED, {}, 'bash');
    expect(spoolFiles()).toEqual([]);
    run(CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PostToolUse","tool_name":"shell"}', REFUSED, {}, 'bash');
    expect(readOnly().body).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'shell' });
  });

  it('spools a post-tool body over 256 KiB as metadata only: kind, session, time and size, no body', () => {
    const body = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/big.txt', content: 'x'.repeat(300 * 1024) } });
    run(HOOK_SCRIPT_CONTENT, ['post-tool'], body, REFUSED);
    settle(spoolLanded);
    const spooled = readOnly();
    expect(spooled.query).toBe(`kind=tool&session=${SESSION}&occurredAt=${spooled.at}`);
    expect(spooled.session).toBe(SESSION);
    expect(spooled.body).toBeNull();
    expect(spooled.bodyDropped).toBe(true);
    expect(spooled.bodyLength).toBe(body.length);
  });

  it('the detached grok hook spools its stdin body with the provider query', () => {
    run(GROK_HOOK_SCRIPT_CONTENT, [], '{"hookEventName":"stop"}', REFUSED);
    settle(spoolLanded);
    const spooled = readOnly();
    expect(spooled.query).toBe(`provider=grok&tmuxSession=${SESSION}&occurredAt=${spooled.at}`);
    expect(spooled.body).toEqual({ hookEventName: 'stop' });
  });

  it('installHookScripts writes the four scripts, and a second run changes nothing', async () => {
    const target = path.join(dir, 'install');
    const first = await installHookScripts(target);
    expect(first.map((f) => path.basename(f.path))).toEqual(['status-hook.sh', 'statusline.sh', 'codex-hook.sh', 'grok-hook.sh']);
    expect(first.every((f) => f.changed)).toBe(true);
    expect(fs.readFileSync(path.join(target, 'status-hook.sh'), 'utf-8')).toBe(HOOK_SCRIPT_CONTENT);
    expect(fs.statSync(path.join(target, 'codex-hook.sh')).mode & 0o777).toBe(0o700);
    expect((await installHookScripts(target)).some((f) => f.changed)).toBe(false);
    expect(fs.readdirSync(target).sort()).toEqual(['codex-hook.sh', 'grok-hook.sh', 'status-hook.sh', 'statusline.sh']);
  });

  it('scripts/install-hook-scripts.sh renders this checkout\'s scripts into --dir', () => {
    const target = path.join(dir, 'cli');
    const r = spawnSync(path.resolve(__dirname, '../../../scripts/install-hook-scripts.sh'), ['--dir', target], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(
      ['status-hook.sh', 'statusline.sh', 'codex-hook.sh', 'grok-hook.sh'].map((name) => `WROTE ${path.join(target, name)}`),
    );
    expect(fs.readFileSync(path.join(target, 'grok-hook.sh'), 'utf-8')).toBe(GROK_HOOK_SCRIPT_CONTENT);
    expect(fs.existsSync(path.join(home, '.purplemux', 'status-hook.sh'))).toBe(false);
  });

  describe('the Claude stop posts its payload and prints nothing (F6; party ruling SIMPLIFY)', () => {
    const stop = (stdin: string, out: string, exit = 0) => {
      const script = path.join(dir, 'hook.sh');
      fs.writeFileSync(script, HOOK_SCRIPT_CONTENT);
      const env: Record<string, string> = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_CURL_OUT: out, FAKE_CURL_EXIT: String(exit), FAKE_SESSION: SESSION };
      const r = spawnSync('sh', [script, 'stop'], { input: stdin, env: env as NodeJS.ProcessEnv, encoding: 'utf-8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const BLOCK = '{"decision":"block","reason":"x"}';

    it('A9: a server that answers a block object gets no output and exit 0: no stop can be held', () => {
      expect(stop('{"hook_event_name":"Stop","session_id":"s-1"}', `${BLOCK}\n200 0.000100`)).toBe('');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'curl-body'), 'utf-8'))).toEqual({ hook_event_name: 'Stop', session_id: 's-1' });
      expect(fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8')).toMatch(/\/api\/status\/hook\?kind=stop&session=pt-ws-1-pane-a-tab-w&occurredAt=\d{13}/);
      expect(fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8')).toContain('--max-time 3');
      expect(spoolFiles()).toEqual([]);
    });

    it.each([
      ['an empty answer {}', '{}\n200 0.000100', 0, false],
      ['a 5xx answer (spooled)', `${BLOCK}\n503 0.000100`, 0, true],
      ['a refused connect (spooled)', '000 0.000000', 7, true],
      ['a timeout after the connect (not spooled)', `${BLOCK}\n000 0.000100`, 28, false],
    ])('prints nothing for %s; the spool rule is unchanged', (_label, out, exit, spooled) => {
      expect(stop('{"hook_event_name":"Stop"}', out as string, exit as number)).toBe('');
      expect(spoolFiles().length > 0).toBe(spooled);
    });

    it('sends {} for a body over the spool limit, and for an empty one', () => {
      stop(`{"m":"${'x'.repeat(300 * 1024)}"}`, '{}\n200 0.000100');
      expect(fs.readFileSync(path.join(dir, 'curl-body'), 'utf-8')).toBe('{}');
      stop('', '{}\n200 0.000100');
      expect(fs.readFileSync(path.join(dir, 'curl-body'), 'utf-8')).toBe('{}');
    });
  });
});
