import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { ICheckFailure, ILandedPayload, IReviewReadyPayload, TWorkerEvent, TWorkerEventType } from '@/types/worker-event';

// The evidence checks a typed worker event passes before delivery (ADR-0043 §3). Each check is
// one validator over an injected reader, so a test runs it against a fake file system and git.

export interface ICommandResult {
  /** null when the process did not exit by itself (not found, killed by the timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type TEntryKind = 'file' | 'dir' | 'other';

export interface IEvidenceReader {
  /** The resolved real path, or null when nothing is there. */
  realpath: (p: string) => Promise<string | null>;
  /** What is at the path (symlinks followed), or null when nothing is there. */
  kind: (p: string) => Promise<TEntryKind | null>;
  /** A regular file's text, or its size when it is larger than `maxBytes`. */
  readText: (p: string, maxBytes: number) => Promise<{ text: string } | { tooLarge: number }>;
  /** `git rev-parse --verify --quiet <rev>` in `repo`: the object id, or null. */
  revParse: (repo: string, rev: string) => Promise<string | null>;
  /** `git merge-base --is-ancestor <ancestor> <descendant>` in `repo`. */
  isAncestor: (repo: string, ancestor: string, descendant: string) => Promise<boolean>;
  /** One command, no shell, in `cwd`. */
  run: (argv: string[], cwd: string) => Promise<ICommandResult>;
}

export interface IValidationContext {
  reader: IEvidenceReader;
  /** The real paths every evidence path must lie under: the sender workspace's directories. */
  roots: string[];
  /** The server-configured command that prints the key of base..head (ADR-0043 §3), or why there is none. */
  patchIdCommand: TPatchIdCommand;
}

export type TPatchIdCommand = { argv: (base: string, head: string) => string[] } | { unavailable: string };

/** The resolved, confined evidence paths of one event: `repo` always; the review-ready paths. */
export interface IResolvedEvidence {
  repo: string;
  gateLog?: string;
  reviewDir?: string;
  receipt?: string;
}

export interface IEventValidator {
  id: string;
  types: readonly TWorkerEventType[];
  /** Absent: the validator runs for every event of its types. */
  applies?: (event: TWorkerEvent) => boolean;
  check: (event: TWorkerEvent, evidence: IResolvedEvidence, ctx: IValidationContext) => Promise<ICheckFailure[]>;
}

export const GATE_LOG_MAX_BYTES = 32 * 1024 * 1024;
export const EVIDENCE_TEXT_MAX_BYTES = 1024 * 1024;
export const REVIEW_FOLDER_FILES = ['range.txt', 'diff.patch', 'status.txt', 'patch-id.txt', 'record.md'] as const;
const DETAIL_MAX = 200;

