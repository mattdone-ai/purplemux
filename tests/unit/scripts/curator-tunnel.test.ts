import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// AC 1: the user unit that holds the curator tunnel on mdserver1 (ADR-0038 §1).

const UNIT = fs.readFileSync(path.resolve('scripts/curator/purplemux-curator-tunnel.service'), 'utf-8');
const INSTALL = fs.readFileSync(path.resolve('scripts/curator/install-tunnel.sh'), 'utf-8');

const directive = (name: string): string[] => UNIT.split('\n').filter((line) => line.startsWith(`${name}=`)).map((line) => line.slice(name.length + 1));

describe('the curator tunnel unit', () => {
  it('holds ssh -N -L 127.0.0.1:11435:127.0.0.1:11434 over the LAN alias ai-lan, and nothing else', () => {
    const [exec] = directive('ExecStart');
    expect(exec).toMatch(/^\/usr\/bin\/ssh -N /);
    expect(exec).toContain(' -L 127.0.0.1:11435:127.0.0.1:11434 ai-lan');
    expect(exec.endsWith(' ai-lan')).toBe(true);
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
    expect(directive('ExecStartPost')[0]).not.toMatch(/ai-lan:11434 answers/);
    expect(directive('ExecStopPost')[0]).toContain('result=$SERVICE_RESULT code=$EXIT_CODE status=$EXIT_STATUS');
  });

  it('is a user unit wanted by default.target; the installer enables it and prints its undo', () => {
    expect(directive('WantedBy')).toEqual(['default.target']);
    expect(INSTALL).toContain('systemctl --user enable "$unit"');
    expect(INSTALL).toContain('systemctl --user restart "$unit"');
    expect(INSTALL).toContain('echo "undo: systemctl --user disable --now $unit && rm -f $dest && systemctl --user daemon-reload"');
    expect(INSTALL).not.toMatch(/docker|compose/);
  });
});
