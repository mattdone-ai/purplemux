import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_HOOK_TIMEOUT_SECONDS,
  CODEX_HOOK_SCRIPT_CONTENT,
  GROK_HOOK_SCRIPT_CONTENT,
  HOOK_MAX_TIME_SECONDS,
  HOOK_SCRIPT_CONTENT,
  HOOK_SCRIPT_FILES,
  HOOK_TMUX_TIMEOUT_SECONDS,
} from '@/lib/hook-scripts';

// A hook runs on the agent's critical path: Codex waits for codex-hook.sh on every tool call
// (with no timeout of its own), and Claude waits for status-hook.sh up to its hook timeout. A
// server that accepts the connection and never answers must cost at most HOOK_MAX_TIME_SECONDS
// per event. Measured 2026-09-29 (Codex Astra lane, epic ci-spot-runners): the codex hook had
// `--connect-timeout 1` and no `--max-time`, and every tool call waited minutes on a slow
// server while the tool itself finished at once.
//
// The server here is a real listener that never replies: the kernel completes the handshake,
// curl sends the request, and no response ever comes. The curl is the real one.

const SESSION = 'pt-ws-1-pane-a-tab-w';
/**
 * Ceiling for "bounded": well over the bound plus process start-up on a loaded host, and well
 * under KILL_MS, so it only has to tell a bounded hook from an unbounded one.
 */
const BOUNDED_MS = 8_000;
/**
 * A detached hook (post-tool, grok) must hand its pipes back at once, not after its POST. A hook
 * that holds them costs at least the 2 s POST bound, so 1.5 s still tells the two apart on a
 * loaded host.
 */
const DETACHED_MS = 1_500;
/** Kill a hook still running here: the unbounded case, reported as a failure, not a hang. */
const KILL_MS = 15_000;

interface IRun {
  code: number | null;
  elapsedMs: number;
  killed: boolean;
}

