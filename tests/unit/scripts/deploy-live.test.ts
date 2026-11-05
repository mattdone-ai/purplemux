import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../scripts/deploy-live.sh');
const SQLITE_MODULE = createRequire(import.meta.url).resolve('better-sqlite3');

const FAKES: Record<string, string> = {
  // Simulates systemd: a restart starts a new MainPID whose cwd is the drop-in's
  // resolved WorkingDirectory; switch files make one restart fail, do nothing,
  // or deliver SIGTERM to the deploy script.
  systemctl: `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/systemctl.log"
if [[ " $* " == *" show "* ]]; then cat "$FAKE_STATE/mainpid"; exit 0; fi
if [[ " $* " == *" daemon-reload "* ]]; then
  r=$(( $(cat "$FAKE_STATE/reloads" 2>/dev/null || echo 0) + 1 ))
  echo "$r" > "$FAKE_STATE/reloads"
  [[ -e "$FAKE_STATE/reload-fail" || -e "$FAKE_STATE/reload-fail.$r" ]] && exit 1
  exit 0
fi
if [[ " $* " == *" restart "* ]]; then
  n=$(( $(cat "$FAKE_STATE/restarts" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAKE_STATE/restarts"
  [[ -e "$FAKE_STATE/term-on-restart.$n" ]] && kill -TERM "$PPID"
  [[ -e "$FAKE_STATE/restart-fail.$n" ]] && exit 1
  [[ -e "$FAKE_STATE/restart-noop.$n" ]] && exit 0
  echo "restart $n" >> "$FAKE_STATE/order.log"
  # Events the release's hooks spooled while no server answered, during this restart's gap.
  if [[ -f "$FAKE_STATE/spool-on-restart.$n" ]]; then
    mkdir -p "$HOME/.purplemux/hook-spool"
    while read -r name; do echo '{"v":1}' > "$HOME/.purplemux/hook-spool/$name"; done < "$FAKE_STATE/spool-on-restart.$n"
  fi
  pid=$((1000 + n))
  echo "$pid" > "$FAKE_STATE/mainpid"
  wd=$(sed -n 's/^WorkingDirectory=//p' "$HOME/.config/systemd/user/purplemux.service.d/50-mission-control.conf" | tail -n 1)
  [[ -e "$FAKE_STATE/stale-cwd.$n" ]] && wd="$FAKE_STATE"
  mkdir -p "$DEPLOY_PROC_ROOT/$pid"
  ln -sfn "$(readlink -f "$wd")" "$DEPLOY_PROC_ROOT/$pid/cwd"
fi
exit 0
`,
  pnpm: `#!/usr/bin/env bash
echo "$* @ $PWD" >> "$FAKE_STATE/pnpm.log"
if [[ "$1" == build ]]; then
  [[ -e "$FAKE_STATE/build-fail" ]] && { echo "build exploded" >&2; exit 1; }
  mkdir -p .next/standalone && touch .next/standalone/server.js
fi
exit 0
`,
  curl: `#!/usr/bin/env bash
out=/dev/stdout; fmt=""; url=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -H|-m|-X|--max-time) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$url" >> "$FAKE_STATE/curl.log"
echo "curl $url" >> "$FAKE_STATE/order.log"
key=$(printf '%s' "\${url#http://127.0.0.1:*/}" | tr -c 'A-Za-z0-9' '_')
n=$(cat "$FAKE_STATE/restarts" 2>/dev/null || echo 0)
file="$FAKE_STATE/http.$n/$key"
[[ -f "$file" ]] || file="$FAKE_STATE/http/$key"
if [[ ! -f "$file" ]]; then
  [[ -n "$fmt" ]] && printf '000'
  exit 7
fi
tail -n +2 "$file" > "$out"
[[ -n "$fmt" ]] && head -n 1 "$file" | tr -d '\\n'
exit 0
`,
  tmux: `#!/usr/bin/env bash
n=$(cat "$FAKE_STATE/restarts" 2>/dev/null || echo 0)
if [[ -f "$FAKE_STATE/tmux-error.$n" ]]; then cat "$FAKE_STATE/tmux-error.$n" >&2; exit 1; fi
file="$FAKE_STATE/sessions.$n"
[[ -f "$file" ]] || file="$FAKE_STATE/sessions"
cat "$file"
`,
  purplemux: `#!/usr/bin/env bash
echo "$* | PMUX_TOKEN=\${PMUX_TOKEN-unset} PMUX_TAB_TOKEN=\${PMUX_TAB_TOKEN-unset}" >> "$FAKE_STATE/purplemux.log"
case "$1 $2" in
  "lease acquire")
    code=$(cat "$FAKE_STATE/lease-acquire-exit" 2>/dev/null || echo 0)
    [[ "$code" == 3 ]] && echo '{"error":"lease held","holder":{"tabName":"other-orch"}}' >&2
    exit "$code" ;;
  "lease release") exit 0 ;;
  "deploy announce")
    echo "announce" >> "$FAKE_STATE/order.log"
    code=$(cat "$FAKE_STATE/announce-exit" 2>/dev/null || echo 0)
    if [[ "$code" != 0 ]]; then cat "$FAKE_STATE/announce-stderr" >&2; exit "$code"; fi
    echo '{"id":"d-fake1234","recipients":[{},{},{}]}'
    # The server committed; the deploy is interrupted before the script reads the id.
    [[ -e "$FAKE_STATE/term-after-announce" ]] && kill -TERM "$(ps -o ppid= $PPID | tr -d ' ')" 2>/dev/null
    exit 0 ;;
  "deploy withdraw")
    echo "withdraw" >> "$FAKE_STATE/order.log"
    printf '{"id":"d-fake1234","withdrawn":%s}' "$(cat "$FAKE_STATE/withdrawn" 2>/dev/null || echo 0)"; exit 0 ;;
  "deploy status")
    n=$(( $(cat "$FAKE_STATE/status-polls" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_STATE/status-polls"
    f="$FAKE_STATE/announce-status.$n"; [[ -f "$f" ]] || f="$FAKE_STATE/announce-status"
    cat "$f"; exit 0 ;;
  "tab list")
    n=$(cat "$FAKE_STATE/restarts" 2>/dev/null || echo 0)
    [[ -e "$FAKE_STATE/tablist-fail.$n" ]] && { echo "error: Forbidden" >&2; exit 3; }
    echo '{"tabs":[]}'; exit 0 ;;
esac
exit 0
`,
  journalctl: `#!/usr/bin/env bash
echo "journal: server crashed on boot"
`,
  // The release's acceptance gate (scripts/acceptance/run.sh): records its arguments and the
  // restarts seen so far, writes a verdict to --log, and fails when asked to.
  acceptance: `#!/usr/bin/env bash
fd9=closed; [[ -e /proc/$$/fd/9 ]] && fd9=open
echo "$* | restarts=$(cat "$FAKE_STATE/restarts" 2>/dev/null || echo 0) fd9=$fd9" >> "$FAKE_STATE/acceptance.log"
log=""
while (($#)); do case "$1" in --log) log="$2"; shift 2 ;; *) shift ;; esac; done
if [[ -e "$FAKE_STATE/acceptance-fail" ]]; then
  printf 'FAIL lease-race — measured: exit codes 0 and 0 — expected: one 0 and one 3\nACCEPTANCE=FAIL checks=20 passed=19 failed=1 skipped=0\n' > "$log"
  exit 1
fi
printf 'ACCEPTANCE=PASS checks=20 passed=20 failed=0 skipped=0\n' > "$log"
exit 0
`,
  // The release's scripts/install-hook-scripts.sh: writes four scripts into --dir and prints a
  // WROTE line for each, or fails when asked to (ADR-0020).
  'hook-install': `#!/usr/bin/env bash
dir=""
while (($#)); do case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac; done
fd9=closed; [[ -e /proc/$$/fd/9 ]] && fd9=open
echo "hook-install $dir" >> "$FAKE_STATE/order.log"
echo "$dir | restarts=$(cat "$FAKE_STATE/restarts" 2>/dev/null || echo 0) fd9=$fd9" >> "$FAKE_STATE/hook-install.log"
ls -A "$dir/hook-spool" 2>/dev/null > "$FAKE_STATE/spool-at-install"
[[ -e "$FAKE_STATE/hook-install-fail" ]] && { echo "render exploded" >&2; exit 1; }
mkdir -p "$dir"
for name in status-hook.sh statusline.sh codex-hook.sh grok-hook.sh; do
  echo "# release $name" > "$dir/$name"
  echo "WROTE $dir/$name"
done
`,
};

