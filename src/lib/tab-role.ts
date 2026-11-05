import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { writeScriptAtomic } from '@/lib/hook-scripts';
import { readServerPort } from '@/lib/server-port';
import type { TPanelType, TTabRole } from '@/types/terminal';

// ADR-0040: the evaluator drives one preview origin and reads state; it cannot
// change the repository. The tool configuration, not prompt text, enforces that:
// four built-in tools only; the edit tools and the process, socket and docker
// readers denied; reads denied under twelve credential directories and files in
// HOME and of any file named *token*, *secret*, *.pem or *.key anywhere; dontAsk
// denying everything not allowed (so
// bypass permissions is never passed); and the only MCP server is
// chrome-devtools on headless Chrome, confined to the preview origin and to the
// tab's evidence directory.

export const TAB_ROLES: readonly TTabRole[] = ['evaluator'];

export const isTabRole = (value: unknown): value is TTabRole =>
  typeof value === 'string' && (TAB_ROLES as readonly string[]).includes(value);

/** `--tools`: the whole built-in set; every other built-in (EnterWorktree, Task, Cron*, ...) does not exist. */
export const EVALUATOR_BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;

export const EVALUATOR_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/**
 * Credential paths. `~/` is HOME; `//` is the filesystem root, so a name
 * pattern binds every directory, not only the cwd (a bare `**` would be
 * cwd-relative). A Read deny rule also binds Grep, Glob and the read-only Bash
 * commands dontAsk lets through (`cat`, `ls`, ...).
 */
export const EVALUATOR_READ_DENY = [
  '~/.purplemux/**', '~/.config/**', '~/.aws/**', '~/.ssh/**', '~/.claude/**', '~/.codex/**', '~/.gnupg/**',
  '~/.netrc', '~/.git-credentials', '~/.docker/**', '~/.pg_service.conf', '~/.pgpass',
  '//**/*token*', '//**/*secret*', '//**/*.pem', '//**/*.key',
].map((pattern) => `Read(${pattern})`);

/** Process, socket and container readers in dontAsk's read-only Bash set: they show other sessions' argv and env. */
export const EVALUATOR_BASH_DENY = ['docker', 'ps', 'pgrep', 'lsof', 'ss'].map((command) => `Bash(${command}:*)`);

/** A `~/.pg_service.conf` entry name: `--pg-service`, and `PGSERVICE` inside the tab. */
export const PG_SERVICE_RE = /^[A-Za-z0-9_-]{1,63}$/;

/** The user-space psql the wrapper runs by absolute path (`apt-get download` + `dpkg -x`, no system install). */
export const PG_CLIENT_DIR = '.local/lib/pg-client';

/** chrome-devtools-mcp honours `--allowedUrlPattern` only from Chrome 149. */
export const EVALUATOR_MIN_CHROME_MAJOR = 149;

/** Pinned: a moving `@latest` would change the evaluator's tool set under a running calibration. */
export const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp@1.12.0';

export const CHROME_DEVTOOLS_MCP_SERVER = 'chrome-devtools';

const binDir = () => path.join(os.homedir(), '.purplemux', 'bin');

export const evaluatorSqlPath = (): string => path.join(binDir(), 'evaluator-sql');

export const evaluatorChromeMcpPath = (): string => path.join(binDir(), 'evaluator-chrome-mcp');

export const headlessChromePath = (): string => path.join(os.homedir(), '.local', 'bin', 'headless-chrome');

/** Screenshots land in `<root>/<tabId>/`, outside every repository and worktree. */
export const evaluatorEvidenceRoot = (): string => path.join(os.homedir(), '.purplemux', 'evaluator');