describe('every hook POST is bounded against a server that never answers', () => {
  let server: net.Server;
  let dir: string;
  let home: string;
  let bin: string;
  /** Everything each connection sent, so a test can find its own request by a marker. */
  const received: string[] = [];
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    server = net.createServer((socket) => {
      const index = received.push('') - 1;
      socket.on('data', (chunk) => {
        received[index] += chunk.toString('utf-8');
      });
      sockets.push(socket); // read the request, answer nothing
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-hook-bounded-'));
    home = path.join(dir, 'home');
    bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), String(port));
    fs.writeFileSync(path.join(home, '.purplemux', 'cli-token'), 'tok');
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho '${SESSION}'\n`, { mode: 0o755 });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (content: string, args: string[], stdin: string, shell: string, tmuxBin = bin): Promise<IRun> => {
    const script = path.join(dir, `hook-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(script, content, { mode: 0o700 });
    const started = Date.now();
    return new Promise((resolve) => {
      const env: Record<string, string> = { HOME: home, PATH: `${tmuxBin}:/usr/bin:/bin` };
      // stdin, stdout and stderr are pipes (the spawn default), as under Codex and Claude: a
      // hook that leaves a child holding them open keeps its caller waiting. Its own process
      // group, so the kill reaches curl and every subshell, not only the script.
      const child: ChildProcessWithoutNullStreams = spawn(shell, [script, ...args], {
        env: env as NodeJS.ProcessEnv,
        detached: true,
      });
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // already gone
        }
      }, KILL_MS);
      child.stdout.resume();
      child.stderr.resume();
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ code, elapsedMs: Date.now() - started, killed });
      });
      child.stdin.end(stdin);
    });
  };

  it.each([
    ['codex PreToolUse', CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PreToolUse","tool_name":"shell"}', 'bash'],
    ['codex PostToolUse', CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PostToolUse","tool_name":"shell"}', 'bash'],
    ['codex Stop', CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"Stop"}', 'bash'],
    ['claude stop', HOOK_SCRIPT_CONTENT, ['stop'], '{}', 'sh'],
    ['claude notification', HOOK_SCRIPT_CONTENT, ['notification'], '{"notification_type":"idle_prompt"}', 'sh'],
    ['claude session-start', HOOK_SCRIPT_CONTENT, ['session-start'], '{"source":"startup"}', 'sh'],
  ])('%s returns within the bound and exits 0', async (_name, content, args, stdin, shell) => {
    const result = await run(content, args as string[], stdin as string, shell as string);

    expect(result.killed, `still running after ${KILL_MS} ms: the POST is unbounded`).toBe(false);
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(BOUNDED_MS);
  }, KILL_MS + 5_000);

  it.each([
    ['claude post-tool', HOOK_SCRIPT_CONTENT, ['post-tool'], '{"tool_name":"Edit"}', 'sh'],
    ['grok', GROK_HOOK_SCRIPT_CONTENT, [], '{"hookEventName":"Stop"}', 'sh'],
  ])('%s is detached: it hands its pipes back at once, not after the POST', async (_name, content, args, stdin, shell) => {
    const result = await run(content, args as string[], stdin as string, shell as string);

    expect(result.killed).toBe(false);
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(DETACHED_MS);
  }, KILL_MS + 5_000);

  it('a timeout after the connect is not spooled: the server may have applied the event', async () => {
    const spool = path.join(home, '.purplemux', 'hook-spool');
    fs.rmSync(spool, { recursive: true, force: true });
    const marker = `spool-check-${Date.now()}`;

    const result = await run(CODEX_HOOK_SCRIPT_CONTENT, [], `{"hook_event_name":"PostToolUse","marker":"${marker}"}`, 'bash');

    expect(result.killed).toBe(false);
    expect(result.code).toBe(0);
    // It really reached the server (the body arrived) and waited out the bound: curl's timeout,
    // not an early exit.
    expect(received.filter((request) => request.includes(marker))).toHaveLength(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(HOOK_MAX_TIME_SECONDS * 1000 - 250);
    expect(fs.existsSync(spool) ? fs.readdirSync(spool) : []).toEqual([]);
  }, KILL_MS + 5_000);

  it.skipIf(process.platform !== 'linux')('a wedged tmux server does not stall the hook either', async () => {
    const stuck = path.join(dir, 'stuck-bin');
    fs.mkdirSync(stuck, { recursive: true });
    fs.writeFileSync(path.join(stuck, 'tmux'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });

    const result = await run(CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PostToolUse"}', 'bash', stuck);

    expect(result.killed, 'tmux display-message is unbounded').toBe(false);
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(BOUNDED_MS);
  }, KILL_MS + 5_000);
});

describe('the bounds', () => {
  // A static check that also covers a curl this suite does not execute (the tab-identity
  // request, the statusline). A curl command may span lines joined by a trailing backslash.
  // `command -v curl` asks whether curl is installed (PMUX-REMOTE-URL r4); it runs no curl.
  const curlCommands = (content: string): string[] =>
    content
      .replace(/\\\n/g, ' ')
      .split('\n')
      .filter((line) => /(^|[\s|(]|\$\()curl\s/.test(line.replace(/command -v curl\b/g, '')));

  it('the presence check is no curl call, and a curl call beside it still counts', () => {
    expect(curlCommands('  if ! command -v curl >/dev/null 2>&1; then')).toEqual([]);
    expect(curlCommands('  command -v curl >/dev/null && curl -s http://x')).toHaveLength(1);
  });

  it.each(HOOK_SCRIPT_FILES.map((file) => [file.name, file.content]))('every curl in %s carries --max-time', (_name, content) => {
    const commands = curlCommands(content as string);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command, command.trim()).toMatch(/--max-time\s+("?\$\{?\w+\}?"?|\d+)/);
  });

  it('post_hook bounds every POST by default, before the caller options (curl keeps the last --max-time)', () => {
    expect(CODEX_HOOK_SCRIPT_CONTENT).toMatch(new RegExp(`--max-time ${HOOK_MAX_TIME_SECONDS} "\\$@"`));
  });

  it("the POST bound and a start-up margin fit inside Claude's hook timeout", () => {
    // Against a stalled server one POST must end on its own (exit 0), not by Claude's kill.
    // Two paths can still reach Claude's kill, and lose nothing but that event's delivery: a
    // wedged tmux together with a stalled server, and a session-start on a tab without
    // PMUX_TAB_ID, which also asks the server for its identity (a second bounded request).
    const startUpMarginSeconds = 0.5;
    expect(HOOK_MAX_TIME_SECONDS + startUpMarginSeconds).toBeLessThan(CLAUDE_HOOK_TIMEOUT_SECONDS);
    expect(HOOK_TMUX_TIMEOUT_SECONDS).toBeLessThanOrEqual(1);
  });

  it('tmux is bounded wherever a script asks tmux for a session', () => {
    for (const content of [HOOK_SCRIPT_CONTENT, CODEX_HOOK_SCRIPT_CONTENT, GROK_HOOK_SCRIPT_CONTENT]) {
      const calls = content.split('\n').filter((line) => /tmux display-message/.test(line));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toContain('$HOOK_TIMEOUT tmux display-message');
    }
  });
});
