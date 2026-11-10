import { describe, it, expect, beforeEach } from 'vitest';
import { SignalEngine, matchesGlob, isInScope, normalizeScopePattern } from '@/lib/signal-engine';
import { parseClaudeToolActivity } from '@/lib/providers/claude/tool-activity';
import type { IAgentSignal } from '@/types/signals';

const CWD = '/repo';
const edit = (...paths: string[]) => ({
  tool: 'Edit',
  paths: paths.map((p) => `${CWD}/${p}`),
  failed: false,
});

describe('matchesGlob', () => {
  it('matches a literal path', () => {
    expect(matchesGlob('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/b.ts', 'src/a.ts')).toBe(false);
  });

  it('treats * as a single segment and ** as any depth', () => {
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('src/deep/a.ts', 'src/**')).toBe(true);
  });

  it('expands a trailing slash to the whole subtree', () => {
    expect(matchesGlob('src/deep/a.ts', 'src/')).toBe(true);
    expect(matchesGlob('other/a.ts', 'src/')).toBe(false);
  });

  it('does not let regex metacharacters in a pattern widen the match', () => {
    expect(matchesGlob('srcXa.ts', 'src.a.ts')).toBe(false);
    expect(matchesGlob('src.a.ts', 'src.a.ts')).toBe(true);
  });

  it('is false for an empty pattern rather than matching everything', () => {
    expect(matchesGlob('src/a.ts', '')).toBe(false);
    expect(isInScope('src/a.ts', [])).toBe(false);
  });
});

describe('SignalEngine off-scope', () => {
  let engine: SignalEngine;
  let signals: IAgentSignal[];

  beforeEach(() => {
    engine = new SignalEngine();
    signals = [];
    engine.setEmitter((s) => signals.push(s));
  });

  it('stays silent while edits are inside scope', () => {
    engine.record('t1', edit('src/a.ts'), ['src/**'], CWD);
    engine.record('t1', edit('src/b.ts'), ['src/**'], CWD);
    expect(signals).toHaveLength(0);
  });

  it('fires once two distinct files land outside scope', () => {
    engine.record('t1', edit('other/a.ts'), ['src/**'], CWD);
    expect(signals).toHaveLength(0);
    engine.record('t1', edit('other/b.ts'), ['src/**'], CWD);
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('off-scope');
    expect(signals[0].evidence).toContain('other/a.ts');
  });

  it('stays inert when the tab declares no scope', () => {
    engine.record('t1', edit('anywhere/a.ts'), undefined, CWD);
    engine.record('t1', edit('anywhere/b.ts'), undefined, CWD);
    expect(signals).toHaveLength(0);
  });

  it('ignores paths outside the tab cwd rather than counting them off-scope', () => {
    engine.record('t1', { tool: 'Edit', paths: ['/elsewhere/x.ts'], failed: false }, ['src/**'], CWD);
    engine.record('t1', { tool: 'Edit', paths: ['/elsewhere/y.ts'], failed: false }, ['src/**'], CWD);
    expect(signals).toHaveLength(0);
  });

  it('does not re-fire for the same tab inside the cooldown', () => {
    engine.record('t1', edit('other/a.ts'), ['src/**'], CWD);
    engine.record('t1', edit('other/b.ts'), ['src/**'], CWD);
    engine.record('t1', edit('other/c.ts'), ['src/**'], CWD);
    expect(signals).toHaveLength(1);
  });

  it('tracks tabs independently', () => {
    engine.record('t1', edit('other/a.ts'), ['src/**'], CWD);
    engine.record('t2', edit('other/a.ts'), ['src/**'], CWD);
    expect(signals).toHaveLength(0);
  });
});

describe('SignalEngine thrash', () => {
  let engine: SignalEngine;
  let signals: IAgentSignal[];
  const fail = { tool: 'Bash', paths: [], failed: true, commandKey: 'abc', commandPreview: 'pytest -x' };

  beforeEach(() => {
    engine = new SignalEngine();
    signals = [];
    engine.setEmitter((s) => signals.push(s));
  });

  it('fires on the third consecutive failure of the same command', () => {
    engine.record('t1', fail, undefined, CWD);
    engine.record('t1', fail, undefined, CWD);
    expect(signals).toHaveLength(0);
    engine.record('t1', fail, undefined, CWD);
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('thrash');
    expect(signals[0].evidence).toEqual(['pytest -x']);
  });

  it('resets the count when the same command succeeds', () => {
    engine.record('t1', fail, undefined, CWD);
    engine.record('t1', fail, undefined, CWD);
    engine.record('t1', { ...fail, failed: false }, undefined, CWD);
    engine.record('t1', fail, undefined, CWD);
    expect(signals).toHaveLength(0);
  });

  it('does not conflate different commands', () => {
    engine.record('t1', fail, undefined, CWD);
    engine.record('t1', { ...fail, commandKey: 'def' }, undefined, CWD);
    engine.record('t1', { ...fail, commandKey: 'ghi' }, undefined, CWD);
    expect(signals).toHaveLength(0);
  });
});

