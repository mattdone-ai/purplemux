import { PRISTINE_ENV } from '@/lib/pristine-env';

const INHERITED_KEYS = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TERM',
  'COLORTERM',
  'LANG',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'SSH_CONNECTION',
  'SSH_TTY',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'TZ',
]);

const INHERITED_PREFIXES = ['LC_'];

const isInherited = (key: string): boolean =>
  INHERITED_KEYS.has(key) || INHERITED_PREFIXES.some((p) => key.startsWith(p));

const FORCED_OVERRIDES: Record<string, string> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
};

// 로그인 셸은 자기 rc 체인으로 PATH를 처음부터 빌드한다. resolved PATH(앱이 도구를
// 찾으려고 미리 합성한 값)를 주입하면, asdf/uv 등의 idempotent PATH 가드가 "이미 있네"
// 하고 재배치를 건너뛰어 실제 터미널과 순서가 어긋난다(shim이 standalone보다 앞섬).
// 따라서 펜 셸에는 최소 floor만 주고 셸이 직접 쌓게 한다. macOS는 path_helper가, Linux는
// /etc/profile이 이 위에 base를 보정한다.
const LOGIN_SHELL_BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const collectShellEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(PRISTINE_ENV)) {
    if (value !== undefined && isInherited(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...FORCED_OVERRIDES };
};

export const buildShellEnv = (): NodeJS.ProcessEnv => collectShellEnv() as NodeJS.ProcessEnv;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const defaultShell = (): string =>
  PRISTINE_ENV.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

// 사용자 펜 셸을 띄우는 유일한 경로(tmux.ts createSession). env -i로 tmux 서버가 캐시한
// 환경을 전부 지우므로 펜 셸 env는 여기서만 결정된다. PATH는 resolved 값 대신 floor를 줘서
// 셸이 실제 터미널과 동일하게 rebuild하도록 한다. 새 펜 생성 경로를 추가할 때도 반드시 이
// 함수를 거쳐야 한다 — split-window 등을 env -i 없이 직접 호출하면 서버 env(resolved PATH)를
// 상속해 순서 문제가 재발한다.
export const buildShellLaunchCommand = (extraEnv: Record<string, string> = {}): string => {
  const env = { ...collectShellEnv(), PATH: LOGIN_SHELL_BASE_PATH, ...extraEnv };
  const envArgs = Object.entries(env)
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(' ');
  // TMUX/TMUX_PANE은 tmux가 pane 생성 시 환경변수로 주입한다. env -i가 이걸 지우지
  // 않도록 sh가 "$TMUX"를 expand하게 따옴표를 그대로 둔다 (Node가 아닌 sh에서 치환).
  const tmuxVars = 'TMUX="$TMUX" TMUX_PANE="$TMUX_PANE"';
  return `env -i ${tmuxVars} ${envArgs} ${shQuote(defaultShell())} -l`;
};

const REMOTE_INHERITED_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'XDG_RUNTIME_DIR'];

/**
 * The pane shell of a remote tab (ADR-0022). Like `buildShellLaunchCommand`,
 * but the account values are the REMOTE host's: the sh that tmux runs the
 * command with expands them there. Only `extraEnv` comes from this host.
 */
export const buildRemoteShellLaunchCommand = (extraEnv: Record<string, string> = {}, envFile?: string): string => {
  const inherited = REMOTE_INHERITED_KEYS.map((k) => `${k}="$${k}"`).join(' ');
  const fixed = { PATH: LOGIN_SHELL_BASE_PATH, ...FORCED_OVERRIDES, ...extraEnv };
  const envArgs = Object.entries(fixed).map(([k, v]) => `${k}=${shQuote(v)}`).join(' ');
  const head = `env -i TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${inherited} ${envArgs}`;
  if (!envFile) return `${head} "\${SHELL:-/bin/sh}" -l`;
  // `envFile` is a double-quoted path the pane's sh expands; the file is read once, then removed.
  const loader = 'set -a; [ -f "$1" ] && . "$1"; set +a; rm -f "$1"; exec "${SHELL:-/bin/sh}" -l';
  return `${head} sh -c ${shQuote(loader)} pmux-tab ${envFile}`;
};
