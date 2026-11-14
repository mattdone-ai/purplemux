import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_HOOK_SCRIPT_CONTENT, REMOTE_HOOK_URL_FILE } from '@/lib/hook-scripts';
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
      `cat /dev/fd/3 > '${path.join(dir, 'curl-headers')}' 2>/dev/null`,
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
        PMUX_URL: 'http://host-a:8022',
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
    const body = '{"session_id":"0f9e","transcript_path":"/home/user/.claude/projects/-x/0f9e.jsonl","hook_event_name":"Stop"}';
    run('stop', body, { out: '204 0.000100', exit: 0 });
    const args = fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8');
    expect(args).toMatch(new RegExp(`http://host-a:8022/api/status/hook\\?remote=claude&event=stop&session=${SESSION}&occurredAt=\\d{13}`));
    // The token never rides on curl's command line (readable in /proc/<pid>/cmdline): it comes on fd 3.
    expect(args).not.toContain('tab-secret');
    expect(args).toContain('-H @/dev/fd/3');
    expect(fs.readFileSync(path.join(dir, 'curl-headers'), 'utf-8')).toBe('x-pmux-token: tab-secret\n');
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

  // The server cannot have received a request that curl never sent. Measured 2026-11-09: the
  // callback name did not resolve on the remote host, curl exited 6, and every event was lost.
  it.each([
    ['6 (the callback host name did not resolve)', { out: '000 0.000000', exit: 6 }],
    ['5 (the proxy name did not resolve)', { out: '000 0.000000', exit: 5 }],
    ['7 (the connect was refused)', { out: '000 0.000000', exit: 7 }],
    ['28 before the connect', { out: '000 0.000000', exit: 28 }],
    ['35 (the TLS handshake failed)', { out: '000 0.000140', exit: 35 }],
    ['60 (the TLS peer certificate failed verification)', { out: '000 0.000140', exit: 60 }],
    ['a 5xx answer', { out: '503 0.000200', exit: 0 }],
  ])('spools when curl exits %s', (_label, curl) => {
    run('stop', '{"session_id":"0f9e"}', curl);
    const files = spooled();
    expect(files).toHaveLength(1);
    const hook = parseSpooledHook(fs.readFileSync(path.join(spoolDir(), files[0]), 'utf-8'));
    expect(hook?.body).toEqual({ session_id: '0f9e' });
    expect(spooledHookQuery(hook!.query)).toMatchObject({ remote: 'claude', event: 'stop', session: SESSION });
  });

  // The server received these requests and may have applied them: a replay would repeat them.
  it.each([
    ['a 2xx answer', { out: '204 0.000100', exit: 0 }],
    ['a 4xx refusal', { out: '403 0.000200', exit: 0 }],
    ['a 404 answer', { out: '404 0.000200', exit: 0 }],
    ['28 after the connect', { out: '000 0.000180', exit: 28 }],
    ['52 (empty reply: the server cut the connection)', { out: '000 0.000150', exit: 52 }],
    ['56 (receive failure)', { out: '000 0.000150', exit: 56 }],
  ])('does not spool on %s', (_label, curl) => {
    run('stop', '{"session_id":"0f9e"}', curl);
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(true);
    expect(spooled()).toEqual([]);
  });

  it('spools when no callback URL or token is set, and never posts without a token', () => {
    run('stop', '{}', { out: '204 0.000100', exit: 0 }, { PMUX_TAB_TOKEN: '' });
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(false);
    expect(spooled()).toHaveLength(1);
  });

  it('spools when no URL is set anywhere (no kit file, no PMUX_URL): today\'s behaviour, and curl never runs', () => {
    run('stop', '{"session_id":"0f9e"}', { out: '204 0.000100', exit: 0 }, { PMUX_URL: '' });
    expect(fs.existsSync(path.join(dir, 'curl-args'))).toBe(false);
    expect(spooled()).toHaveLength(1);
  });

  // PMUX-REMOTE-URL: the kit's callback-url, written by every create on the host, is the hook's base URL.
  describe('the kit\'s callback-url file (PMUX-REMOTE-URL)', () => {
    const KIT_URL = 'http://control.example.ts.net:8022';
    const writeKitUrl = (line: string) => fs.writeFileSync(path.join(kit, REMOTE_HOOK_URL_FILE), line, { mode: 0o600 });
    const postedTo = () => fs.readFileSync(path.join(dir, 'curl-args'), 'utf-8');

    it('posts live to the kit URL, with no PMUX_URL in the pane, and spools nothing', () => {
      writeKitUrl(`${KIT_URL}\n`);
      run('prompt-submit', '{"session_id":"0f9e"}', { out: '204 0.000100', exit: 0 }, { PMUX_URL: '' });

      expect(postedTo()).toMatch(new RegExp(`${KIT_URL}/api/status/hook\\?remote=claude&event=prompt-submit&session=${SESSION}&occurredAt=\\d{13}`));
      expect(spooled()).toEqual([]);
    });

    it('wins over the pane\'s PMUX_URL, which a create before the change baked in', () => {
      writeKitUrl(KIT_URL);
      run('stop', '{}', { out: '204 0.000100', exit: 0 });

      expect(postedTo()).toContain(`${KIT_URL}/api/status/hook?`);
      expect(postedTo()).not.toContain('host-a');
    });

    it.each([
      ['refused', { out: '000 0.000000', exit: 7 }],
      ['unresolved', { out: '000 0.000000', exit: 6 }],
      ['timed out before the connect', { out: '000 0.000000', exit: 28 }],
      ['a 5xx answer', { out: '502 0.000200', exit: 0 }],
    ])('a failed POST to the kit URL (%s) still spools, as today', (_label, curl) => {
      writeKitUrl(KIT_URL);
      run('stop', '{"session_id":"0f9e"}', curl);

      expect(postedTo()).toContain(KIT_URL);
      const files = spooled();
      expect(files).toHaveLength(1);
      const hook = parseSpooledHook(fs.readFileSync(path.join(spoolDir(), files[0]), 'utf-8'));
      expect(hook?.body).toEqual({ session_id: '0f9e' });
    });

    it('keeps the token off curl\'s command line', () => {
      writeKitUrl(KIT_URL);
      run('stop', '{}', { out: '204 0.000100', exit: 0 });

      expect(postedTo()).not.toContain('tab-secret');
      expect(fs.readFileSync(path.join(dir, 'curl-headers'), 'utf-8')).toBe('x-pmux-token: tab-secret\n');
    });

    it('takes an IPv6 literal and an https URL', () => {
      for (const url of ['http://[2001:db8::10]:8022', 'https://control.example.com']) {
        writeKitUrl(url);
        fs.rmSync(path.join(dir, 'curl-args'), { force: true });
        run('stop', '{}', { out: '204 0.000100', exit: 0 });

        expect(postedTo()).toContain(`${url}/api/status/hook?`);
      }
    });

    it.each([
      ['a command substitution', 'http://control.example.ts.net:8022/$(id)'],
      ['a space', 'http://control.example.ts.net:8022 -o /tmp/x'],
      ['a query', 'http://control.example.ts.net:8022?x=1'],
      ['another scheme', 'file:///etc/passwd'],
      ['a bare scheme', 'http://'],
      ['an empty file', ''],
    ])('ignores a kit file with %s and uses PMUX_URL', (_label, line) => {
      writeKitUrl(`${line}\n`);
      run('stop', '{}', { out: '204 0.000100', exit: 0 });

      expect(postedTo()).toContain('http://host-a:8022/api/status/hook?');
    });

    it('never takes the URL from the event: a body that names a URL changes nothing', () => {
      writeKitUrl(KIT_URL);
      const body = '{"session_id":"0f9e","PMUX_URL":"http://attacker.example:1","cwd":"http://attacker.example:1","url":"http://attacker.example:1"}';
      run('stop', body, { out: '204 0.000100', exit: 0 }, { PMUX_URL: '' });

      expect(postedTo()).toContain(`${KIT_URL}/api/status/hook?`);
      expect(postedTo()).not.toContain('attacker');
      expect(fs.readFileSync(path.join(dir, 'curl-body'), 'utf-8')).toBe(body);
    });

    it('reads only the first line of the file', () => {
      writeKitUrl(`${KIT_URL}\nhttp://second.example:1\n`);
      run('stop', '{}', { out: '204 0.000100', exit: 0 });

      expect(postedTo()).toContain(`${KIT_URL}/api/status/hook?`);
      expect(postedTo()).not.toContain('second.example');
    });
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