/** One line of tool output fit for a refusal: control characters removed, clipped. */
const detail = (raw: string): string => {
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX)}…` : clean || '<empty>';
};

const fail = (check: string, measured: string, expected: string): ICheckFailure => ({ check, measured, expected });

/**
 * A name inside a resolved directory. Not `path.join`: Next routes import this module, and
 * Turbopack cannot scope a path joined from an argument, so it would trace the whole project into
 * `.next/standalone` (the 46101d53 failure, refused by scripts/post-build.js).
 */
const inside = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

const within = (real: string, roots: readonly string[]): boolean =>
  roots.some((root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));

/**
 * The confinement stage, before any validator reads a byte: every evidence path resolves (symlinks
 * followed) to an entry of the expected kind under one of the roots. A path outside them is refused
 * by name; nothing at it is read.
 */
export const resolveEvidence = async (
  event: TWorkerEvent,
  ctx: IValidationContext,
): Promise<{ evidence: IResolvedEvidence | null; failures: ICheckFailure[] }> => {
  const wanted: Array<[keyof IResolvedEvidence, string, TEntryKind]> = [['repo', event.payload.repo, 'dir']];
  if (event.type === 'review-ready') {
    wanted.push(['gateLog', event.payload.gateLog, 'file'], ['reviewDir', event.payload.reviewDir, 'dir']);
    if (event.payload.receipt !== undefined) wanted.push(['receipt', event.payload.receipt, 'file']);
  }
  if (event.type === 'landed') wanted.push(['gateLog', event.payload.gateLog, 'file']);
  if (!ctx.roots.length) {
    return { evidence: null, failures: [fail('evidence-paths', 'the sender workspace has no directories', 'at least one workspace directory to hold the evidence')] };
  }
  const failures: ICheckFailure[] = [];
  const evidence: Partial<IResolvedEvidence> = {};
  for (const [field, given, kind] of wanted) {
    const real = await ctx.reader.realpath(given);
    if (real === null) {
      failures.push(fail('evidence-paths', `${field}=${given} does not exist`, `an existing ${kind === 'dir' ? 'directory' : 'file'}`));
      continue;
    }
    if (!within(real, ctx.roots)) {
      failures.push(fail('evidence-paths', `${field}=${given} resolves to ${real}`, `a path under ${ctx.roots.join(', ')}`));
      continue;
    }
    const found = await ctx.reader.kind(real);
    if (found !== kind) {
      failures.push(fail('evidence-paths', `${field}=${given} is ${found === 'dir' ? 'a directory' : found === 'file' ? 'a regular file' : 'not a regular file or directory'}`,
        kind === 'dir' ? 'a directory' : 'a regular file'));
      continue;
    }
    evidence[field] = real;
  }
  return failures.length ? { evidence: null, failures } : { evidence: evidence as IResolvedEvidence, failures };
};

const landedTarget = (payload: ILandedPayload): string => payload.target ?? 'main';

/**
 * A landed head stays valid after its branch is gone: origin deletes a branch when its PR merges,
 * and a branch may move on after the landing (review r2 N2). It must then be in the branch it landed
 * in (`target`, default `main`), locally or as origin's copy.
 */
const landedInTarget = async (payload: ILandedPayload, evidence: IResolvedEvidence, ctx: IValidationContext): Promise<boolean> => {
  const target = landedTarget(payload);
  for (const ref of [`refs/heads/${target}`, `refs/remotes/origin/${target}`]) {
    const tip = await ctx.reader.revParse(evidence.repo, ref);
    if (tip !== null && await ctx.reader.isAncestor(evidence.repo, payload.head, tip)) return true;
  }
  return false;
};

/**
 * Every type: `head` is the tip of `branch` now, and `base` is an ancestor of `head` (a stale event
 * is refused). review-ready and blocked-on keep the exact-tip rule; landed may name a head that is
 * in its target branch instead.
 */
export const rangeValidator: IEventValidator = {
  id: 'range',
  types: ['review-ready', 'landed', 'blocked-on'],
  check: async (event, evidence, ctx) => {
    const { branch, head, base } = event.payload;
    const failures: ICheckFailure[] = [];
    const tip = await ctx.reader.revParse(evidence.repo, `refs/heads/${branch}`);
    let current = tip === head;
    if (!current && event.type === 'landed') current = await landedInTarget(event.payload, evidence, ctx);
    if (!current) {
      failures.push(event.type === 'landed'
        ? fail('range', `refs/heads/${branch}=${tip ?? '<absent>'}, and head ${head} is in neither refs/heads/${landedTarget(event.payload)} nor refs/remotes/origin/${landedTarget(event.payload)}`,
          `head ${head} is the tip of ${branch}, or an ancestor of ${landedTarget(event.payload)} (the branch it landed in)`)
        : fail('range', `refs/heads/${branch}=${tip ?? '<absent>'}`, `head ${head} (the branch's current tip)`));
    }
    const baseCommit = await ctx.reader.revParse(evidence.repo, `${base}^{commit}`);
    if (baseCommit === null) {
      failures.push(fail('range', `base ${base} is not a commit in ${evidence.repo}`, 'base names a commit'));
    } else if (current && !(await ctx.reader.isAncestor(evidence.repo, base, head))) {
      failures.push(fail('range', `base ${base} is not an ancestor of head ${head}`, 'base..head is a range of the branch'));
    }
    return failures;
  },
};

export interface IGateRun {
  tree: string | null;
  verdict: string | null;
  settled: string | null;
}

/**
 * The last run of a gate log, read as gate-commit-check.sh reads it: the lines from the last
 * `START=` on (the whole log when there is none), and in them the last `GIT_TREE_END=`, the last
 * `VERDICT=` and the last `SETTLED=`.
 */