type TEnv = Record<string, string | undefined>;

interface IHarness {
  root: string;
  home: string;
  state: string;
  repo: string;
  liveDir: string;
  releases: string;
  dropIn: string;
  cliLink: string;
  env: TEnv;
  sha: () => string;
  commit: (message: string) => string;
  setHttp: (route: string, code: number, body: unknown, phase?: number) => void;
  setTabs: (tabs: unknown[], phase?: number) => void;
  setSessions: (names: string[], phase?: number) => void;
  run: (args: string[], extraEnv?: TEnv) => { status: number | null; out: string };
  log: (name: string) => string;
  flag: (name: string, content?: string) => void;
}

const routeKey = (route: string) => route.replace(/[^A-Za-z0-9]/g, '_');

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const makeHarness = (options: { homeViaSymlink?: boolean } = {}): IHarness => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-live-'));
  const realHome = path.join(root, 'home');
  const home = options.homeViaSymlink ? path.join(root, 'home-link') : realHome;
  const proc = path.join(root, 'proc');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const liveDir = path.join(root, 'live-worktree');
  const pmuxDir = path.join(home, '.purplemux');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  const dropIn = path.join(unitDir, 'purplemux.service.d', '50-mission-control.conf');
  const cliLink = path.join(home, '.local', 'bin', 'purplemux');
  fs.mkdirSync(realHome, { recursive: true });
  if (options.homeViaSymlink) fs.symlinkSync(realHome, home);
  for (const dir of [state, bin, repo, path.join(liveDir, 'bin'), path.join(liveDir, '.next', 'standalone'), pmuxDir, path.dirname(dropIn), path.dirname(cliLink), path.join(proc, '100')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(liveDir, '.next', 'standalone', 'server.js'), '');
  fs.writeFileSync(path.join(state, 'mainpid'), '100\n');
  fs.symlinkSync(liveDir, path.join(proc, '100', 'cwd'));
  for (const [name, body] of Object.entries(FAKES)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(pmuxDir, 'cli-token'), 'admin-token\n');
  fs.writeFileSync(path.join(pmuxDir, 'port'), '18999\n');
  fs.writeFileSync(path.join(pmuxDir, 'workspace-tokens.json'), JSON.stringify({ 'ws-a': 'ws-token-a' }));
  fs.writeFileSync(path.join(pmuxDir, 'workspaces.json'), '{"workspaces":[]}');
  fs.writeFileSync(path.join(liveDir, 'bin', 'purplemux.js'), '// live cli\n');
  fs.writeFileSync(path.join(unitDir, 'purplemux.service'), [
    '[Service]',
    `WorkingDirectory=${path.join(root, 'primary')}`,
    `ExecStart=${path.join(root, 'primary')}/node_modules/.bin/tsx server.ts`,
    '',
  ].join('\n'));
  fs.writeFileSync(dropIn, [
    '[Service]',
    `WorkingDirectory=${liveDir}`,
    'ExecStart=',
    `ExecStart=${liveDir}/node_modules/.bin/tsx server.ts`,
    '',
  ].join('\n'));
  fs.symlinkSync(path.join(liveDir, 'bin', 'purplemux.js'), cliLink);

  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  const commit = (message: string) => {
    fs.writeFileSync(path.join(repo, 'file.txt'), message);
    git(repo, 'add', 'file.txt');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  git(repo, 'add', 'tsconfig.json');
  commit('first');

  const setHttp = (route: string, code: number, body: unknown, phase?: number) => {
    const dir = path.join(state, phase === undefined ? 'http' : `http.${phase}`);
    fs.mkdirSync(dir, { recursive: true });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    fs.writeFileSync(path.join(dir, routeKey(route)), `${code}\n${text}`);
  };

  const harness: IHarness = {
    root,
    home,
    state,
    repo,
    liveDir,
    releases: path.join(pmuxDir, 'releases'),
    dropIn,
    cliLink,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      FAKE_STATE: state,
      PMUX_TAB_ID: 'tab-A',
      DEPLOY_REPO: repo,
      DEPLOY_SYSTEMCTL: path.join(bin, 'systemctl'),
      DEPLOY_PNPM: path.join(bin, 'pnpm'),
      DEPLOY_CURL: path.join(bin, 'curl'),
      DEPLOY_TMUX: path.join(bin, 'tmux'),
      DEPLOY_PURPLEMUX: path.join(bin, 'purplemux'),
      DEPLOY_JOURNALCTL: path.join(bin, 'journalctl'),
      DEPLOY_ACCEPTANCE: path.join(bin, 'acceptance'),
      DEPLOY_HOOK_INSTALL: path.join(bin, 'hook-install'),
      DEPLOY_SQLITE_MODULE: SQLITE_MODULE,
      DEPLOY_PROC_ROOT: proc,
      DEPLOY_POLL_S: '0.05',
      DEPLOY_HEALTH_INTERVAL_S: '0.05',
      DEPLOY_HEALTH_TIMEOUT_S: '1',
    },
    sha: () => git(repo, 'rev-parse', 'HEAD'),
    commit,
    setHttp,
    setTabs: (tabs, phase) => setHttp('api/cli/tabs', 200, { tabs }, phase),
    setSessions: (names, phase) => {
      fs.writeFileSync(path.join(state, phase === undefined ? 'sessions' : `sessions.${phase}`), names.map((n) => `${n}\n`).join(''));
    },
    run: (args, extraEnv = {}) => {
      const env: TEnv = { ...harness.env, ...extraEnv };
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
      const result = spawnSync('bash', [SCRIPT, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 60_000 });
      return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
    },
    flag: (name, content = '') => fs.writeFileSync(path.join(state, name), content),
    log: (name) => {
      const file = path.join(state, `${name}.log`);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    },
  };

  // A healthy server of the new shape with one quiet agent tab.
  harness.setHttp('api/cli/leases', 200, { leases: [] });
  harness.setHttp('api/health', 200, { app: 'purplemux', version: '0.0.0' });
  harness.setTabs([
    { tabId: 'tab-A', workspaceId: 'ws-a', name: 'orchestrator', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' }, busySince: 1 },
    { tabId: 'tab-B', workspaceId: 'ws-a', name: 'worker', panelType: 'claude-code', cliState: 'idle', lastEvent: { name: 'stop' }, busySince: null },
  ]);
  harness.setSessions(['pt-ws-a-p-tab-A', 'pt-ws-a-p-tab-B']);
  return harness;
};

const field = (out: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1];
const restarts = (h: IHarness) => (h.log('systemctl').match(/restart/g) ?? []).length;
const link = (p: string) => (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(p) : null);

// Each case spawns the script, git and node several times.
describe('scripts/deploy-live.sh', { timeout: 60_000 }, () => {
  let h: IHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('first install: builds, waits for quiet with the own busy tab excluded, swaps, restarts, passes health', () => {
    const sha = h.sha();
    const originalDropIn = fs.readFileSync(h.dropIn, 'utf-8');
    const { status, out } = h.run([sha]);

    expect(status, out).toBe(0);
    expect(field(out, 'VERDICT')).toBe('deployed');
    expect(field(out, 'HEALTH')).toBe('pass');
    expect(field(out, 'SESSIONS')).toBe('2/2');
    expect(field(out, 'LEASE')).toBe('acquired, released');
    const short = sha.slice(0, 12);
    const release = path.join(h.releases, short);
    expect(field(out, 'RELEASE')).toBe(release);
    expect(field(out, 'PREVIOUS')).toBe(h.liveDir);

    expect(h.log('pnpm')).toContain(`install --frozen-lockfile @ ${release}`);
    expect(h.log('pnpm')).toContain(`build @ ${release}`);
    expect(link(path.join(h.releases, 'current'))).toBe(release);
    expect(link(path.join(h.releases, 'previous'))).toBe(h.liveDir);
    expect(link(h.cliLink)).toBe(path.join(h.releases, 'current', 'bin', 'purplemux.js'));
    const dropIn = fs.readFileSync(h.dropIn, 'utf-8');
    expect(dropIn).toContain(`WorkingDirectory=${path.join(h.releases, 'current')}`);
    expect(dropIn).toContain(`ExecStart=${path.join(h.releases, 'current')}/node_modules/.bin/tsx server.ts`);
    expect(dropIn).not.toContain(h.liveDir);
    expect(fs.readFileSync(path.join(h.releases, 'first-install-rollback', 'drop-in.conf'), 'utf-8')).toBe(originalDropIn);
    expect(fs.readFileSync(path.join(h.releases, 'first-install-rollback', 'cli-link-target'), 'utf-8').trim())
      .toBe(path.join(h.liveDir, 'bin', 'purplemux.js'));
    expect(out).toContain(`+WorkingDirectory=${path.join(h.releases, 'current')}`);
    expect(h.log('systemctl')).toMatch(/--user daemon-reload[\s\S]*--user restart purplemux\.service/);
    expect(restarts(h)).toBe(1);

    const purplemux = h.log('purplemux');
    expect(purplemux).toContain('lease acquire deploy:purplemux --ttl 30m | PMUX_TOKEN=admin-token PMUX_TAB_TOKEN=unset');
    expect(purplemux).toContain('lease release deploy:purplemux');
    expect(purplemux).toContain('tab list -w ws-a | PMUX_TOKEN=ws-token-a');
  });

  it('a busy tab whose last event is stop does not block quiet; another mid-turn tab times out with exit 3', () => {
    h.setTabs([
      { tabId: 'tab-A', workspaceId: 'ws-a', name: 'orchestrator', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' } },
      { tabId: 'tab-bg', workspaceId: 'ws-a', name: 'gate-waiter', panelType: 'codex-cli', cliState: 'busy', lastEvent: { name: 'stop' } },
    ]);
    expect(h.run([h.sha()]).status).toBe(0);

    const other = makeHarness();
    try {
      other.setTabs([
        { tabId: 'tab-C', workspaceId: 'ws-c', name: 'busy-worker', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' }, busySince: Date.now() - 125_000 },
      ]);
      const { status, out } = other.run([other.sha(), '--quiet-timeout', '1']);
      expect(status, out).toBe(3);
      expect(field(out, 'VERDICT')).toBe('quiet-timeout');
      expect(out).toMatch(/MID-TURN ws-c tab-C busy-worker busy-for=12\ds/);
      expect(restarts(other)).toBe(0);
      expect(fs.existsSync(path.join(other.releases, 'current'))).toBe(false);
      expect(fs.readFileSync(other.dropIn, 'utf-8')).toContain(other.liveDir);
      expect(other.log('purplemux')).toContain('lease release deploy:purplemux');
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('a WAITING-only fleet is quiet, and the listing names each WAITING tab as quiet', () => {
    h.setTabs([
      { tabId: 'tab-A', workspaceId: 'ws-a', name: 'orchestrator', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' } },
      { tabId: 'tab-sm', workspaceId: 'ws-z', name: 'portfolio-sm', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'stop', at: Date.now() - 65_000 }, busySince: Date.now() - 18_700_000 },
    ]);
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(0);
    expect(field(out, 'QUIET')).toBe('quiet (1 WAITING)');
    expect(out).toMatch(/^WAITING ws-z tab-sm portfolio-sm waiting-for=6\ds \(quiet: background job\)$/m);
    expect(out).not.toContain('MID-TURN');
    expect(field(out, 'VERDICT')).toBe('deployed');
  });

  it('a mix blocks with the mid-turn count; a tab with no lastEvent key counts as mid-turn', () => {
    const tabs = [
      { tabId: 'tab-sm', workspaceId: 'ws-z', name: 'portfolio-sm', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'stop' } },
      { tabId: 'tab-C', workspaceId: 'ws-c', name: 'busy-worker', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' } },
      { tabId: 'tab-old', workspaceId: 'ws-c', name: 'no-event', panelType: 'claude-code', cliState: 'busy' },
    ];
    h.setTabs(tabs);
    const dry = h.run([h.sha(), '--dry-run']);
    expect(dry.status, dry.out).toBe(0);
    expect(field(dry.out, 'QUIET')).toBe('not quiet (2 mid-turn, 1 WAITING)');
    expect(dry.out).toContain('WAITING ws-z tab-sm portfolio-sm waiting-for=unknown (quiet: background job)');

    const other = makeHarness();
    try {
      other.setTabs(tabs);
      const { status, out } = other.run([other.sha(), '--quiet-timeout', '1']);
      expect(status, out).toBe(3);
      expect(field(out, 'QUIET')).toBe('timeout after 1s (2 mid-turn, 1 WAITING)');
      expect(out).toContain('MID-TURN ws-c tab-C busy-worker');
      expect(out).toContain('MID-TURN ws-c tab-old no-event');
      expect(out).not.toContain('MID-TURN ws-z tab-sm');
      expect(restarts(other)).toBe(0);
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('--force-after-timeout deploys despite a mid-turn tab', () => {
    h.setTabs([{ tabId: 'tab-C', workspaceId: 'ws-c', name: 'busy-worker', panelType: 'claude-code', cliState: 'busy', lastEvent: null }]);
    const { status, out } = h.run([h.sha(), '--quiet-timeout', '1', '--force-after-timeout']);
    expect(status, out).toBe(0);
    expect(field(out, 'QUIET')).toMatch(/^forced after timeout \(1 mid-turn\)/);
    expect(field(out, 'VERDICT')).toBe('deployed');
  });

  it('--ignore-tab excludes a named tab from the quiet wait', () => {
    h.setTabs([{ tabId: 'tab-C', workspaceId: 'ws-c', name: 'busy-worker', panelType: 'claude-code', cliState: 'busy', lastEvent: null }]);
    expect(h.run([h.sha(), '--ignore-tab', 'ws-c/tab-C']).status).toBe(0);
  });

  it('first install with a health failure after the restart restores the drop-in and CLI link and exits 4', () => {
    const originalDropIn = fs.readFileSync(h.dropIn, 'utf-8');
    h.setHttp('api/health', 503, 'down', 1);
    const { status, out } = h.run([h.sha()]);

    expect(status, out).toBe(4);
    expect(field(out, 'VERDICT')).toBe('rolled-back');
    expect(field(out, 'HEALTH')).toMatch(/^fail/);
    expect(field(out, 'ROLLBACK_HEALTH')).toBe('pass');
    expect(fs.readFileSync(h.dropIn, 'utf-8')).toBe(originalDropIn);
    expect(link(h.cliLink)).toBe(path.join(h.liveDir, 'bin', 'purplemux.js'));
    expect(link(path.join(h.releases, 'current'))).toBeNull();
    expect(restarts(h)).toBe(2);
    expect(h.log('systemctl').match(/daemon-reload/g)?.length).toBe(2);
    expect(out).toContain('journal: server crashed on boot');
  });

  it('a later install with a failing health check points current back at the previous release', () => {
    const first = h.sha();
    expect(h.run([first]).status).toBe(0);
    const second = h.commit('second');
    h.setHttp('api/health', 503, 'down', 2);
    const { status, out } = h.run([second]);

    expect(status, out).toBe(4);
    expect(field(out, 'VERDICT')).toBe('rolled-back');
    expect(link(path.join(h.releases, 'current'))).toBe(path.join(h.releases, first.slice(0, 12)));
    expect(link(h.cliLink)).toBe(path.join(h.releases, 'current', 'bin', 'purplemux.js'));
    expect(fs.readFileSync(h.dropIn, 'utf-8')).toContain(`WorkingDirectory=${path.join(h.releases, 'current')}`);
    expect(restarts(h)).toBe(3);
  });

  it('a session missing after the restart fails health and rolls back; an extra new session passes', () => {
    h.setSessions(['pt-ws-a-p-tab-A'], 1);
    const lost = h.run([h.sha()]);
    expect(lost.status, lost.out).toBe(4);
    expect(lost.out).toContain('pt-ws-a-p-tab-B');
    expect(field(lost.out, 'SESSIONS')).toBe('1/2');

    const other = makeHarness();
    try {
      other.setSessions(['pt-ws-a-p-tab-A', 'pt-ws-a-p-tab-B', 'pt-ws-a-p-tab-new'], 1);
      const extra = other.run([other.sha()]);
      expect(extra.status, extra.out).toBe(0);
      expect(field(extra.out, 'SESSIONS')).toBe('2/2');
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('a lease route answering 404 means LEASE=unavailable; a 500 exits 1 before anything restarts', () => {
    h.setHttp('api/cli/leases', 404, '<html>404</html>');
    const unavailable = h.run([h.sha()]);
    expect(unavailable.status, unavailable.out).toBe(0);
    expect(field(unavailable.out, 'LEASE')).toBe('unavailable (server predates leases)');
    expect(h.log('purplemux')).not.toContain('lease acquire');

    const other = makeHarness();
    try {
      other.setHttp('api/cli/leases', 500, { error: 'boom' });
      const failed = other.run([other.sha()]);
      expect(failed.status, failed.out).toBe(1);
      expect(failed.out).toContain('REFUSED LEASE-PROBE-FAILED');
      expect(restarts(other)).toBe(0);
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  const announceStatus = (states: string[], poll?: number) =>
    h.flag(poll === undefined ? 'announce-status' : `announce-status.${poll}`, JSON.stringify({ id: 'd-fake1234', recipients: states.map((state) => ({ state })) }));

  it('--announce tells the recipients before the quiet wait, waits until each notice is delivered or held, then deploys', () => {
    announceStatus(['queued', 'delivered', 'queued'], 1);
    announceStatus(['delivered', 'held', 'delivered']);
    const { status, out } = h.run([h.sha(), '--announce', '5']);
    expect(status, out).toBe(0);
    expect(field(out, 'VERDICT')).toBe('deployed');
    expect(field(out, 'ANNOUNCED')).toBe('2/3');
    expect(field(out, 'ANNOUNCE_ID')).toBe('d-fake1234');
    const order = h.log('order').split('\n').filter(Boolean);
    const announced = order.indexOf('announce');
    expect(announced).toBeGreaterThan(order.findIndex((l) => l.includes('api/cli/leases')));
    expect(order.findIndex((l) => l.includes('api/cli/tabs'))).toBeGreaterThan(announced);
    // Taken back before the restart, so the new server never types an out-of-date line (review round 2).
    const withdrawn = order.indexOf('withdraw');
    expect(withdrawn).toBeGreaterThan(announced);
    expect(order.findIndex((l) => l.includes('api/health'))).toBeGreaterThan(withdrawn);
    const log = h.log('purplemux');
    const short = h.sha().slice(0, 12);
    expect(log).toContain(`deploy announce --in 5 --reason deploy ${short} --except-tab tab-A --json | PMUX_TOKEN=admin-token PMUX_TAB_TOKEN=unset`);
    expect(log).toContain('deploy status d-fake1234 --json');
    // Two polls until every notice settled, and one more when the announcement closes before the restart.
    expect(fs.readFileSync(path.join(h.state, 'status-polls'), 'utf-8').trim()).toBe('3');
  });

  it('--announce stops waiting at its deadline, deploys, and withdraws the notices still waiting', () => {
    announceStatus(['delivered', 'queued', 'queued']);
    h.flag('withdrawn', '2');
    const { status, out } = h.run([h.sha(), '--announce', '1'], { DEPLOY_ANNOUNCE_WAIT_S: '1' });
    expect(status, out).toBe(0);
    expect(field(out, 'ANNOUNCED')).toBe('1/3; 2 still waiting, withdrawn');
    expect(field(out, 'VERDICT')).toBe('deployed');
  });

  it('an unreadable status body settles nothing: the wait runs to its deadline against the announced count', () => {
    h.flag('announce-status', 'not json');
    const { status, out } = h.run([h.sha(), '--announce', '1'], { DEPLOY_ANNOUNCE_WAIT_S: '1' });
    expect(status, out).toBe(0);
    // The old code took the total from the unreadable body (0) and reported 0/0 after one poll.
    expect(field(out, 'ANNOUNCED')).toBe('0/3');
  });

  it('--ignore-tab tabs are left out of the announce too', () => {
    announceStatus(['delivered', 'delivered', 'delivered']);
    const { status, out } = h.run([h.sha(), '--announce', '5', '--ignore-tab', 'ws-a/tab-X', '--ignore-tab', 'ws-b/tab-Y']);
    expect(status, out).toBe(0);
    expect(h.log('purplemux')).toContain('--except-tab tab-A --except-tab tab-X --except-tab tab-Y --json');
  });

  it('a refused deploy withdraws the notices it sent', () => {
    announceStatus(['delivered', 'delivered', 'delivered']);
    h.setTabs([
      { tabId: 'tab-A', workspaceId: 'ws-a', name: 'orchestrator', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' }, busySince: 1 },
      { tabId: 'tab-B', workspaceId: 'ws-a', name: 'worker', panelType: 'claude-code', cliState: 'busy', lastEvent: { name: 'prompt-submit' }, busySince: 1 },
    ]);
    const { status, out } = h.run([h.sha(), '--announce', '5', '--quiet-timeout', '0']);
    expect(status, out).toBe(3);
    expect(h.log('order')).toContain('withdraw');
  });

  it('--announce against a server that predates it (routes-absent) deploys and says so; any other failure refuses before the restart', () => {
    h.flag('announce-exit', '6');
    h.flag('announce-stderr', 'error: routes-absent (no such route on this server) — /api/cli/deploy/announce is not served\n');
    let r = h.run([h.sha(), '--announce', '5']);
    expect(r.status, r.out).toBe(0);
    expect(field(r.out, 'ANNOUNCED')).toBe('unavailable (the running server predates deploy announce)');

    h = makeHarness();
    h.flag('announce-exit', '3');
    h.flag('announce-stderr', 'error: forbidden (conflict — retry only after the state changes) — deploy announce needs the admin token\n');
    r = h.run([h.sha(), '--announce', '5']);
    expect(r.status, r.out).toBe(1);
    expect(field(r.out, 'VERDICT')).toBe('refused (ANNOUNCE-FAILED)');
    expect(field(r.out, 'LEASE')).toBe('acquired, released');
    expect(restarts(h)).toBe(0);
    expect(h.log('order')).not.toContain('api/cli/tabs');
  });

  it('an interrupt while the announce call is in flight still withdraws what the server queued and prints its summary', () => {
    announceStatus(['queued', 'queued', 'queued']);
    h.flag('term-after-announce');
    h.flag('withdrawn', '3');
    const { status, out } = h.run([h.sha(), '--announce', '5']);
    expect(status, out).not.toBe(0);
    expect(field(out, 'VERDICT')).toBe('interrupted');
    expect(h.log('order')).toContain('withdraw');
    expect(field(out, 'ANNOUNCED')).toContain('3 still waiting, withdrawn');
    expect(restarts(h)).toBe(0);
  });

  it('--announce takes 1 to 60 minutes; --dry-run and a deploy without it announce nothing', () => {
    for (const bad of ['0', '61', 'x']) expect(h.run([h.sha(), '--announce', bad]).status).toBe(2);
    let r = h.run([h.sha(), '--announce', '5', '--dry-run']);
    expect(field(r.out, 'ANNOUNCED')).toBe('skipped (dry run)');
    r = h.run([h.sha()]);
    expect(field(r.out, 'ANNOUNCED')).toBe('-');
    expect(h.log('purplemux')).not.toContain('deploy announce');
  });

  it('a deploy lease held elsewhere exits 3 without restarting', () => {
    fs.writeFileSync(path.join(h.state, 'lease-acquire-exit'), '3');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(3);
    expect(field(out, 'VERDICT')).toBe('lease-held');
    expect(out).toContain('other-orch');
    expect(restarts(h)).toBe(0);
  });

  it('old server shape: reads per-tab status and counts busy as mid-turn', () => {
    h.setTabs([
      { tabId: 'tab-A', workspaceId: 'ws-a', name: 'orchestrator', panelType: 'claude-code' },
      { tabId: 'tab-B', workspaceId: 'ws-a', name: 'worker', panelType: 'claude-code' },
      { tabId: 'tab-T', workspaceId: 'ws-a', name: 'shell', panelType: 'terminal' },
    ]);
    h.setHttp('api/cli/tabs/tab-A/status?workspaceId=ws-a', 200, { cliState: 'busy' });
    h.setHttp('api/cli/tabs/tab-B/status?workspaceId=ws-a', 200, { cliState: 'busy' });
    const { status, out } = h.run([h.sha(), '--quiet-timeout', '1']);

    expect(status, out).toBe(3);
    expect(out).toContain('MID-TURN ws-a tab-B worker busy-for=unknown');
    expect(out).not.toContain('MID-TURN ws-a tab-A');
    const curl = h.log('curl');
    expect(curl).toContain('/api/cli/tabs/tab-B/status?workspaceId=ws-a');
    expect(curl).not.toContain('/api/cli/tabs/tab-T/status');
  });

  it('refuses before any build when the own tab is unknown', () => {
    const { status, out } = h.run([h.sha()], { PMUX_TAB_ID: undefined });
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED OWN-TAB-UNKNOWN');
    expect(h.log('pnpm')).toBe('');
    expect(fs.existsSync(h.releases)).toBe(false);
    expect(h.run([h.sha(), '--ignore-tab', 'ws-a/tab-A'], { PMUX_TAB_ID: undefined }).status).toBe(0);
  });

  it('--outside-tab runs from a shell outside every tab without an own tab', () => {
    const { status, out } = h.run([h.sha(), '--outside-tab', '--quiet-timeout', '1'], { PMUX_TAB_ID: undefined });
    expect(status, out).toBe(3);
    expect(out).toContain('MID-TURN ws-a tab-A orchestrator');
  });

  it('refuses to redeploy the release that is already current', () => {
    expect(h.run([h.sha()]).status).toBe(0);
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED ALREADY-CURRENT');
  });

  it('rotation after a first install removes stale releases and never the live worktree', () => {
    expect(h.run([h.sha()]).status).toBe(0);
    const second = h.commit('second');
    expect(h.run([second]).status).toBe(0);
    const third = h.commit('third');
    const { status, out } = h.run([third]);

    expect(status, out).toBe(0);
    const first = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: h.repo, encoding: 'utf-8' }).stdout.trim();
    expect(fs.existsSync(path.join(h.releases, first.slice(0, 12)))).toBe(false);
    expect(out).toContain(`PRUNED ${path.join(h.releases, first.slice(0, 12))}`);
    expect(link(path.join(h.releases, 'current'))).toBe(path.join(h.releases, third.slice(0, 12)));
    expect(link(path.join(h.releases, 'previous'))).toBe(path.join(h.releases, second.slice(0, 12)));
    expect(fs.existsSync(path.join(h.liveDir, 'bin', 'purplemux.js'))).toBe(true);
  });

  it('the rotation right after a first install leaves the live-worktree target of previous alone', () => {
    fs.mkdirSync(path.join(h.releases, 'deadbeef0000'), { recursive: true });
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(0);
    expect(fs.existsSync(h.liveDir)).toBe(true);
    expect(link(path.join(h.releases, 'previous'))).toBe(h.liveDir);
    expect(out).toContain(`PRUNE-SKIPPED ${path.join(h.releases, 'deadbeef0000')}`);
  });

  it('--dry-run builds and reports the quiet state but never swaps or restarts', () => {
    const originalDropIn = fs.readFileSync(h.dropIn, 'utf-8');
    const { status, out } = h.run([h.sha(), '--dry-run']);

    expect(status, out).toBe(0);
    expect(field(out, 'VERDICT')).toBe('dry-run');
    expect(field(out, 'QUIET')).toBe('quiet');
    expect(field(out, 'LEASE')).toBe('available (not acquired: dry run)');
    expect(h.log('pnpm')).toContain('build');
    expect(restarts(h)).toBe(0);
    expect(h.log('systemctl')).toBe('');
    expect(fs.existsSync(path.join(h.releases, 'current'))).toBe(false);
    expect(fs.readFileSync(h.dropIn, 'utf-8')).toBe(originalDropIn);
    expect(link(h.cliLink)).toBe(path.join(h.liveDir, 'bin', 'purplemux.js'));
  });

  it('backs up the JSON stores and the Mission Control SQLite with its WAL rows', () => {
    const dbPath = path.join(h.home, '.purplemux', 'mission-control.sqlite');
    const live = new Database(dbPath);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE missions (id INTEGER)');
    const insert = live.prepare('INSERT INTO missions (id) VALUES (?)');
    for (let i = 0; i < 25; i += 1) insert.run(i);
    try {
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(0);
      const backup = field(out, 'BACKUP') ?? '';
      expect(backup.startsWith(path.join(h.home, '.purplemux', 'backups'))).toBe(true);
      expect(fs.existsSync(path.join(backup, 'workspaces.json'))).toBe(true);
      expect(fs.existsSync(path.join(backup, 'workspace-tokens.json'))).toBe(true);
      const copy = new Database(path.join(backup, 'mission-control.sqlite'), { readonly: true });
      expect(copy.prepare('SELECT COUNT(*) AS n FROM missions').get())
        .toEqual(live.prepare('SELECT COUNT(*) AS n FROM missions').get());
      copy.close();
    } finally {
      live.close();
    }
  });

  it('keeps the newest five backups', () => {
    const backups = path.join(h.home, '.purplemux', 'backups');
    for (let i = 0; i < 6; i += 1) fs.mkdirSync(path.join(backups, `20260101T00000${i}Z-old`), { recursive: true });
    expect(h.run([h.sha()]).status).toBe(0);
    const kept = fs.readdirSync(backups).sort();
    expect(kept).toHaveLength(5);
    expect(kept[0]).toBe('20260101T000002Z-old');
  });

  it('refuses a ref that is not a commit, low disk and a failed build without touching the live service', () => {
    const bad = h.run(['no-such-ref']);
    expect(bad.status, bad.out).toBe(2);
    expect(bad.out).toContain('REFUSED REF-NOT-COMMIT');

    const low = h.run([h.sha()], { DEPLOY_MIN_FREE_GIB: '999999999' });
    expect(low.status, low.out).toBe(2);
    expect(low.out).toContain('REFUSED DISK-FREE');
    expect(low.out).toMatch(/measured: \d+ GiB free/);

    fs.writeFileSync(path.join(h.state, 'build-fail'), '');
    const broken = h.run([h.sha()]);
    expect(broken.status, broken.out).toBe(2);
    expect(broken.out).toContain('REFUSED BUILD-FAILED');
    expect(fs.existsSync(path.join(h.releases, h.sha().slice(0, 12)))).toBe(false);
    expect(restarts(h)).toBe(0);
    expect(h.log('purplemux')).toBe('');
  });

  it('refuses a later install when the drop-in no longer runs releases/current', () => {
    expect(h.run([h.sha()]).status).toBe(0);
    fs.writeFileSync(h.dropIn, `[Service]\nWorkingDirectory=${h.liveDir}\n`);
    const { status, out } = h.run([h.commit('second')]);
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED DROPIN-DRIFT');
  });

  it('--rollback on demand returns current to the previous release', () => {
    const first = h.sha();
    expect(h.run([first]).status).toBe(0);
    const second = h.commit('second');
    expect(h.run([second]).status).toBe(0);
    const { status, out } = h.run(['--rollback']);

    expect(status, out).toBe(0);
    expect(field(out, 'VERDICT')).toBe('rolled-back');
    expect(link(path.join(h.releases, 'current'))).toBe(path.join(h.releases, first.slice(0, 12)));
    expect(link(path.join(h.releases, 'previous'))).toBe(path.join(h.releases, second.slice(0, 12)));
    // A rollback returns to a release that already ran live: no acceptance run.
    expect(field(out, 'ACCEPTANCE')).toBe('skipped (rollback)');
    expect(h.log('acceptance').trim().split('\n')).toHaveLength(2);
  });

  it('--rollback after a first install restores the saved drop-in and CLI link', () => {
    const originalDropIn = fs.readFileSync(h.dropIn, 'utf-8');
    expect(h.run([h.sha()]).status).toBe(0);
    const { status, out } = h.run(['--rollback']);

    expect(status, out).toBe(0);
    expect(fs.readFileSync(h.dropIn, 'utf-8')).toBe(originalDropIn);
    expect(link(h.cliLink)).toBe(path.join(h.liveDir, 'bin', 'purplemux.js'));
    expect(link(path.join(h.releases, 'current'))).toBeNull();
    expect(link(path.join(h.releases, 'previous'))).toBeNull();
  });

  it('--rollback proceeds when the release it escapes has a broken lease route or lease CLI', () => {
    const first = h.sha();
    expect(h.run([first]).status).toBe(0);
    expect(h.run([h.commit('second')]).status).toBe(0);
    h.setHttp('api/cli/leases', 500, { error: 'lease store corrupt' });
    const probe = h.run(['--rollback']);
    expect(probe.status, probe.out).toBe(0);
    expect(field(probe.out, 'LEASE')).toBe('unavailable (GET /api/cli/leases HTTP 500; rollback proceeds)');
    expect(link(path.join(h.releases, 'current'))).toBe(path.join(h.releases, first.slice(0, 12)));

    h.setHttp('api/cli/leases', 200, { leases: [] });
    h.flag('lease-acquire-exit', '1');
    const acquire = h.run(['--rollback']);
    expect(acquire.status, acquire.out).toBe(0);
    expect(field(acquire.out, 'LEASE')).toBe('unavailable (lease acquire exited 1; rollback proceeds)');
  });

  it('a lease acquire failure other than held exits 1 before anything restarts', () => {
    h.flag('lease-acquire-exit', '1');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(1);
    expect(out).toContain('REFUSED LEASE-ACQUIRE-FAILED');
    expect(restarts(h)).toBe(0);
  });

  it('a restart that systemctl refuses rolls back', () => {
    h.flag('restart-fail.1');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(4);
    expect(field(out, 'HEALTH')).toBe('fail (systemctl --user restart purplemux.service exited non-zero)');
    expect(field(out, 'ROLLBACK_HEALTH')).toBe('pass');
    expect(link(path.join(h.releases, 'current'))).toBeNull();
  });

  it('a failed daemon-reload on the first install rolls back without restarting the new release', () => {
    h.flag('reload-fail');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(4);
    expect(field(out, 'HEALTH')).toBe('fail (systemctl --user daemon-reload exited non-zero)');
    expect(restarts(h)).toBe(0);
    expect(link(h.cliLink)).toBe(path.join(h.liveDir, 'bin', 'purplemux.js'));
  });

  it('health fails when the restart leaves the old MainPID or the process runs another directory', () => {
    h.flag('restart-noop.1');
    const noop = h.run([h.sha()]);
    expect(noop.status, noop.out).toBe(4);
    expect(field(noop.out, 'HEALTH')).toBe('fail (MainPID 100 unchanged by the restart)');

    const other = makeHarness();
    try {
      other.flag('stale-cwd.1');
      const stale = other.run([other.sha()]);
      expect(stale.status, stale.out).toBe(4);
      expect(field(stale.out, 'HEALTH')).toMatch(/^fail \(MainPID 1001 runs in .*, expected .*releases\/[0-9a-f]{12}\)$/);
      expect(field(stale.out, 'ROLLBACK_HEALTH')).toBe('pass');
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('a first-install rollback whose daemon-reload fails reports rollback-failed and keeps current', () => {
    h.setHttp('api/health', 503, 'down', 1);
    h.flag('reload-fail.2');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(4);
    expect(field(out, 'VERDICT')).toBe('rollback-failed');
    expect(field(out, 'ROLLBACK_HEALTH')).toBe('fail (systemctl --user daemon-reload exited non-zero)');
    expect(link(path.join(h.releases, 'current'))).toBe(path.join(h.releases, h.sha().slice(0, 12)));
  });

  it('a failing workspace-token tab list after the restart fails health', () => {
    h.flag('tablist-fail.1');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(4);
    expect(field(out, 'HEALTH')).toMatch(/^fail \(workspace-token tab list failed: error: Forbidden/);
  });

  it('reports a skipped tab-list check when no workspace token exists', () => {
    fs.writeFileSync(path.join(h.home, '.purplemux', 'workspace-tokens.json'), '{}');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(0);
    expect(field(out, 'HEALTH')).toBe('pass (tab-list skipped: no workspace token)');
    expect(h.log('purplemux')).not.toContain('tab list');
  });

  it('a later install that fails health restores the exact pre-deploy current and previous', () => {
    const first = h.sha();
    expect(h.run([first]).status).toBe(0);
    const second = h.commit('second');
    expect(h.run([second]).status).toBe(0);
    const third = h.commit('third');
    h.setHttp('api/health', 503, 'down', 3);
    const { status, out } = h.run([third]);
    expect(status, out).toBe(4);
    expect(link(path.join(h.releases, 'current'))).toBe(path.join(h.releases, second.slice(0, 12)));
    expect(link(path.join(h.releases, 'previous'))).toBe(path.join(h.releases, first.slice(0, 12)));
    expect(field(out, 'PREVIOUS')).toBe(path.join(h.releases, first.slice(0, 12)));
  });

  it('a signal during the swap window is deferred until the gate finishes', () => {
    h.flag('term-on-restart.1');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(0);
    expect(field(out, 'VERDICT')).toBe('deployed');
    expect(field(out, 'INTERRUPTED')).toBe('deferred until the swap window closed');
    expect(field(out, 'ROTATION')).toBe('skipped (signal received during the swap window)');
    expect(out).toContain('signal deferred until the health gate or rollback finishes');
  });

  it('prints the first-install drop-in diff once', () => {
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(0);
    expect(out.match(/^\+WorkingDirectory=/gm)).toHaveLength(1);
  });

  it('refuses a first install when the drop-in already names a release but current is gone', () => {
    fs.writeFileSync(h.dropIn, `[Service]\nWorkingDirectory=${path.join(h.releases, 'current')}\n`);
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED FIRST-INSTALL-STATE');
    expect(h.log('pnpm')).toBe('');
  });

  it('refuses a first install whose rewritten drop-in would not run releases/current', () => {
    fs.writeFileSync(h.dropIn, `[Service]\nWorkingDirectory=${h.liveDir}\nExecStart=\nExecStart=/opt/other/tsx server.ts\n`);
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED DROPIN-REWRITE');
  });

  it('--quiet-timeout 0 still deploys when every poll is quiet', () => {
    const { status, out } = h.run([h.sha(), '--quiet-timeout', '0']);
    expect(status, out).toBe(0);
    expect(field(out, 'QUIET')).toBe('quiet');
  });

  it('a tmux list failure other than "no server" refuses before the swap; no server is an empty list', () => {
    h.flag('tmux-error.0', 'permission denied on socket');
    const failed = h.run([h.sha()]);
    expect(failed.status, failed.out).toBe(1);
    expect(failed.out).toContain('REFUSED SESSIONS-UNREADABLE');
    expect(restarts(h)).toBe(0);

    const other = makeHarness();
    try {
      other.flag('tmux-error.0', 'no server running on /tmp/tmux-1000/purple');
      const empty = other.run([other.sha()]);
      expect(empty.status, empty.out).toBe(0);
      expect(field(empty.out, 'SESSIONS')).toBe('0/0');
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('a backup failure refuses before the swap and releases the lease', () => {
    fs.writeFileSync(path.join(h.home, '.purplemux', 'mission-control.sqlite'), '');
    const { status, out } = h.run([h.sha()], { DEPLOY_SQLITE_MODULE: path.join(h.root, 'no-such-module') });
    expect(status, out).toBe(1);
    expect(out).toContain('REFUSED BACKUP-FAILED');
    expect(field(out, 'LEASE')).toBe('acquired, released');
    expect(restarts(h)).toBe(0);
  });

  it('refuses a release directory that is not a worktree at the ref', () => {
    fs.mkdirSync(path.join(h.releases, h.sha().slice(0, 12)), { recursive: true });
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED RELEASE-DIR-CONFLICT');
  });

  it('refuses a matching release worktree whose checkout was never initialized', () => {
    const sha = h.sha();
    const release = path.join(h.releases, sha.slice(0, 12));
    fs.mkdirSync(h.releases, { recursive: true });
    git(h.repo, 'worktree', 'add', '--detach', '--no-checkout', release, sha);

    const { status, out } = h.run([sha]);

    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED RELEASE-DIR-INCOMPLETE');
    expect(out).toContain('tsconfig.json');
    expect(h.log('pnpm')).toBe('');
    expect(restarts(h)).toBe(0);
  });

  it('refuses while another deploy holds the lock', () => {
    const lock = path.join(h.home, '.purplemux', 'deploy-live.lock');
    const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && spawnSync('flock', ['-n', lock, 'true']).status === 0; i += 1) {
        spawnSync('sleep', ['0.05']);
      }
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(3);
      expect(out).toContain('REFUSED DEPLOY-RUNNING');
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('--rollback refuses without both links, without the first-install save, or with an unbuilt target', () => {
    const none = h.run(['--rollback']);
    expect(none.status, none.out).toBe(2);
    expect(none.out).toContain('REFUSED NOTHING-TO-ROLL-BACK');

    expect(h.run([h.sha()]).status).toBe(0);
    fs.rmSync(path.join(h.releases, 'first-install-rollback'), { recursive: true });
    const unknown = h.run(['--rollback']);
    expect(unknown.status, unknown.out).toBe(2);
    expect(unknown.out).toContain('REFUSED ROLLBACK-STATE-UNKNOWN');

    const other = makeHarness();
    try {
      expect(other.run([other.sha()]).status).toBe(0);
      fs.rmSync(path.join(other.liveDir, '.next'), { recursive: true });
      const unbuilt = other.run(['--rollback']);
      expect(unbuilt.status, unbuilt.out).toBe(2);
      expect(unbuilt.out).toContain('REFUSED ROLLBACK-TARGET-UNBUILT');
    } finally {
      fs.rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('rotation compares resolved paths, so a symlinked HOME never prunes the running release', () => {
    const linked = makeHarness({ homeViaSymlink: true });
    try {
      expect(linked.run([linked.sha()]).status).toBe(0);
      const second = linked.commit('second');
      expect(linked.run([second]).status).toBe(0);
      const third = linked.commit('third');
      const { status, out } = linked.run([third]);
      expect(status, out).toBe(0);
      expect(fs.existsSync(path.join(linked.releases, third.slice(0, 12)))).toBe(true);
      expect(fs.existsSync(path.join(linked.releases, second.slice(0, 12)))).toBe(true);
      expect(out.match(/^PRUNED /gm)).toHaveLength(1);
    } finally {
      fs.rmSync(linked.root, { recursive: true, force: true });
    }
  });

  it('runs the release acceptance gate on the built release before the lease, backup or any restart', () => {
    const sha = h.sha();
    const { status, out } = h.run([sha]);
    expect(status, out).toBe(0);
    const release = path.join(h.releases, sha.slice(0, 12));
    const call = h.log('acceptance');
    expect(call).toContain(`--candidate ${release} --log `);
    expect(call).toContain('| restarts=0');
    // The gate never holds deploy-live.lock (fd 9): a leftover could otherwise refuse every later deploy.
    expect(call).toContain('fd9=closed');
    expect(call).not.toContain('--bash-guard');
    expect(field(out, 'ACCEPTANCE')).toMatch(/^pass \(checks=20 passed=20 failed=0 skipped=0; .*acceptance-.*\.log\)$/);
    expect(field(out, 'VERDICT')).toBe('deployed');
  });

  it('a failed acceptance run refuses with exit 2 and never leases, backs up, swaps or restarts', () => {
    h.flag('acceptance-fail');
    const originalDropIn = fs.readFileSync(h.dropIn, 'utf-8');
    const { status, out } = h.run([h.sha()]);
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED ACCEPTANCE-FAILED');
    expect(out).toContain('FAIL lease-race');
    expect(field(out, 'ACCEPTANCE')).toMatch(/^fail \(/);
    expect(field(out, 'VERDICT')).toBe('refused (ACCEPTANCE-FAILED)');
    expect(h.log('purplemux')).not.toContain('lease acquire');
    expect(restarts(h)).toBe(0);
    expect(fs.readFileSync(h.dropIn, 'utf-8')).toBe(originalDropIn);
    expect(link(path.join(h.releases, 'current'))).toBeNull();
    expect(fs.existsSync(path.join(h.home, '.purplemux', 'backups'))).toBe(false);
  });

  it('refuses a release that carries no acceptance harness', () => {
    const { status, out } = h.run([h.sha()], { DEPLOY_ACCEPTANCE: undefined });
    expect(status, out).toBe(2);
    expect(out).toContain('REFUSED ACCEPTANCE-MISSING');
    expect(restarts(h)).toBe(0);
  });

  it('--dry-run runs the acceptance gate too, and DEPLOY_BASH_GUARD makes the guard check required', () => {
    const { status, out } = h.run([h.sha(), '--dry-run'], { DEPLOY_BASH_GUARD: '/opt/guard/bash-guard.py' });
    expect(status, out).toBe(0);
    expect(h.log('acceptance')).toContain('--bash-guard /opt/guard/bash-guard.py --require-bash-guard');
    expect(field(out, 'ACCEPTANCE')).toMatch(/^pass /);
    expect(field(out, 'VERDICT')).toBe('dry-run');
    expect(restarts(h)).toBe(0);
  });

  it('a dry run whose acceptance fails is refused, so the verdict never reads dry-run', () => {
    h.flag('acceptance-fail');
    const { status, out } = h.run([h.sha(), '--dry-run']);
    expect(status, out).toBe(2);
    expect(field(out, 'VERDICT')).toBe('refused (ACCEPTANCE-FAILED)');
  });

  describe('hook script pre-install (ADR-0020)', () => {
    const pmux = () => path.join(h.home, '.purplemux');

    it('writes the release\'s hook scripts into ~/.purplemux after the quiet wait and before the restart', () => {
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(0);
      const order = h.log('order').split('\n').filter(Boolean);
      const install = order.indexOf(`hook-install ${pmux()}`);
      const lastQuietPoll = order.map((line, i) => (line.endsWith('/api/cli/tabs') ? i : -1)).filter((i) => i >= 0 && i < install).pop();
      expect(install, order.join('\n')).toBeGreaterThan(-1);
      expect(lastQuietPoll).toBeDefined();
      expect(order.indexOf('restart 1')).toBeGreaterThan(install);
      expect(h.log('hook-install')).toBe(`${pmux()} | restarts=0 fd9=closed\n`);
      expect(fs.readFileSync(path.join(pmux(), 'status-hook.sh'), 'utf-8')).toBe('# release status-hook.sh\n');
      expect(field(out, 'HOOKS')).toBe(`pre-installed 4 scripts (4 changed) from ${h.env.DEPLOY_HOOK_INSTALL}`);
    });

    it('a failed pre-install refuses with exit 1 before the swap or any restart, and releases the lease', () => {
      h.flag('hook-install-fail');
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(1);
      expect(out).toContain('REFUSED HOOK-PREINSTALL-FAILED');
      expect(out).toContain('render exploded');
      expect(field(out, 'VERDICT')).toBe('refused (HOOK-PREINSTALL-FAILED)');
      expect(field(out, 'LEASE')).toBe('acquired, released');
      expect(restarts(h)).toBe(0);
      expect(link(path.join(h.releases, 'current'))).toBeNull();
    });

    it('refuses a release without scripts/install-hook-scripts.sh before the lease or the quiet wait', () => {
      const { status, out } = h.run([h.sha()], { DEPLOY_HOOK_INSTALL: undefined });
      expect(status, out).toBe(2);
      expect(out).toContain('REFUSED HOOK-INSTALL-MISSING');
      expect(out).toContain('/scripts/install-hook-scripts.sh');
      expect(h.log('purplemux')).not.toContain('lease acquire');
      expect(h.log('curl')).not.toContain('api/cli/tabs');
      expect(restarts(h)).toBe(0);
    });

    it('--dry-run renders the scripts into a scratch directory, reports it, and leaves ~/.purplemux alone', () => {
      const { status, out } = h.run([h.sha(), '--dry-run']);
      expect(status, out).toBe(0);
      expect(field(out, 'VERDICT')).toBe('dry-run');
      expect(field(out, 'HOOKS')).toBe(`dry run: the release rendered 4 scripts (4 changed) into a scratch directory; ${pmux()} untouched`);
      expect(h.log('hook-install')).not.toContain(`${pmux()} |`);
      expect(fs.existsSync(path.join(pmux(), 'status-hook.sh'))).toBe(false);
      expect(restarts(h)).toBe(0);
    });

    it('a dry run whose render fails is refused', () => {
      h.flag('hook-install-fail');
      const { status, out } = h.run([h.sha(), '--dry-run']);
      expect(status, out).toBe(2);
      expect(field(out, 'VERDICT')).toBe('refused (HOOK-RENDER-FAILED)');
    });

    const spool = () => path.join(pmux(), 'hook-spool');
    const seedSpool = (names: string[]) => {
      fs.mkdirSync(spool(), { recursive: true });
      for (const name of names) fs.writeFileSync(path.join(spool(), name), '{"v":1}');
    };
    const setAside = (prefix = 'rollback-') => {
      const bad = path.join(spool(), 'bad');
      const dirs = fs.existsSync(bad) ? fs.readdirSync(bad).filter((d) => d.startsWith(prefix)) : [];
      return dirs.flatMap((d) => fs.readdirSync(path.join(bad, d)).map((f) => `${d}/${f}`));
    };
    /** Files the hooks spool during restart N's gap, after the pre-install. */
    const spoolOnRestart = (n: number, names: string[]) => h.flag(`spool-on-restart.${n}`, names.map((name) => `${name}\n`).join(''));

    it('--rollback to a release without the installer skips the step, rolls back, then sets the spool aside', () => {
      expect(h.run([h.sha()]).status).toBe(0);
      expect(h.run([h.commit('second')]).status).toBe(0);
      seedSpool(['1000-1-aa.json', '2000-1-bb.json']);
      const { status, out } = h.run(['--rollback'], { DEPLOY_HOOK_INSTALL: undefined });
      expect(status, out).toBe(0);
      expect(field(out, 'VERDICT')).toBe('rolled-back');
      expect(field(out, 'HOOKS')).toMatch(/^skipped \(rollback target has no scripts\/install-hook-scripts\.sh\); 2 spooled event\(s\) set aside in hook-spool\/bad\/rollback-\d{8}T\d{6}Z \(the rollback target does not drain the spool\)$/);
      expect(setAside().map((f) => f.split('/')[1]).sort()).toEqual(['1000-1-aa.json', '2000-1-bb.json']);
      expect(fs.readdirSync(spool()).filter((n) => n.endsWith('.json'))).toEqual([]);
    });

    it('an automatic rollback to a release without the installer sets the spool aside after the rollback restart', () => {
      h.setHttp('api/health', 503, 'down', 1);
      spoolOnRestart(1, ['1000-1-aa.json']);
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(4);
      expect(field(out, 'VERDICT')).toBe('rolled-back');
      expect(field(out, 'HOOKS')).toMatch(/^pre-installed 4 scripts \(4 changed\) from .*; 1 spooled event\(s\) set aside in hook-spool\/bad\/rollback-/);
      expect(setAside().map((f) => f.split('/')[1])).toEqual(['1000-1-aa.json']);
    });

    it('a rollback target that drains the spool keeps it', () => {
      const first = h.sha();
      expect(h.run([first]).status).toBe(0);
      expect(h.run([h.commit('second')]).status).toBe(0);
      const target = path.join(h.releases, first.slice(0, 12), 'scripts');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'install-hook-scripts.sh'), '#!/bin/sh\n', { mode: 0o755 });
      seedSpool(['1000-1-aa.json']);
      const { status, out } = h.run(['--rollback']);
      expect(status, out).toBe(0);
      expect(field(out, 'HOOKS')).not.toContain('set aside');
      expect(setAside()).toEqual([]);
      expect(fs.readdirSync(spool())).toContain('1000-1-aa.json');
    });

    it('an automatic rollback that fails its own health gate keeps the spool and says so', () => {
      h.setHttp('api/health', 503, 'down', 1);
      h.setHttp('api/health', 503, 'down', 2);
      spoolOnRestart(1, ['1000-1-aa.json']);
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(4);
      expect(field(out, 'VERDICT')).toBe('rollback-failed');
      expect(field(out, 'HOOKS')).toMatch(/^pre-installed 4 scripts \(4 changed\) from .*; rollback-unhealthy; spool kept$/);
      expect(setAside()).toEqual([]);
      expect(fs.readdirSync(spool())).toEqual(['1000-1-aa.json']);
    });

    it('a --rollback that fails its own health gate keeps the spool and says so', () => {
      expect(h.run([h.sha()]).status).toBe(0);
      expect(h.run([h.commit('second')]).status).toBe(0);
      h.setHttp('api/health', 503, 'down', 3);
      seedSpool(['1000-1-aa.json']);
      const { status, out } = h.run(['--rollback'], { DEPLOY_HOOK_INSTALL: undefined });
      expect(status, out).toBe(4);
      expect(field(out, 'VERDICT')).toBe('rollback-unhealthy');
      expect(field(out, 'HOOKS')).toBe('skipped (rollback target has no scripts/install-hook-scripts.sh); rollback-unhealthy; spool kept');
      expect(setAside()).toEqual([]);
      expect(fs.readdirSync(spool())).toEqual(['1000-1-aa.json']);
    });

    it('a first-install rollback sets the spool aside even when the live checkout\'s working tree has the installer; the floors file stays', () => {
      fs.mkdirSync(path.join(h.liveDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(h.liveDir, 'scripts', 'install-hook-scripts.sh'), '#!/bin/sh\n', { mode: 0o755 });
      h.setHttp('api/health', 503, 'down', 1);
      seedSpool(['.floors.json']);
      spoolOnRestart(1, ['1000-1-aa.json']);
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(4);
      expect(field(out, 'VERDICT')).toBe('rolled-back');
      expect(field(out, 'HOOKS')).toMatch(/; 1 spooled event\(s\) set aside in hook-spool\/bad\/rollback-\d{8}T\d{6}Z \(the rollback target does not drain the spool\)$/);
      expect(setAside().map((f) => f.split('/')[1])).toEqual(['1000-1-aa.json']);
      expect(fs.readdirSync(spool()).sort()).toEqual(['.floors.json', 'bad']);
    });

    it('--rollback to a first install\'s live checkout runs no installer from its working tree and sets the spool aside', () => {
      expect(h.run([h.sha()]).status).toBe(0);
      fs.mkdirSync(path.join(h.liveDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(h.liveDir, 'scripts', 'install-hook-scripts.sh'), '#!/bin/sh\necho "live tree installer" >> "$FAKE_STATE/order.log"\n', { mode: 0o755 });
      const installsBefore = h.log('hook-install');
      seedSpool(['1000-1-aa.json']);
      const { status, out } = h.run(['--rollback'], { DEPLOY_HOOK_INSTALL: undefined });
      expect(status, out).toBe(0);
      expect(field(out, 'VERDICT')).toBe('rolled-back');
      expect(field(out, 'HOOKS')).toMatch(/^skipped \(rollback target is not a release\); 1 spooled event\(s\) set aside in hook-spool\/bad\/rollback-/);
      expect(h.log('order')).not.toContain('live tree installer');
      expect(h.log('hook-install')).toBe(installsBefore);
      expect(setAside().map((f) => f.split('/')[1])).toEqual(['1000-1-aa.json']);
    });

    it('a forward deploy from a running release without the installer sets leftover spool files aside before installing the new scripts', () => {
      expect(h.run([h.sha()]).status).toBe(0);
      seedSpool(['1000-1-aa.json', '2000-1-bb.json', '.floors.json']);
      const { status, out } = h.run([h.commit('second')]);
      expect(status, out).toBe(0);
      expect(field(out, 'HOOKS')).toMatch(/^pre-installed 4 scripts \(4 changed\) from .*; 2 stale spooled event\(s\) set aside in hook-spool\/bad\/stale-\d{8}T\d{6}Z \(the running server does not drain the spool\)$/);
      expect(setAside('stale-').map((f) => f.split('/')[1]).sort()).toEqual(['1000-1-aa.json', '2000-1-bb.json']);
      // Already gone when the new scripts went in; the floors file is not an event.
      expect(fs.readFileSync(path.join(h.state, 'spool-at-install'), 'utf-8').split('\n').filter(Boolean).sort()).toEqual(['.floors.json', 'bad']);
      expect(fs.readdirSync(spool()).sort()).toEqual(['.floors.json', 'bad']);
    });

    it('a first install sets leftover spool files aside too: the live checkout counts as a server that does not drain', () => {
      seedSpool(['1000-1-aa.json']);
      const { status, out } = h.run([h.sha()]);
      expect(status, out).toBe(0);
      expect(field(out, 'HOOKS')).toMatch(/; 1 stale spooled event\(s\) set aside in hook-spool\/bad\/stale-/);
      expect(setAside('stale-').map((f) => f.split('/')[1])).toEqual(['1000-1-aa.json']);
    });

    it('a forward deploy from a running release that drains the spool leaves it for the new server', () => {
      const first = h.sha();
      expect(h.run([first]).status).toBe(0);
      const scripts = path.join(h.releases, first.slice(0, 12), 'scripts');
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(scripts, 'install-hook-scripts.sh'), '#!/bin/sh\n', { mode: 0o755 });
      seedSpool(['1000-1-aa.json']);
      const { status, out } = h.run([h.commit('second')]);
      expect(status, out).toBe(0);
      expect(field(out, 'HOOKS')).toBe(`pre-installed 4 scripts (4 changed) from ${h.env.DEPLOY_HOOK_INSTALL}`);
      expect(setAside('stale-')).toEqual([]);
      expect(fs.readdirSync(spool())).toEqual(['1000-1-aa.json']);
    });

    it('a dry run sets nothing aside', () => {
      expect(h.run([h.sha()]).status).toBe(0);
      seedSpool(['1000-1-aa.json']);
      const { status, out } = h.run([h.commit('second'), '--dry-run']);
      expect(status, out).toBe(0);
      expect(fs.readdirSync(spool())).toEqual(['1000-1-aa.json']);
    });
  });

  it('prints usage and exits 2 on unknown options', () => {
    const { status, out } = h.run(['--bogus']);
    expect(status).toBe(2);
    expect(out).toContain('usage: deploy-live.sh');
  });
});
