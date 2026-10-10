import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Story 36: the real status hook script, run with a fake curl and tmux. At a
// session start of a tab without PMUX_TAB_ID it asks for the tab's hook-time
// identity with the PANE's workspace token and the exact pane's session, and
// writes the exports to $CLAUDE_ENV_FILE — which Claude sources before every
// later Bash command (measured on Claude Code 2.1.283).

const TOKEN = 'a'.repeat(64);
const OK = JSON.stringify({ tabId: 'tab-old1', workspaceId: 'ws-fOvEfz', token: TOKEN, identity: 'hook' });

describe('status-hook.sh hook-time identity (story 36)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-hook-identity-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (event: string, env: Record<string, string | undefined>, response = OK) => {
    const { HOOK_SCRIPT_CONTENT } = await import('@/lib/hook-settings');
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), '8022');
    fs.writeFileSync(path.join(home, '.purplemux', 'cli-token'), 'admin-token');
    const script = path.join(dir, 'status-hook.sh');
    fs.writeFileSync(script, HOOK_SCRIPT_CONTENT);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'curl'), [
      '#!/bin/sh',
      `printf 'ARGS %s HEADERS %s\\n' "$*" "$(cat /dev/fd/3 2>/dev/null | tr '\\n' ' ')" >> '${calls}'`,
      `case "$*" in *api/cli/tab-identity*) printf '%s' '${response}' ;; esac`,
      '',
    ].join('\n'), { mode: 0o755 });
    // `-t <pane>` names the exact pane's session; a bare call answers another session.
    fs.writeFileSync(path.join(bin, 'tmux'), [
      '#!/bin/sh',
      'case "$*" in *"-t %7"*) echo pt-ws-fOvEfz-pane-a-tab-old1 ;; *) echo pt-ws-OTHER-pane-z-tab-zz ;; esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const envFile = path.join(dir, 'sessionstart-hook-0.sh');
    fs.writeFileSync(envFile, '');
    const base: Record<string, string> = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    for (const [k, v] of Object.entries({ PMUX_TOKEN: 'ws-token', CLAUDE_ENV_FILE: envFile, TMUX_PANE: '%7', ...env })) {
      if (v !== undefined) base[k] = v;
    }
    const r = spawnSync('sh', [script, event], { input: '{"source":"compact"}', env: base as NodeJS.ProcessEnv, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const sourced = spawnSync('sh', ['-c', `. '${envFile}'; printf '%s|%s|%s' "$PMUX_TAB_ID" "$PMUX_WORKSPACE_ID" "$PMUX_TAB_TOKEN"`], { encoding: 'utf-8', env: { ...process.env, PMUX_TAB_ID: '', PMUX_TAB_TOKEN: '', PMUX_WORKSPACE_ID: '' } });
    // A shell the server launched carries its own identity: the injected line must give way to it.
    const launchShell = spawnSync('sh', ['-c', `. '${envFile}'; printf '%s|%s' "$PMUX_TAB_ID" "$PMUX_TAB_TOKEN"`], { encoding: 'utf-8', env: { ...process.env, PMUX_TAB_ID: 'tab-launch', PMUX_TAB_TOKEN: 'launch-token' } });
    return {
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean) : [],
      envFile: fs.readFileSync(envFile, 'utf-8'),
      sourced: sourced.stdout,
      launchShell: launchShell.stdout,
    };
  };

  it('writes the tab identity for Bash commands, asked with the pane\'s workspace token and the exact pane\'s session', async () => {
    const r = await run('session-start', {});
    expect(r.sourced).toBe(`tab-old1|ws-fOvEfz|${TOKEN}`);
    expect(r.launchShell).toBe('tab-launch|launch-token');
    const ask = r.calls.find((c) => c.includes('api/cli/tab-identity'))!;
    expect(ask).toContain('x-pmux-token: ws-token');
    // On fd 3, never on curl's command line (review r3).
    expect(ask.split(' HEADERS ')[0]).not.toContain('ws-token');
    expect(ask).not.toContain('admin-token');
    expect(ask).toContain('{"session":"pt-ws-fOvEfz-pane-a-tab-old1"}');
  });

  it.each([
    ['the tab already has PMUX_TAB_ID (launch identity)', { PMUX_TAB_ID: 'tab-new' }],
    ['no workspace token in the pane', { PMUX_TOKEN: undefined }],
    ['no CLAUDE_ENV_FILE (not a session start Claude lets write env)', { CLAUDE_ENV_FILE: undefined }],
    ['no TMUX_PANE (the exact pane cannot be named)', { TMUX_PANE: undefined }],
  ])('asks nothing and writes nothing when %s', async (_label, env: Record<string, string | undefined>) => {
    const r = await run('session-start', env);
    expect(r.calls.some((c) => c.includes('api/cli/tab-identity'))).toBe(false);
    expect(r.envFile).toBe('');
  });

  it('asks only at a session start', async () => {
    const r = await run('stop', {});
    expect(r.calls.some((c) => c.includes('api/cli/tab-identity'))).toBe(false);
    expect(r.envFile).toBe('');
  });

  it.each([
    ['a refusal (409, the tab has its launch identity)', JSON.stringify({ error: 'x', code: 'tab-has-launch-identity' })],
    ['a token that is not 64 hex characters', JSON.stringify({ tabId: 'tab-old1', workspaceId: 'ws-fOvEfz', token: 'short' })],
    ['a tab id carrying shell text', JSON.stringify({ tabId: 'tab-x;touch /tmp/pwned', workspaceId: 'ws-fOvEfz', token: TOKEN })],
    ['no answer', ''],
  ])('writes nothing for %s', async (_label, response) => {
    const r = await run('session-start', {}, response);
    expect(r.envFile).toBe('');
  });
});