export const lastGateRun = (log: string): IGateRun => {
  const lines = log.split(/\r?\n/);
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('START=')) { from = i; break; }
  }
  const run: IGateRun = { tree: null, verdict: null, settled: null };
  for (const line of lines.slice(from)) {
    if (line.startsWith('GIT_TREE_END=')) run.tree = line.slice('GIT_TREE_END='.length).trim();
    else if (line.startsWith('VERDICT=')) run.verdict = line.slice('VERDICT='.length).trim();
    else if (line.startsWith('SETTLED=')) run.settled = line.slice('SETTLED='.length).trim();
  }
  return run;
};

/** gate-commit-check.sh's full verdict: `VALID` or `VALID (…)`. `AFFECTED-VALID` is a subset run, never a hand-off. */
const isValidVerdict = (verdict: string | null): boolean => verdict === 'VALID' || (verdict?.startsWith('VALID (') ?? false);

const readGateRun = async (evidence: IResolvedEvidence, ctx: IValidationContext, check: string): Promise<IGateRun | ICheckFailure> => {
  const read = await ctx.reader.readText(evidence.gateLog!, GATE_LOG_MAX_BYTES);
  return 'tooLarge' in read ? fail(check, `gate log is ${read.tooLarge} bytes`, `at most ${GATE_LOG_MAX_BYTES} bytes`) : lastGateRun(read.text);
};

/** review-ready and landed: the gate log's last run says `VERDICT=VALID` and `SETTLED=yes`. */
export const gateVerdictValidator: IEventValidator = {
  id: 'gate-verdict',
  types: ['review-ready', 'landed'],
  check: async (_event, evidence, ctx) => {
    const run = await readGateRun(evidence, ctx, 'gate-verdict');
    if ('check' in run) return [run];
    return isValidVerdict(run.verdict) && run.settled === 'yes'
      ? []
      : [fail('gate-verdict', `VERDICT=${detail(run.verdict ?? '<none>')} SETTLED=${detail(run.settled ?? '<none>')} in the last run of the gate log`,
        'VERDICT=VALID and SETTLED=yes in the last run (a red, unsettled or subset run is no hand-off)')];
  },
};

/** review-ready and landed: the gate log's last-run `GIT_TREE_END=` is the tree of `head`. */
export const gateTreeValidator: IEventValidator = {
  id: 'gate-tree',
  types: ['review-ready', 'landed'],
  check: async (event, evidence, ctx) => {
    const { head } = event.payload;
    const run = await readGateRun(evidence, ctx, 'gate-tree');
    if ('check' in run) return [run];
    const logged = run.tree;
    const tree = await ctx.reader.revParse(evidence.repo, `${head}^{tree}`);
    if (logged === null) return [fail('gate-tree', 'the last run of the gate log has no GIT_TREE_END= line', `GIT_TREE_END=${tree ?? '<tree of head>'}`)];
    if (tree === null) return [fail('gate-tree', `head ${head} has no tree in ${evidence.repo}`, 'head names a commit')];
    return logged === tree ? [] : [fail('gate-tree', `GIT_TREE_END=${detail(logged)}`, `GIT_TREE_END=${tree} (the tree of head ${head})`)];
  },
};

export const PATCH_ID_ENV = 'PMUX_EVENT_PATCH_ID_CMD';
const PATCH_ID_EXPECTED = `${PATCH_ID_ENV} set on the server to a JSON array of strings whose first item is an absolute path outside the sender's repo`;

const unavailable = (measured: string): ICheckFailure => ({ check: 'patch-id', measured, expected: PATCH_ID_EXPECTED, unavailable: true });

/**
 * review-ready and landed: the server-configured command over base..head prints `key`. Nothing under
 * the payload's repo is executed: the command is the server's, and one that resolves inside the repo
 * is refused as unavailable, like an unset one.
 */
export const patchIdValidator: IEventValidator = {
  id: 'patch-id',
  types: ['review-ready', 'landed'],
  check: async (event, evidence, ctx) => {
    const { base, head, key } = event.payload as IReviewReadyPayload | ILandedPayload;
    const command = ctx.patchIdCommand;
    if ('unavailable' in command) return [unavailable(command.unavailable)];
    const argv = command.argv(base, head);
    const program = await ctx.reader.realpath(argv[0]);
    if (program === null) return [unavailable(`${PATCH_ID_ENV} names ${argv[0]}, which does not exist`)];
    if (within(program, [evidence.repo])) return [unavailable(`${PATCH_ID_ENV} names ${argv[0]}, which resolves inside the sender's repo ${evidence.repo}`)];
    const result = await ctx.reader.run(argv, evidence.repo);
    if (result.code !== 0) {
      return [fail('patch-id', `${argv.join(' ')} exited ${result.code ?? 'abnormally'}: ${detail(result.stderr)}`, `exit 0 and key ${key}`)];
    }
    const printed = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
    return printed === key ? [] : [fail('patch-id', `${argv.join(' ')} printed ${detail(printed)}`, `key ${key}`)];
  },
};