export const EVALUATOR_SQL_SCRIPT = `#!/bin/sh
# evaluator-sql "<sql>": one read-only SQL statement for an evaluator tab (ADR-0040, generated).
# It connects to the libpq service purplemux exported as PGSERVICE at launch (\`tab create --pg-service\`).
# The guard is that service's SELECT-only role; this wrapper is a second layer: a scrubbed environment,
# no psqlrc, a read-only transaction, and no flag or meta-command to abuse.
set -eu
[ "$#" -eq 1 ] || { echo "evaluator-sql: takes exactly one argument, the SQL text (got $#)" >&2; exit 2; }
case "$1" in
  *\\\\*) echo "evaluator-sql: a backslash is refused (no psql meta-commands)" >&2; exit 2 ;;
esac
stmt=$(printf '%s' "$1" | sed 's/[[:space:]]*;[[:space:]]*$//')
case "$stmt" in
  *\\;*) echo "evaluator-sql: one statement only" >&2; exit 2 ;;
esac
service="\${PGSERVICE:-}"
case "$service" in
  '') echo "evaluator-sql: no database: this tab was created without --pg-service" >&2; exit 2 ;;
  *[!A-Za-z0-9_-]*) echo "evaluator-sql: PGSERVICE is not a service name" >&2; exit 2 ;;
esac
[ "\${#service}" -le 63 ] || { echo "evaluator-sql: PGSERVICE is not a service name" >&2; exit 2; }
client="$HOME/${PG_CLIENT_DIR}"
psql="$client/usr/lib/postgresql/18/bin/psql"
[ -x "$psql" ] || { echo "evaluator-sql: no psql at $psql (unpack postgresql-client-18 and libpq5 there, ADR-0040)" >&2; exit 2; }
exec env -i HOME="$HOME" LD_LIBRARY_PATH="$client/usr/lib/x86_64-linux-gnu" PGOPTIONS='-c default_transaction_read_only=on' \\
  "$psql" -X -q -At -v ON_ERROR_STOP=1 -d "service=$service" -c "$stmt"
`;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const evaluatorMcpFilterPath = (): string => path.join(binDir(), 'evaluator-mcp-filter.cjs');

/**
 * chrome-devtools-mcp lets its file tools write under every root the client
 * offers, and claude offers its working directory: the repository. The filter
 * drops the client's `roots` capability from `initialize`, leaving the
 * server's `--workspace` and the temp directory, which the launcher moves
 * inside the evidence directory.
 */
export const EVALUATOR_MCP_FILTER_SCRIPT = `'use strict';
// evaluator-mcp-filter: node evaluator-mcp-filter.cjs CMD [ARGS...] (ADR-0040, generated)
const { spawn } = require('child_process');
const readline = require('readline');

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', (err) => { process.stderr.write('evaluator-mcp-filter: ' + err.message + '\\n'); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));

const withoutRoots = (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return line; }
  if (!message || message.method !== 'initialize' || !message.params || !message.params.capabilities) return line;
  delete message.params.capabilities.roots;
  return JSON.stringify(message);
};

readline.createInterface({ input: process.stdin })
  .on('line', (line) => child.stdin.write(withoutRoots(line) + '\\n'))
  .on('close', () => child.stdin.end());
`;

interface IChromeMcpScriptOptions {
  /** The node that runs the filter: the server's own, so the tab's PATH need not reach one. */
  node: string;
  /** Put first on PATH for npx: the server's node directory when it holds npx. */
  pathPrefix: string | null;
}

export const evaluatorChromeMcpScript = ({ node, pathPrefix }: IChromeMcpScriptOptions): string => `#!/bin/sh
# evaluator-chrome-mcp: the chrome-devtools MCP server of an evaluator tab (ADR-0040, generated),
# on ~/.local/bin/headless-chrome, with every file it writes under the tab's evidence directory.
set -eu
${pathPrefix ? `PATH=${shQuote(pathPrefix)}:"$PATH"\nexport PATH\n` : ''}[ "$#" -eq 1 ] || { echo "evaluator-chrome-mcp: takes one argument, the preview URL pattern" >&2; exit 2; }
version=$("$HOME/.local/bin/headless-chrome" --version 2>/dev/null || true)
major=$(printf '%s\\n' "$version" | sed -n 's/.* \\([0-9][0-9]*\\)\\.[0-9.]*$/\\1/p')
[ "\${major:-0}" -ge ${EVALUATOR_MIN_CHROME_MAJOR} ] || { echo "evaluator-chrome-mcp: the preview allow-list needs Chrome ${EVALUATOR_MIN_CHROME_MAJOR}+; ~/.local/bin/headless-chrome is \${version:-missing}" >&2; exit 2; }
tab="\${PMUX_TAB_ID:-}"
case "$tab" in
  ''|*[!A-Za-z0-9_-]*) echo "evaluator-chrome-mcp: PMUX_TAB_ID is missing or not a tab id" >&2; exit 2 ;;
esac
dir="$HOME/.purplemux/evaluator/$tab"
mkdir -p "$dir/tmp"
TMPDIR="$dir/tmp" ELECTRON_RUN_AS_NODE=1
export TMPDIR ELECTRON_RUN_AS_NODE
exec ${shQuote(node)} "$HOME/.purplemux/bin/evaluator-mcp-filter.cjs" npx -y ${CHROME_DEVTOOLS_MCP_PACKAGE} --headless --isolated \\
  --executablePath "$HOME/.local/bin/headless-chrome" \\
  --workspace "$dir" --allowedUrlPattern "$1" --no-usage-statistics --no-performance-crux
`;

