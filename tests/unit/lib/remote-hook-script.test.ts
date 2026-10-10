import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_HOOK_SCRIPT_CONTENT } from '@/lib/hook-scripts';
import { parseSpooledHook, spooledHookQuery } from '@/lib/hook-spool';

// ADR-0022 slice (b): the remote tab's Claude hook, run with a fake curl and tmux. It posts the raw
// hook JSON to PMUX_URL with the tab token, and spools beside itself when no server answers.

const SESSION = 'pt-ws-1-pane-a-tab-r';

describe('remote Claude hook script (ADR-0022)', () => {
  let dir: string;
  let kit: string;
  let bin: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-hook-'));
    kit = path.join(dir, 'kit');
    bin = path.join(dir, 'bin');
    fs.mkdirSync(kit, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(kit, 'status-hook.sh'), REMOTE_HOOK_SCRIPT_CONTENT, { mode: 0o700 });
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

  const run = (event: string, stdin: string, curl: { out: string; exit: number }, env: Record<string, string> = {}) => {
    const r = spawnSync('sh', [path.join(kit, 'status-hook.sh'), event], {
      input: stdin,
      encoding: 'utf-8',
      env: {
        HOME: path.join(dir, 'home'),
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_CURL_OUT: curl.out,
        FAKE_CURL_EXIT: String(curl.exit),
        FAKE_SESSION: SESSION,
        PMUX_URL: 'http://mdserver1:8022',
        PMUX_TAB_TOKEN: 'tab-secret',
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
  };

  const spoolDir = () => path.join(kit, 'hook-spool');
  const spooled = () => (fs.existsSync(spoolDir()) ? fs.readdirSync(spoolDir()).filter((n) => n.endsWith('.json') && !n.startsWith('.')) : []);

  it('posts the raw hook JSON to PMUX_URL with the tab token, the event and the session', () => {
    const body = '{"session_id":"0f9e","transcript_path":"/home/mdone/.claude/projects/-x/0f9e.jsonl","hook_event_name":"Stop"}';
    run('stop', body, { out: '204 0.000100', exit: 0 });
    const args = fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8');
    expect(args).toMatch(new RegExp(`http://mdserver1:8022/api/status/hook\\?remote=claude&event=stop&session=${SESSION}&occurredAt=\\d{13}`));
    expect(args).toContain('x-pmux-token: tab-secret');
    expect(fs.readFileSync(path.join(dir, 'curl-body'), 'utf-8')).toBe(body);
    expect(spooled()).toEqual([]);
  });

  it('spools beside itself when no server answers, in the format the server replays', () => {
    run('prompt-submit', '{"session_id":"0f9e"}', { out: '000 0.000000', exit: 7 });
    const files = spooled();
    expect(files).toHaveLength(1);
    const hook = parseSpooledHook(fs.readFileSync(path.join(spoolDir(), files[0]), 'utf-8'));
    expect(hook?.session).toBe(SESSION);
    expect(hook?.body).toEqual({ session_id: '0f9e' });
    expect(spooledHookQuery(hook!.query)).toMatchObject({ remote: 'claude', event: 'prompt-submit', session: SESSION });
    expect((fs.statSync(spoolDir()).mode & 0o777)).toBe(0o700);
  });

  it('spools when no callback URL or token is set, and never posts without a token', () => {
    run('stop', '{}', { out: '204 0.000100', exit: 0 }, { PMUX_TAB_TOKEN: '' });
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(false);
    expect(spooled()).toHaveLength(1);
  });

  it.each(['poll', 'rm -rf', '', 'stop;id'])('ignores an event name outside the hooks.json words: %j', (event) => {
    run(event, '{}', { out: '204 0.000100', exit: 0 });
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(false);
    expect(spooled()).toEqual([]);
  });

  it('ignores a pane that is not a purplemux session', () => {
    run('stop', '{}', { out: '204 0.000100', exit: 0 }, { FAKE_SESSION: 'my-own-tmux' });
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(false);
  });
});
