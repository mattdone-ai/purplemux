import type { ICommandResult, IEvidenceReader, TEntryKind } from '@/lib/worker-event-validators';

// A fake file system and git for the typed-event validators (ADR-0043 §3): hermetic, no disk.

export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const KEY = 'c'.repeat(40);
export const TREE = 'd'.repeat(40);
export const ROOT = '/w';
export const REPO = '/w/repo';
/** The server-configured patch-id command (ADR-0043 §3): outside every sender's repo. */
export const PATCH_ID_PROGRAM = '/opt/pmux/patch-id.sh';
export const PATCH_ID_ENV_VALUE = JSON.stringify([PATCH_ID_PROGRAM, '{base}', '{head}']);

export class FakeEvidence {
  files = new Map<string, string>();
  dirs = new Set<string>([ROOT, REPO]);
  /** Path → the real path it resolves to (a symlink). */
  links = new Map<string, string>();
  others = new Set<string>();
  refs = new Map<string, string>([['refs/heads/story/x-1', HEAD]]);
  commits = new Set<string>([HEAD, BASE]);
  trees = new Map<string, string>([[HEAD, TREE]]);
  ancestors = new Set<string>([`${BASE}..${HEAD}`]);
  runs: Array<{ argv: string[]; cwd: string }> = [];
  command: (argv: string[], cwd: string) => ICommandResult = () => ({ code: 0, stdout: `${KEY}\n`, stderr: '' });

  /** A complete, valid review-ready evidence set under /w. */
  constructor() {
    this.dirs.add('/w/review');
    this.dirs.add('/w/review/x-r1');
    for (const name of ['range.txt', 'diff.patch', 'status.txt', 'record.md']) this.files.set(`/w/review/x-r1/${name}`, `${name}\n`);
    this.files.set('/w/review/x-r1/patch-id.txt', `${KEY}\n`);
    this.files.set('/w/gate.log', `START=1\nSELECTION=full\nGIT_TREE_START=${TREE}\nok\nGIT_TREE_END=${TREE}\nVERDICT=VALID\nSETTLED=yes\n`);
    this.files.set(PATCH_ID_PROGRAM, '#!/bin/sh\n');
    this.dirs.add('/w/receipts');
    this.files.set(`/w/receipts/${KEY}.md`, '# v2 review receipt\nverdict: PASS\n');
  }

  private resolve(p: string): string {
    return this.links.get(p) ?? p;
  }

  reader(): IEvidenceReader {
    return {
      realpath: async (p) => {
        const real = this.resolve(p);
        return this.files.has(real) || this.dirs.has(real) || this.others.has(real) ? real : null;
      },
      kind: async (p): Promise<TEntryKind | null> => {
        const real = this.resolve(p);
        if (this.files.has(real)) return 'file';
        if (this.dirs.has(real)) return 'dir';
        return this.others.has(real) ? 'other' : null;
      },
      readText: async (p, maxBytes) => {
        const text = this.files.get(this.resolve(p));
        if (text === undefined) throw new Error(`ENOENT ${p}`);
        const size = Buffer.byteLength(text, 'utf8');
        return size > maxBytes ? { tooLarge: size } : { text };
      },
      revParse: async (_repo, rev) => {
        if (rev.startsWith('refs/')) return this.refs.get(rev) ?? null;
        const commit = /^([0-9a-f]+)\^\{commit\}$/.exec(rev);
        if (commit) return this.commits.has(commit[1]) ? commit[1] : null;
        const tree = /^([0-9a-f]+)\^\{tree\}$/.exec(rev);
        return tree ? this.trees.get(tree[1]) ?? null : null;
      },
      isAncestor: async (_repo, a, b) => this.ancestors.has(`${a}..${b}`),
      run: async (argv, cwd) => {
        this.runs.push({ argv, cwd });
        return this.command(argv, cwd);
      },
    };
  }
}

export const range = { repo: REPO, branch: 'story/x-1', head: HEAD, base: BASE, attempt: 1 };
export const landedPayload = { ...range, key: KEY, gateLog: '/w/gate.log' };
export const reviewReadyPayload = {
  ...range, key: KEY, gateLog: '/w/gate.log', reviewDir: '/w/review/x-r1', receipt: `/w/receipts/${KEY}.md`,
};