const serverPathPrefix = async (): Promise<string | null> => {
  const dir = path.dirname(process.execPath);
  return fs.access(path.join(dir, 'npx'), fs.constants.X_OK).then(() => dir, () => null);
};

export const ensureEvaluatorTools = async (): Promise<void> => {
  await fs.mkdir(binDir(), { recursive: true });
  await writeScriptAtomic(evaluatorSqlPath(), EVALUATOR_SQL_SCRIPT, 0o755);
  await writeScriptAtomic(evaluatorMcpFilterPath(), EVALUATOR_MCP_FILTER_SCRIPT, 0o644);
  const launcher = evaluatorChromeMcpScript({ node: process.execPath, pathPrefix: await serverPathPrefix() });
  await writeScriptAtomic(evaluatorChromeMcpPath(), launcher, 0o755);
};

export const evaluatorDeniedTools = (): string[] => [...EVALUATOR_DISALLOWED_TOOLS, ...EVALUATOR_READ_DENY, ...EVALUATOR_BASH_DENY];

/**
 * The environment an evaluator's claude starts with: its libpq service. Every
 * local claude command starts with this (claude-command.ts `claudeCommand`).
 */
export const evaluatorEnvPrefix = (opts?: { role?: TTabRole; pgService?: string }): string => {
  if (opts?.role !== 'evaluator' || opts.pgService === undefined) return '';
  if (!PG_SERVICE_RE.test(opts.pgService)) throw new Error('an evaluator\'s pgService is not a service name (ADR-0040)');
  return `PGSERVICE=${opts.pgService} `;
};

export const evaluatorAllowedTools = (): string[] => [
  `Bash(${evaluatorSqlPath()}:*)`,
  `mcp__${CHROME_DEVTOOLS_MCP_SERVER}`,
  'Read',
  'Grep',
  'Glob',
];

/** The URL Pattern of everything under one origin (an origin carries its port, so no other port matches). */
export const previewUrlPattern = (previewOrigin: string): string => `${previewOrigin}/*`;

export const evaluatorMcpConfig = (previewOrigin: string): string =>
  JSON.stringify({ mcpServers: { [CHROME_DEVTOOLS_MCP_SERVER]: { command: evaluatorChromeMcpPath(), args: [previewUrlPattern(previewOrigin)] } } });

/**
 * The claude flags of an evaluator launch. `--setting-sources ''` drops user,
 * project and local settings, whose allow rules would otherwise merge into this
 * list; the hook `--settings` file still loads.
 */
export const evaluatorClaudeFlags = async (previewOrigin: string | undefined): Promise<string[]> => {
  // Fail closed: an evaluator launched without its preview origin would browse anywhere.
  if (!previewOrigin || parsePreviewOrigin(previewOrigin) !== previewOrigin) throw new Error('an evaluator launch needs the tab\'s preview origin (ADR-0040)');
  await ensureEvaluatorTools();
  return [
    `--tools ${EVALUATOR_BUILTIN_TOOLS.join(',')}`,
    `--disallowedTools ${shQuote(evaluatorDeniedTools().join(','))}`,
    '--permission-mode dontAsk',
    `--allowedTools ${shQuote(evaluatorAllowedTools().join(','))}`,
    '--strict-mcp-config',
    `--mcp-config ${shQuote(evaluatorMcpConfig(previewOrigin))}`,
    "--setting-sources ''",
  ];
};

// A hostname or IPv4 address. The WHATWG URL parser keeps `*`, `(`, `+` in a
// host, and each is URL Pattern syntax that would widen `--allowedUrlPattern`
// beyond one origin; chrome-devtools-mcp 1.12.0 cannot compile a bracketed IPv6
// host into its pattern at all.
const PLAIN_HOST_RE = /^[A-Za-z0-9.-]+$/;

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

type TPreviewCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * `--preview-url`: an http(s) URL without credentials, on a plain host and not on
 * this server's own port, reduced to its origin.
 */
export const checkPreviewUrl = (value: unknown): TPreviewCheck => {
  if (value === undefined || value === null) return { ok: false, reason: 'is required: the http(s) URL of the preview it may browse' };
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return { ok: false, reason: `${JSON.stringify(value)} is not a URL` };
  }
  if (!Object.hasOwn(DEFAULT_PORT, url.protocol)) return { ok: false, reason: `must be http or https, not ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: 'must not carry credentials' };
  if (url.hostname.startsWith('[')) return { ok: false, reason: `host ${url.hostname} is IPv6, which chrome-devtools-mcp 1.12.0 cannot compile into its URL pattern; use a hostname (localhost, or one that resolves to it)` };
  if (!PLAIN_HOST_RE.test(url.hostname)) return { ok: false, reason: `host ${JSON.stringify(url.hostname)} must be a hostname or an IPv4 address` };
  const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol];
  // The evaluator browsing purplemux itself would reach its API with the owner's session.
  if (port === readServerPort()) return { ok: false, reason: `port ${port} is purplemux's own; point it at the preview` };
  return { ok: true, origin: url.origin };
};

export const parsePreviewOrigin = (value: unknown): string | null => {
  const checked = checkPreviewUrl(value);
  return checked.ok ? checked.origin : null;
};

const run = promisify(execFile);

type TBrowserCheck = { ok: true; version: string } | { ok: false; error: string };

/** The role refuses rather than run without the allow-list: `--allowedUrlPattern` needs Chrome 149+. */
export const checkEvaluatorBrowser = async (): Promise<TBrowserCheck> => {
  const chrome = headlessChromePath();
  let version: string;
  try {
    version = (await run(chrome, ['--version'], { timeout: 15_000 })).stdout.trim();
  } catch (err) {
    return { ok: false, error: `the evaluator role needs ${chrome} (Chrome ${EVALUATOR_MIN_CHROME_MAJOR}+): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
  const major = Number(/(\d+)\.\d+\.\d+\.\d+/.exec(version)?.[1] ?? 0);
  if (major < EVALUATOR_MIN_CHROME_MAJOR) {
    return { ok: false, error: `the evaluator role needs Chrome ${EVALUATOR_MIN_CHROME_MAJOR}+ for its preview allow-list; ${chrome} is ${version || 'unversioned'}` };
  }
  return { ok: true, version };
};

type TTabRoleCheck =
  | { ok: true; role?: TTabRole; previewOrigin?: string; pgService?: string }
  | { ok: false; body: { error: string; code: 'invalid-request'; role: unknown } };

/**
 * `tab create --role`: a known role, on a local claude-code tab (an omitted
 * type means claude-code), with the preview origin it may browse.
 */
export const checkTabRole = (role: unknown, panelType: TPanelType | undefined, host: unknown, previewUrl: unknown, pgService?: unknown): TTabRoleCheck => {
  const refuse = (error: string): TTabRoleCheck => ({ ok: false, body: { error, code: 'invalid-request', role: role ?? null } });
  if (role === undefined || role === null) {
    if (previewUrl !== undefined) return refuse('previewUrl goes with role evaluator');
    return pgService === undefined ? { ok: true } : refuse('pgService goes with role evaluator');
  }
  if (!isTabRole(role)) return refuse(`role must be one of ${TAB_ROLES.join(', ')}`);
  if (panelType !== undefined && panelType !== 'claude-code') return refuse(`the ${role} role runs claude-code only, not ${panelType} (ADR-0040)`);
  if (host !== undefined) return refuse(`a ${role} tab runs on this host only: the remote kit has no ${role} tool configuration (ADR-0040)`);
  const preview = checkPreviewUrl(previewUrl);
  if (!preview.ok) return refuse(`the ${role} role's previewUrl ${preview.reason} (ADR-0040)`);
  if (pgService === undefined) return { ok: true, role, previewOrigin: preview.origin };
  if (typeof pgService !== 'string' || !PG_SERVICE_RE.test(pgService)) return refuse('pgService must name a ~/.pg_service.conf entry: 1-63 of A-Z a-z 0-9 _ - (ADR-0040)');
  return { ok: true, role, previewOrigin: preview.origin, pgService };
};