describe('parseClaudeToolActivity', () => {
  it('extracts the edited path', () => {
    const a = parseClaudeToolActivity({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' } });
    expect(a).toMatchObject({ tool: 'Edit', paths: ['/repo/src/a.ts'], failed: false });
  });

  it('collects every path from a multi-edit payload and de-duplicates', () => {
    const a = parseClaudeToolActivity({
      tool_name: 'MultiEdit',
      tool_input: { edits: [{ file_path: '/r/a.ts' }, { file_path: '/r/b.ts' }, { file_path: '/r/a.ts' }] },
    });
    expect(a?.paths).toEqual(['/r/a.ts', '/r/b.ts']);
  });

  it('hashes a command instead of retaining it, and normalizes whitespace', () => {
    const a = parseClaudeToolActivity({ tool_name: 'Bash', tool_input: { command: 'pytest   -x' } });
    const b = parseClaudeToolActivity({ tool_name: 'Bash', tool_input: { command: 'pytest -x' } });
    expect(a?.commandKey).toBe(b?.commandKey);
    expect(a?.commandKey).not.toContain('pytest');
  });

  it('reads failure from any of the shapes Claude uses', () => {
    expect(parseClaudeToolActivity({ tool_name: 'Bash', tool_response: { is_error: true } })?.failed).toBe(true);
    expect(parseClaudeToolActivity({ tool_name: 'Bash', tool_response: { exit_code: 1 } })?.failed).toBe(true);
    expect(parseClaudeToolActivity({ tool_name: 'Bash', tool_response: { exit_code: 0 } })?.failed).toBe(false);
    expect(parseClaudeToolActivity({ tool_name: 'Bash', tool_response: { interrupted: true } })?.failed).toBe(true);
  });

  it('returns null on a payload with no tool name rather than throwing', () => {
    expect(parseClaudeToolActivity({})).toBeNull();
    expect(parseClaudeToolActivity(null)).toBeNull();
    expect(parseClaudeToolActivity('nonsense')).toBeNull();
  });

  it('survives a malformed tool_input', () => {
    expect(parseClaudeToolActivity({ tool_name: 'Edit', tool_input: 'oops' })).toMatchObject({ paths: [] });
    expect(parseClaudeToolActivity({ tool_name: 'Edit', tool_input: { edits: 'oops' } })).toMatchObject({ paths: [] });
  });
});

describe('normalizeScopePattern / isInScope with real-world scopes', () => {
  it('reads an absolute scope path relative to the cwd', () => {
    expect(normalizeScopePattern('/repo/acme-ledger/.worktrees/story-01', '/repo')).toBe('acme-ledger/.worktrees/story-01/**');
    expect(isInScope('acme-ledger/.worktrees/story-01/src/a.ts', ['/repo/acme-ledger/.worktrees/story-01'], '/repo')).toBe(true);
    expect(isInScope('acme-ledger/.worktrees/story-02/src/a.ts', ['/repo/acme-ledger/.worktrees/story-01'], '/repo')).toBe(false);
  });

  it('treats a glob-free pattern as the directory and everything beneath it', () => {
    expect(isInScope('src/deep/a.ts', ['src'])).toBe(true);
    expect(isInScope('src', ['src'])).toBe(true);
    expect(isInScope('srcx/a.ts', ['src'])).toBe(false);
  });

  it('leaves an absolute pattern outside the cwd alone (no match, no crash)', () => {
    expect(isInScope('src/a.ts', ['/elsewhere/src'], '/repo')).toBe(false);
  });

  it('keeps explicit globs exactly as written', () => {
    expect(isInScope('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(isInScope('src/deep/a.ts', ['src/*.ts'])).toBe(false);
  });
});

describe('off-scope re-fire discipline', () => {
  let engine: SignalEngine;
  let fired: IAgentSignal[];
  beforeEach(() => {
    engine = new SignalEngine();
    fired = [];
    engine.setEmitter((s) => fired.push(s));
  });

  it('does not fire for edits inside an absolute worktree scope', () => {
    const scope = [`${CWD}/acme-ledger/.worktrees/story-01`];
    engine.record('t1', edit('acme-ledger/.worktrees/story-01/a.ts', 'acme-ledger/.worktrees/story-01/b.ts'), scope, CWD);
    engine.record('t1', edit('acme-ledger/.worktrees/story-01/c.ts'), scope, CWD);
    expect(fired).toHaveLength(0);
  });

  it('fires once for two off-scope edits and stays quiet until NEW off-scope edits accumulate', () => {
    const scope = ['src/'];
    engine.record('t1', edit('other/a.ts', 'other/b.ts'), scope, CWD);
    expect(fired).toHaveLength(1);
    // the same two files edited again, plus in-scope work: nothing new to report
    engine.record('t1', edit('other/a.ts'), scope, CWD);
    engine.record('t1', edit('src/ok.ts'), scope, CWD);
    expect(fired).toHaveLength(1);
  });
});