/** review-ready: the review folder holds the five files, and its patch-id.txt names the same key. */
export const reviewFolderValidator: IEventValidator = {
  id: 'review-folder',
  types: ['review-ready'],
  check: async (event, evidence, ctx) => {
    const { key } = event.payload as IReviewReadyPayload;
    const dir = evidence.reviewDir!;
    const missing: string[] = [];
    for (const name of REVIEW_FOLDER_FILES) {
      if ((await ctx.reader.kind(inside(dir, name))) !== 'file') missing.push(name);
    }
    if (missing.length) {
      return [fail('review-folder', `${dir} lacks ${missing.join(', ')}`, `${dir} holds ${REVIEW_FOLDER_FILES.join(', ')}`)];
    }
    const idFile = await ctx.reader.realpath(inside(dir, 'patch-id.txt'));
    if (idFile === null || !within(idFile, ctx.roots)) {
      return [fail('review-folder', `${dir}/patch-id.txt resolves outside the evidence roots`, `a path under ${ctx.roots.join(', ')}`)];
    }
    const read = await ctx.reader.readText(idFile, EVIDENCE_TEXT_MAX_BYTES);
    if ('tooLarge' in read) return [fail('review-folder', `patch-id.txt is ${read.tooLarge} bytes`, `at most ${EVIDENCE_TEXT_MAX_BYTES} bytes`)];
    const recorded = read.text.trim().split(/\s+/)[0] ?? '';
    return recorded === key ? [] : [fail('review-folder', `patch-id.txt names ${detail(recorded)}`, `key ${key} (the folder reviews this range)`)];
  },
};

const BLOCK_VERDICT = /^\s*verdict:\s*BLOCK\b/im;

/**
 * review-ready, when a receipt is given: it is `<key>.md`, and it holds no `verdict: BLOCK` (that
 * belongs at `<key>.block.md`). A first hand-off for review has no receipt yet.
 */
export const receiptValidator: IEventValidator = {
  id: 'receipt',
  types: ['review-ready'],
  applies: (event) => event.type === 'review-ready' && event.payload.receipt !== undefined,
  check: async (event, evidence, ctx) => {
    const { key } = event.payload as IReviewReadyPayload;
    const receipt = (event.payload as IReviewReadyPayload).receipt!;
    const expected = `${key}.md`;
    const name = path.basename(receipt);
    if (name !== expected) {
      const why = name === `${key}.block.md` ? ' (a BLOCK receipt is not review-ready)' : '';
      return [fail('receipt', `receipt named ${detail(name)}${why}`, `receipt named ${expected}`)];
    }
    const read = await ctx.reader.readText(evidence.receipt!, EVIDENCE_TEXT_MAX_BYTES);
    if ('tooLarge' in read) return [fail('receipt', `receipt is ${read.tooLarge} bytes`, `at most ${EVIDENCE_TEXT_MAX_BYTES} bytes`)];
    return BLOCK_VERDICT.test(read.text)
      ? [fail('receipt', `${expected} holds verdict: BLOCK`, `no BLOCK verdict in ${expected}; a BLOCK belongs at ${key}.block.md`)]
      : [];
  },
};

export const DEFAULT_VALIDATORS: readonly IEventValidator[] = [
  rangeValidator, gateVerdictValidator, gateTreeValidator, patchIdValidator, reviewFolderValidator, receiptValidator,
];

/**
 * Confinement first; then every validator of the event's type. All of them run, so one refusal
 * names every failure. A validator that throws is a failure of that check, never a pass.
 */
