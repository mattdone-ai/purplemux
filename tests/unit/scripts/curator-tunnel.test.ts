import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';

// AC 1: the user unit that holds the curator tunnel on the control host (ADR-0038 §1). The GPU host's ssh alias is
// not in the repo: the unit reads it from an env file the installer requires.

const run = promisify(execFile);
const ENV_FILE = '%h/.config/purplemux/curator-tunnel.env';

const UNIT = fs.readFileSync(path.resolve('scripts/curator/purplemux-curator-tunnel.service'), 'utf-8');
const INSTALL = fs.readFileSync(path.resolve('scripts/curator/install-tunnel.sh'), 'utf-8');

const directive = (name: string): string[] => UNIT.split('\n').filter((line) => line.startsWith(`${name}=`)).map((line) => line.slice(name.length + 1));

describe('the curator tunnel unit', () => {
  it('holds ssh -N -L 127.0.0.1:11435:127.0.0.1:11434 over the alias in its env file, and nothing else', () => {
    const [exec] = directive('ExecStart');
    expect(directive('EnvironmentFile')).toEqual([ENV_FILE]);
    expect(exec).toMatch(/^\/usr\/bin\/ssh -N /);
    expect(exec).toContain(' -L 127.0.0.1:11435:127.0.0.1:11434 ${CURATOR_TUNNEL_HOST}');
    expect(exec.endsWith(' ${CURATOR_TUNNEL_HOST}')).toBe(true);
    expect(exec).not.toMatch(/\s-R\s|\s-D\s/);
  });

  it('never prompts, fails when the port cannot be bound, and owns its connection', () => {
    const [exec] = directive('ExecStart');
    for (const option of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ControlMaster=no', 'ControlPath=none']) {
      expect(exec).toContain(`-o ${option}`);
    }
  });

  it('restarts on failure (and on a clean exit), with no start limit', () => {
    expect(directive('Restart')).toEqual(['always']);
    expect(directive('RestartSec')).toEqual(['10']);
    expect(directive('StartLimitIntervalSec')).toEqual(['0']);
  });

  it('logs its state to the journal under its own name: start with the pid, stop with the result and code', () => {
    expect(directive('SyslogIdentifier')).toEqual(['purplemux-curator-tunnel']);
    expect(directive('ExecStartPost')[0]).toContain('/dev/tcp/127.0.0.1/11435');
    expect(directive('ExecStartPost')[0]).toContain('curator tunnel: local listener 127.0.0.1:11435 accepts connections');
    expect(directive('ExecStartPost')[0]).toContain('the far end is checked by the purplemux probe');
    expect(directive('ExecStartPost')[0]).toMatch(/local listener 127\.0\.0\.1:11435 not accepting 10 s after ssh pid \$MAINPID started"'$/);
    expect(directive('ExecStartPost')[0]).not.toMatch(/:11434 answers/);
    expect(directive('ExecStopPost')[0]).toContain('result=$SERVICE_RESULT code=$EXIT_CODE status=$EXIT_STATUS');
  });

  it('is a user unit wanted by default.target; the installer enables it and prints its undo', () => {
    expect(directive('WantedBy')).toEqual(['default.target']);
    expect(INSTALL).toContain('systemctl --user enable "$unit"');
    expect(INSTALL).toContain('systemctl --user restart "$unit"');
    expect(INSTALL).toContain('echo "undo: systemctl --user disable --now $unit && rm -f $dest && systemctl --user daemon-reload"');
    expect(INSTALL).not.toMatch(/docker|compose/);
  });

  it.each([
    ['no env file', null, 'is missing'],
    ['an env file with no host line', '# nothing here\n', 'CURATOR_TUNNEL_HOST is not set'],
    ['an empty host', 'CURATOR_TUNNEL_HOST=\n', 'CURATOR_TUNNEL_HOST is not set'],
    ['a host that is an ssh option', 'CURATOR_TUNNEL_HOST=-oProxyCommand=x\n', 'is not a valid ssh alias'],
  ])('the installer refuses %s, names the file, and writes no unit and runs no systemctl', async (_case, envText, says) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-tunnel-'));
    try {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      const calls = path.join(home, 'systemctl-calls');
      fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
      if (envText !== null) {
        fs.mkdirSync(path.join(home, '.config/purplemux'), { recursive: true });
        fs.writeFileSync(path.join(home, '.config/purplemux/curator-tunnel.env'), envText);
      }
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home };
      const failed = await run('bash', [path.resolve('scripts/curator/install-tunnel.sh')], { env }).then(() => null, (err: { code: number; stderr: string }) => err);
      expect(failed?.code).toBe(2);
      expect(failed?.stderr).toContain(path.join(home, '.config/purplemux/curator-tunnel.env'));
      expect(failed?.stderr).toContain(says);
      expect(fs.existsSync(calls)).toBe(false);
      expect(fs.existsSync(path.join(home, '.config/systemd/user/purplemux-curator-tunnel.service'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the installer installs the unit and enables it once the env file names a valid host', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-tunnel-'));
    try {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      const calls = path.join(home, 'systemctl-calls');
      fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
      fs.mkdirSync(path.join(home, '.config/purplemux'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config/purplemux/curator-tunnel.env'), 'CURATOR_TUNNEL_HOST=host-b-lan\n');
      const { stdout } = await run('bash', [path.resolve('scripts/curator/install-tunnel.sh')], { env: { NODE_ENV: 'test' as const, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home } });
      expect(fs.readFileSync(path.join(home, '.config/systemd/user/purplemux-curator-tunnel.service'), 'utf-8')).toBe(UNIT);
      expect(fs.readFileSync(calls, 'utf-8')).toContain('--user enable purplemux-curator-tunnel.service');
      expect(stdout).toContain('tunnel host: host-b-lan');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