export const validateWorkerEvent = async (
  event: TWorkerEvent,
  ctx: IValidationContext,
  validators: readonly IEventValidator[] = DEFAULT_VALIDATORS,
): Promise<{ passed: string[]; failures: ICheckFailure[] }> => {
  const resolved = await resolveEvidence(event, ctx);
  if (!resolved.evidence) return { passed: [], failures: resolved.failures };
  const passed = ['evidence-paths'];
  const failures: ICheckFailure[] = [];
  for (const validator of validators.filter((v) => v.types.includes(event.type) && (v.applies?.(event) ?? true))) {
    let found: ICheckFailure[];
    try {
      found = await validator.check(event, resolved.evidence, ctx);
    } catch (err) {
      found = [fail(validator.id, `the check could not run: ${detail(err instanceof Error ? err.message : String(err))}`, 'a check that runs')];
    }
    if (found.length) failures.push(...found);
    else passed.push(validator.id);
  }
  return { passed, failures };
};

// ─── the server's reader ──────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_MAX = 1024 * 1024;

/**
 * Git config keys that make git run a program, pinned for every command the server runs in the
 * sender's repo: its own reads and the configured patch-id command (review r2 N1). The
 * `GIT_CONFIG_COUNT` environment config outranks the repo's `.git/config`, so a worker-set
 * `diff.external` or `core.fsmonitor` never runs. Attribute drivers (`diff.<driver>.textconv`,
 * `filter.<driver>.*`) cannot be pinned by name: the patch-id script must use plumbing with
 * `--no-ext-diff --no-textconv` (the API guide says so).
 */
export const GIT_CONFIG_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['diff.external', ''],
  ['core.pager', 'cat'],
  ['core.editor', 'false'],
  ['core.sshCommand', 'false'],
  ['core.askPass', ''],
  ['credential.helper', ''],
  ['core.alternateRefsCommand', ''],
  ['gpg.program', 'false'],
];

const gitConfigEnv = (): Record<string, string> => Object.fromEntries([
  ['GIT_CONFIG_COUNT', String(GIT_CONFIG_OVERRIDES.length)],
  ...GIT_CONFIG_OVERRIDES.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]]),
]);

/** No token, no caller environment: PATH, HOME, NODE_ENV, a locale and the git config overrides only. */
export const commandEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', LANG: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0', ...gitConfigEnv(),
});

const runCommand = (argv: string[], cwd: string): Promise<ICommandResult> =>
  new Promise((resolve) => {
    if (!argv.length) {
      resolve({ code: null, stdout: '', stderr: 'empty command' });
      return;
    }
    execFile(argv[0], argv.slice(1), { cwd, env: commandEnv(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_MAX, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === null ? err.message : '') });
      });
  });

export const fsEvidenceReader: IEvidenceReader = {
  realpath: (p) => fs.realpath(p).catch(() => null),
  kind: async (p) => {
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) return null;
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other';
  },
  /**
   * O_NOFOLLOW and O_NONBLOCK on the resolved path, then fstat on the open descriptor: a swap to a
   * symlink fails the open, and a swap to a FIFO opens without blocking and is refused as not regular.
   */
  readText: async (p, maxBytes) => {
    const handle = await fs.open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`${p} is not a regular file`);
      if (stat.size > maxBytes) return { tooLarge: stat.size };
      return { text: await handle.readFile({ encoding: 'utf8' }) };
    } finally {
      await handle.close();
    }
  },
  revParse: async (repo, rev) => {
    const result = await runCommand(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', rev], repo);
    const id = result.stdout.trim();
    return result.code === 0 && id ? id : null;
  },
  isAncestor: async (repo, ancestor, descendant) =>
    (await runCommand(['git', '-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], repo)).code === 0,
  run: runCommand,
};

/**
 * `PMUX_EVENT_PATCH_ID_CMD`: a JSON array of strings whose first item is an absolute path, with
 * `{base}` and `{head}` placeholders, run in the event's repo. Unset or malformed, there is no
 * command, and the patch-id check is unavailable: the server never runs the sender's own script.
 */
export const patchIdCommandFrom = (raw: string | undefined): TPatchIdCommand => {
  if (!raw?.trim()) return { unavailable: `${PATCH_ID_ENV} is unset on the server` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unavailable: `${PATCH_ID_ENV} is not JSON` };
  }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((part) => typeof part === 'string' && part)) {
    return { unavailable: `${PATCH_ID_ENV} is not a non-empty JSON array of strings` };
  }
  const template = parsed as string[];
  if (!path.isAbsolute(template[0]) || template[0].includes('{')) {
    return { unavailable: `${PATCH_ID_ENV} starts with ${JSON.stringify(template[0])}, not an absolute path` };
  }
  return { argv: (base, head) => template.map((part) => part.replaceAll('{base}', base).replaceAll('{head}', head)) };
};
