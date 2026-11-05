import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Story 07: the isolated acceptance harness that gates every forward deploy (scripts/acceptance/).
// These tests pin its judgements and its safety rules with fakes; the end-to-end run against a real
// build is opt-in (ACCEPTANCE_E2E_CANDIDATE) because it needs a built candidate and ~90 s.

const ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = path.join(ROOT, 'scripts/acceptance/isolated-instance.sh');
const RUN = path.join(ROOT, 'scripts/acceptance/run.sh');
const checks = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks.cjs'));

// Next types NODE_ENV as required on ProcessEnv; a child's environment here is deliberately minimal.
const asEnv = (env: Record<string, string | undefined>) => env as NodeJS.ProcessEnv;

describe('checks.cjs judgements', () => {
  it('judgeNoteDelivery: only a stamped delivery whose notice line reached the composer, body absent, passes', () => {
    const note = { id: 'n-abcd1234', state: 'delivered', deliveredAt: 1790000000000 };
    const line = '\u001b[200~[purplemux note n-abcd1234] from ws-b at 10:00Z — purplemux note show n-abcd1234\u001b[201~\n';
    expect(checks.judgeNoteDelivery(note, line, 'BODY-1').ok).toBe(true);
    // Queued but not yet typed: `state: delivered` alone is what review r1 found the old check reading.
    expect(checks.judgeNoteDelivery({ ...note, deliveredAt: null }, line, 'BODY-1').ok).toBe(false);
    expect(checks.judgeNoteDelivery(note, '', 'BODY-1').ok).toBe(false);
    expect(checks.judgeNoteDelivery(note, '[purplemux note n-other123] …', 'BODY-1').ok).toBe(false);
    expect(checks.judgeNoteDelivery(note, `${line}BODY-1\n`, 'BODY-1')).toMatchObject({ ok: false, measured: expect.stringContaining('body typed true') });
    expect(checks.judgeNoteDelivery(null, line, 'BODY-1').ok).toBe(false);
  });

  it('judgeRace: exactly one winner and one refusal that names the winner', () => {
    const win = { rc: 0, out: '', err: '' };
    const lose = { rc: 3, out: '', err: 'error: lease-held — merge:x/y held by ws-a / tab-A1 (acc-a1)' };
    expect(checks.judgeRace(win, lose, 'tab-A1', 'tab-B1')).toEqual({ ok: true, winnerId: 'tab-A1', loserId: 'tab-B1' });
    expect(checks.judgeRace({ ...lose, err: 'held by tab-B1' }, win, 'tab-A1', 'tab-B1')).toEqual({ ok: true, winnerId: 'tab-B1', loserId: 'tab-A1' });
  });

  it('judgeRace fails two winners, two refusals, and a refusal that does not name the holder', () => {
    const win = { rc: 0, out: '', err: '' };
    expect(checks.judgeRace(win, win, 'a', 'b').ok).toBe(false);
    expect(checks.judgeRace({ rc: 3, out: '', err: '' }, { rc: 3, out: '', err: '' }, 'a', 'b').ok).toBe(false);
    const anonymous = checks.judgeRace(win, { rc: 3, out: '', err: 'error: lease-held' }, 'tab-A1', 'tab-B1');
    expect(anonymous.ok).toBe(false);
    expect(anonymous.measured).toContain('does not name tab-A1');
  });

  it('summarize: one line per result, and the verdict is PASS only with no failure', () => {
    const results = [
      { status: 'pass', id: 'a', what: 'first' },
      { status: 'skip', id: 'bash-guard', why: 'no path' },
    ];
    const { lines, pass } = checks.summarize(results);
    expect(lines).toEqual(['PASS a — first', 'SKIP bash-guard — no path', 'ACCEPTANCE=PASS checks=2 passed=1 failed=0 skipped=1']);
    expect(pass).toBe(true);
    const failed = checks.summarize([...results, { status: 'fail', id: 'b', what: 'w', measured: 'm', expected: 'e' }]);
    expect(failed.lines).toContain('FAIL b — w — measured: m — expected: e');
    expect(failed.pass).toBe(false);
  });

  it('summarize: a skipped bash-guard check fails when it is required, and an empty run never passes', () => {
    const skipped = [{ status: 'skip', id: 'bash-guard', why: 'no path' }];
    expect(checks.summarize(skipped, { requireBashGuard: true }).pass).toBe(false);
    expect(checks.summarize([]).pass).toBe(false);
  });

  it('shellQuote leaves plain words alone and quotes the rest, including single quotes', () => {
    expect(checks.shellQuote('/usr/bin/node')).toBe('/usr/bin/node');
    expect(checks.shellQuote('merge:acc/race-1')).toBe('merge:acc/race-1');
    expect(checks.shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(checks.shellQuote('a b')).toBe(`'a b'`);
  });

  it('retains the actual live designated fixture, checks other closes, preserves its mapping, and permits a later agent create', async () => {
    const mapping = { enabled: true, orchestratorTabId: 'reader', revision: 9 };
    const closed: string[] = [];
    const inst = {
      cli: vi.fn(async (args: string[]) => {
        if (args[0] === 'orchestration') return { rc: 0, out: JSON.stringify({ orchestration: mapping }), err: '' };
        if (args[0] === 'tab' && args[1] === 'close') {
          closed.push(args[4]);
          return { rc: 0, out: 'ok\n', err: '' };
        }
        if (args[0] === 'tab' && args[1] === 'create') return { rc: 0, out: JSON.stringify({ tabId: 'next-agent' }), err: '' };
        throw new Error(`unexpected command ${args.join(' ')}`);
      }),
      fixtureAgentState: vi.fn(async () => ({
        ok: true,
        result: { rc: 0, out: '{}', err: '' },
        status: { alive: true, command: 'claude', agentSessionId: 'session-reader' },
      })),
    };
    const kept = await checks.retainDesignatedFixture(inst, 'ws-a', [
      { tabId: 'old-orch' }, { tabId: 'reader' }, { tabId: 'worker' },
    ]);
    const created = await inst.cli(['tab', 'create', '-w', 'ws-a', '-n', 'next', '-t', 'claude-code']);
    expect(kept.ok).toBe(true);
    expect(kept.retained).toBe('reader');
    expect(closed).toEqual(['old-orch', 'worker']);
    expect(inst.fixtureAgentState).toHaveBeenCalledTimes(2);
    expect(created).toMatchObject({ rc: 0, out: expect.stringContaining('next-agent') });
    expect(mapping).toEqual({ enabled: true, orchestratorTabId: 'reader', revision: 9 });
  });

  it('does not close anything when designated fixture mapping or liveness is unknown', async () => {
    const close = vi.fn();
    const unknownMapping = {
      cli: vi.fn(async (args: string[]) => {
        if (args[0] === 'tab' && args[1] === 'close') close();
        return { rc: 0, out: JSON.stringify({ orchestration: { enabled: true, orchestratorTabId: 'outside', revision: 1 } }), err: '' };
      }),
      fixtureAgentState: vi.fn(),
    };
    expect((await checks.retainDesignatedFixture(unknownMapping, 'ws-a', [{ tabId: 'fixture' }])).ok).toBe(false);
    expect(close).not.toHaveBeenCalled();

    const unknownLive = {
      cli: vi.fn(async () => ({ rc: 0, out: JSON.stringify({ orchestration: { enabled: true, orchestratorTabId: 'fixture', revision: 1 } }), err: '' })),
      fixtureAgentState: vi.fn(async () => ({ ok: false, result: { rc: 1, out: '', err: 'unknown' }, status: null })),
    };
    expect((await checks.retainDesignatedFixture(unknownLive, 'ws-a', [{ tabId: 'fixture' }])).ok).toBe(false);
    expect(unknownLive.cli).toHaveBeenCalledTimes(1);
  });

  it('requires a fresh bound non-zombie foreground Claude descendant, rejecting shell-only and stale identities', () => {
    const expected = { sessionId: 'session-live', pid: 42, startedAt: 1000, startTicks: 700 };
    const base = {
      result: { rc: 0, out: '{}', err: '' },
      status: { alive: true, command: 'claude', agentProviderId: 'claude', agentSessionId: 'session-live' },
      panePid: 20,
      pane: { pid: 20, state: 'S', ppid: 1, pgrp: 20, tpgid: 42, startTicks: 500, argv0: 'bash' },
      record: { pid: 42, sessionId: 'session-live', startedAt: 1000 },
      process: { pid: 42, state: 'S', ppid: 20, pgrp: 42, tpgid: 42, startTicks: 700, argv0: 'claude' },
      expected,
      descendant: true,
    };
    expect(checks.assessFixtureAgent(base)).toMatchObject({ ok: true, identity: expected });
    expect(checks.assessFixtureAgent({ ...base, status: { ...base.status, command: 'bash' } }).ok).toBe(false);
    expect(checks.assessFixtureAgent({ ...base, process: { ...base.process, startTicks: 701 } }).ok).toBe(false);
    expect(checks.assessFixtureAgent({ ...base, process: { ...base.process, state: 'Z' } }).ok).toBe(false);
    expect(checks.assessFixtureAgent({ ...base, status: { ...base.status, agentSessionId: 'stale-session' } }).ok).toBe(false);
    expect(checks.assessFixtureAgent({ ...base, descendant: false }).ok).toBe(false);
  });

  it('separates physical identity from the later status binding without weakening the final predicate', () => {
    const observed = checks.assessFixtureAgent({
      result: { rc: 0, out: '{}', err: '' },
      status: { alive: true, command: 'bash', agentProviderId: null, agentSessionId: null },
      panePid: 20,
      pane: { pid: 20, state: 'S', ppid: 1, pgrp: 20, tpgid: 42, startTicks: 500, argv0: 'bash' },
      record: { pid: 42, sessionId: 'session-live', startedAt: 1000 },
      process: { pid: 42, state: 'S', ppid: 20, pgrp: 42, tpgid: 42, startTicks: 700, argv0: 'claude' },
      expected: { sessionId: 'session-live', launchedAfter: 1000 },
      descendant: true,
    });
    expect(observed.ok).toBe(false);
    expect(observed.facts.failedPredicates).toEqual(expect.arrayContaining(['command', 'provider', 'bound']));
    expect(checks.fixturePhysicalObservation(observed)).toMatchObject({
      ok: true,
      facts: { physicalFailedPredicates: [] },
    });
  });

  it('requires a readable foreground shell before an isolated helper may submit input', () => {
    const base = {
      result: { rc: 0, out: 'bash\n', err: '' },
      command: 'bash',
      panePid: 20,
      process: { pid: 20, state: 'S', ppid: 1, pgrp: 20, tpgid: 20, startTicks: 500, argv0: 'bash' },
    };
    expect(checks.assessShellControl(base)).toMatchObject({ ok: true, failedPredicates: [] });
    expect(checks.assessShellControl({ ...base, command: 'claude' })).toMatchObject({ ok: false, failedPredicates: ['shellCommand'] });
    expect(checks.assessShellControl({ ...base, process: { ...base.process, tpgid: 42 } })).toMatchObject({ ok: false, failedPredicates: ['foreground'] });
  });

  it('writes a terminal receipt when Ctrl-C ends the foreground fixture command', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-receipt-'));
    const receipt = path.join(scratch, 'command.rc');
    const inst = new checks.Instance({
      scratch,
      home: path.join(scratch, 'home'),
      tmuxTmpdir: path.join(scratch, 'tmux'),
      candidate: ROOT,
      node: process.execPath,
      workspaces: { a: 'ws-a', b: 'ws-b' },
    });
    const child = spawn(inst.fixtureCommandWrapper(), [receipt, 'sleep 300'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(-child.pid!, 'SIGINT');
      await new Promise((resolve) => child.once('exit', resolve));
      expect(fs.readFileSync(receipt, 'utf8')).toBe('130\n');
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('reports incomplete prerequisite results as failures without throwing or converting them to success', () => {
    expect(checks.completeResult({ rc: -1 }, 'prerequisite missing')).toEqual({
      rc: -1,
      out: '',
      err: 'prerequisite missing',
    });
    expect(checks.brief({ rc: -1 })).toBe('exit -1, stderr: incomplete operation result');
    const results = [{ status: 'fail', id: 'first' }];
    checks.appendTargetedPrerequisiteFailures(results, ['second', 'third'], 'fresh binding failed');
    expect(results).toEqual([
      { status: 'fail', id: 'first' },
      {
        status: 'fail',
        id: 'second',
        what: 'targeted fixture prerequisite is complete before dependent operations run',
        measured: 'fresh binding failed',
        expected: 'all prior targeted fixture prerequisites pass',
      },
      {
        status: 'fail',
        id: 'third',
        what: 'targeted fixture prerequisite is complete before dependent operations run',
        measured: 'fresh binding failed',
        expected: 'all prior targeted fixture prerequisites pass',
      },
    ]);
    expect(results.every((result) => result.status === 'fail')).toBe(true);
  });

  it('returns the last observed facts when a bounded observation times out', async () => {
    const observations = [{ ok: false, seq: 1 }, { ok: false, seq: 2 }];
    const last = await checks.pollObservation(150, async () => observations.shift());
    expect(last).toEqual({ ok: false, seq: 2 });
  });

  it('revives only the same designated fixture before cleanup and rejects a changed mapping or failed close', async () => {
    let mapping = { enabled: true, orchestratorTabId: 'reader', revision: 3 };
    let observations = 0;
    const inst = {
      cli: vi.fn(async (args: string[]) => {
        if (args[0] === 'orchestration') return { rc: 0, out: JSON.stringify({ orchestration: mapping }), err: '' };
        if (args[0] === 'tab' && args[1] === 'close') return { rc: 1, out: 'close-not-confirmed\n', err: '' };
        throw new Error(`unexpected command ${args.join(' ')}`);
      }),
      fixtureAgentState: vi.fn(async () => {
        observations += 1;
        const ok = observations > 1;
        return { ok, result: { rc: 0, out: '{}', err: '' }, status: { alive: true, command: ok ? 'claude' : 'bash', agentSessionId: 'session-reader' } };
      }),
    };
    const restore = vi.fn(async (tab: { tabId: string }) => {
      expect(tab.tabId).toBe('reader');
      return { rc: 0, out: '', err: '' };
    });
    const failedClose = await checks.retainDesignatedFixture(inst, 'ws-a', [{ tabId: 'reader' }, { tabId: 'other' }], { restore });
    expect(restore).toHaveBeenCalledOnce();
    expect(failedClose.ok).toBe(false);

    observations = 2;
    inst.cli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'orchestration') {
        const result = { rc: 0, out: JSON.stringify({ orchestration: mapping }), err: '' };
        mapping = { ...mapping, revision: mapping.revision + 1 };
        return result;
      }
      if (args[0] === 'tab' && args[1] === 'close') return { rc: 0, out: 'ok\n', err: '' };
      throw new Error(`unexpected command ${args.join(' ')}`);
    });
    expect((await checks.retainDesignatedFixture(inst, 'ws-a', [{ tabId: 'reader' }, { tabId: 'other' }])).ok).toBe(false);
  });

  it('parseArgs requires a state file and rejects unknown flags', () => {
    expect(checks.parseArgs(['--state', 's.json', '--bash-guard', 'g.py', '--require-bash-guard'])).toEqual({
      state: 's.json',
      bashGuard: 'g.py',
      requireBashGuard: true,
      onlyWave: null,
      targetedFixture: false,
      evidenceDir: null,
    });
    // Debugging one wave against a kept instance (story 39); run.sh never passes it.
    expect(checks.parseArgs(['--state', 's.json', '--only-wave', '4']).onlyWave).toBe(4);
    expect(checks.parseArgs(['--state', 's.json', '--targeted-fixture', '--evidence-dir', '/tmp/evidence'])).toMatchObject({
      targetedFixture: true,
      evidenceDir: '/tmp/evidence',
    });
    expect(() => checks.parseArgs(['--state', 's.json', '--only-wave', '4', '--targeted-fixture'])).toThrow(/mutually exclusive/);
    expect(() => checks.parseArgs([])).toThrow(/usage/);
    expect(() => checks.parseArgs(['--state', 's', '--nope'])).toThrow(/unknown argument/);
  });

  it('refuses a state file that is not an isolated-instance state, with exit 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-state-'));
    fs.writeFileSync(path.join(dir, 's.json'), '{"home":"/home/x"}');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/acceptance/checks.cjs'), '--state', path.join(dir, 's.json')], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED STATE');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('checks-wave4.cjs fixtures (story 39)', () => {
  const wave4 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-wave4.cjs'));
  const ledgerOf = async (main: unknown[], subagents: unknown[][]) => {
    const { applyBackgroundLine, createBackgroundLedger, mergeLedgers, openBackgroundTasks } = await import('@/lib/providers/claude/background-ledger');
    const parts = [main, ...subagents].map((entries, i) => {
      const ledger = createBackgroundLedger();
      for (const e of entries) applyBackgroundLine(ledger, JSON.stringify(e), i === 0 ? 'main' : 'subagent');
      return ledger;
    });
    return openBackgroundTasks(mergeLedgers(parts), Date.now() + 3_600_000).map((t) => `${t.kind}:${t.id}`);
  };

  it('the subagent-shell fixture reads as one open shell until its completion (what the live check asserts)', async () => {
    const t0 = Date.now();
    const main = [wave4.userLine(t0, 'go'), wave4.asyncAgentLaunch(t0 + 1000, 'aS'), wave4.queuedCompletion(t0 + 20000, 'aS', 'done'), wave4.assistantEnd(t0 + 21000, 'x')];
    const sub = [wave4.subagentMovedShell(t0 + 19000, 'aS', 'bS')];
    expect(await ledgerOf(main, [sub])).toEqual(['shell:bS']);
    expect(await ledgerOf([...main, wave4.queuedCompletion(t0 + 40000, 'bS', 'done')], [sub])).toEqual([]);
  });

  it('the woken-agent fixture reads as one open agent until its second completion', async () => {
    const t0 = Date.now();
    const main = [wave4.userLine(t0, 'go'), wave4.asyncAgentLaunch(t0 + 1000, 'aW'), wave4.queuedCompletion(t0 + 10000, 'aW', 'done'), wave4.assistantEnd(t0 + 30000, 'x')];
    const sub = [wave4.subagentMovedShell(t0 + 5000, 'aW', 'bW'), wave4.subagentDelivery(t0 + 25000, 'aW', 'bW')];
    expect(await ledgerOf(main, [sub])).toEqual(['agent:aW']);
    expect(await ledgerOf([...main, wave4.queuedCompletion(t0 + 40000, 'aW', 'done')], [sub])).toEqual([]);
  });

  it('the live stand-in writes Claude\'s session pid file and execs as `claude` with its environment kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-w4-'));
    try {
      const file = wave4.liveStandIn(dir);
      const text = fs.readFileSync(file, 'utf-8');
      expect(text.startsWith('#!/bin/bash\n')).toBe(true);
      expect(text).toContain('d="$HOME/.claude/sessions"');
      expect(text).toContain('"startedAt":%s');
      // Milliseconds on any `date` (uutils printed nanoseconds for %3N and the process start filter dropped every task).
      expect(text).toContain('$(( $(date +%s%N) / 1000000 ))');
      expect(text).toContain('exec -a claude cat >> "${ACC_INPUT:-/dev/null}"');
      expect(text).not.toContain('perl');
      expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the live stand-in, run: a millisecond start in its pid file, the piped line appended, HOME kept, argv[0] claude (review r2 N3)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-w4-run-'));
    const home = path.join(dir, 'home');
    const input = path.join(dir, 'input.txt');
    const uuid = '11111111-2222-4333-8444-555555555555';
    try {
      fs.mkdirSync(home);
      const script = wave4.liveStandIn(dir);
      const before = Date.now();
      const child = spawn(script, ['--resume', uuid], { cwd: dir, env: asEnv({ PATH: '/usr/bin:/bin', HOME: home, ACC_INPUT: input }), stdio: ['pipe', 'ignore', 'ignore'] });
      let startedAt: number | null = null;
      for (let i = 0; i < 100 && startedAt === null; i++) {
        startedAt = wave4.standInStart(home, uuid);
        if (startedAt === null) await new Promise((r) => setTimeout(r, 50));
      }
      const after = Date.now();
      expect(startedAt).not.toBeNull();
      expect(startedAt!).toBeGreaterThanOrEqual(before - 1000);
      expect(startedAt!).toBeLessThanOrEqual(after + 1000);
      if (fs.existsSync(`/proc/${child.pid}/environ`)) {
        // After the exec: argv[0] claude, HOME still in the environment (teardown sweeps by HOME).
        for (let i = 0; i < 40 && !fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').startsWith('claude'); i++) await new Promise((r) => setTimeout(r, 50));
        expect(fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')[0]).toBe('claude');
        expect(fs.readFileSync(`/proc/${child.pid}/environ`, 'utf8').split('\0')).toContain(`HOME=${home}`);
        expect(wave4.standInRecord(home, uuid)).toMatchObject({ pid: child.pid, sessionId: uuid, startedAt });
        expect(checks.processIdentity(child.pid)).toMatchObject({ pid: child.pid, state: expect.not.stringMatching(/^Z$/), argv0: 'claude' });
        expect(checks.processDescendsFrom(child.pid, process.pid)).toBe(true);
      }
      child.stdin!.write('typed line\n');
      child.stdin!.end();
      await new Promise((r) => child.on('exit', r));
      expect(fs.readFileSync(input, 'utf8')).toBe('typed line\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('judgeMissionTyped: only the whole input being the one fixed notice line for this workspace passes', () => {
    const line = '[purplemux mission boot-4f7e4283b1df7a108ab484805afec717] Mission Control asks this orchestrator to reconcile — read: purplemux mission bootstrap -w ws-5wqnrB';
    expect(wave4.judgeMissionTyped(`${line}\n`, 'ws-5wqnrB').ok).toBe(true);
    expect(wave4.judgeMissionTyped(`\u001b[200~${line}\u001b[201~\n`, 'ws-5wqnrB').ok).toBe(true);
    // Review r1: the multi-line prompt story 12 removed, typed around the notice, must fail.
    expect(wave4.judgeMissionTyped(`Reconcile Mission Control:\n1. read the snapshot\n${line}\n`, 'ws-5wqnrB')).toMatchObject({ ok: false, measured: expect.stringContaining('3 non-empty line(s)') });
    expect(wave4.judgeMissionTyped(`${line}\n${line}\n`, 'ws-5wqnrB').ok).toBe(false);
    expect(wave4.judgeMissionTyped(`${line}\n`, 'ws-OTHER').ok).toBe(false);
    expect(wave4.judgeMissionTyped('', 'ws-5wqnrB').ok).toBe(false);
  });

  it('judgeMissionRebind: passes only a run moved to the successor at generation 2 with one replace audit event', () => {
    const boundTo = (tabId: string, generation: number) => ({ tabId, providerId: 'claude', sessionId: `session-${tabId}`, generation, runtimeGeneration: null });
    const ok = { rc: 0, out: '', err: '' };
    const base = {
      started: ok, bound: 'session-next', replaced: ok, restored: ok, asked: ok,
      rebound: { revision: 2, binding: boundTo('tab-next', 2) },
      audit: [{ revision: 2, payload: { cause: 'replace', previousBinding: boundTo('tab-orch', 1), binding: boundTo('tab-next', 2) } }],
      listed: { runId: 'run-a', tabId: 'tab-next', bindingGeneration: 2 },
      stale: { rc: 3, out: '', err: 'error: conflict (refused) — stale or unbound orchestrator generation' },
      item: { state: 'open' },
      finished: { state: 'completed', binding: boundTo('tab-next', 2) },
      orchTabId: 'tab-orch', nextTabId: 'tab-next',
    };
    expect(wave4.judgeMissionRebind(base)).toMatchObject({ ok: true });
    for (const rejected of [
      { rebound: null },
      { rebound: { revision: 1, binding: boundTo('tab-orch', 1) } },
      { rebound: { revision: 3, binding: boundTo('tab-next', 3) } },
      { audit: [] },
      { audit: [...base.audit, ...base.audit] },
      { audit: [{ revision: 2, payload: { cause: 'heal', previousBinding: boundTo('tab-orch', 1), binding: boundTo('tab-next', 2) } }] },
      { audit: [{ revision: 2, payload: { cause: 'replace', previousBinding: boundTo('tab-other', 1), binding: boundTo('tab-next', 2) } }] },
      { listed: null },
      { listed: { runId: 'run-a', tabId: 'tab-next', bindingGeneration: 1 } },
      { stale: ok },
      { stale: { rc: 3, out: '', err: 'error: conflict (refused) — stale run revision' } },
      { asked: { rc: 3, out: '', err: 'human review requires a run bound to the configured orchestrator' } },
      { item: { state: 'candidate' } },
      { item: null },
      { finished: { state: 'completed', binding: boundTo('tab-orch', 3) } },
      { finished: { state: 'running', binding: boundTo('tab-next', 2) } },
      { started: { rc: 3, out: '', err: 'target agent binding is not live' } },
      { bound: null },
      { replaced: { rc: 1, out: '', err: 'changed' } },
      { restored: { rc: 1, out: '', err: 'changed' } },
    ]) {
      const judged = wave4.judgeMissionRebind({ ...base, ...rejected });
      expect(judged.ok, JSON.stringify(rejected)).toBe(false);
      expect(judged.measured).toContain('run binding');
    }
  });

  it('judgeSubagentWait: WAITING needs the control READY first, busy, no nudge, turnEnd waiting with the open count, then a READY stamped after the end', () => {
    const good = {
      controlReady: { kind: 'ready-for-review', at: 1 },
      early: { stopped: true, cliState: 'busy', nudges: [], turnEnd: { kind: 'waiting', openBackgroundTasks: 1 } },
      later: { kind: 'ready-for-review', at: 2000 },
      endedAt: 1000,
    };
    expect(wave4.judgeSubagentWait(good).ok).toBe(true);
    const bad = (over: Record<string, unknown>) => wave4.judgeSubagentWait({ ...good, ...over }).ok;
    expect(bad({ controlReady: null })).toBe(false);
    expect(bad({ early: { ...good.early, turnEnd: null } })).toBe(false);
    expect(bad({ early: { ...good.early, nudges: ['ready-for-review'] } })).toBe(false);
    expect(bad({ early: { ...good.early, cliState: 'ready-for-review' } })).toBe(false);
    // Two open: the pre-process orphan was counted, so the start filter did not run.
    expect(bad({ early: { ...good.early, turnEnd: { kind: 'waiting', openBackgroundTasks: 2 } } })).toBe(false);
    expect(bad({ early: { ...good.early, turnEnd: { kind: 'ready-for-review', transcript: false, openBackgroundTasks: 0 } } })).toBe(false);
    expect(bad({ later: null })).toBe(false);
    expect(bad({ later: { at: 999 } })).toBe(false);
  });
});

describe('checks-burndown.cjs fixture', () => {
  const wave6 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-burndown.cjs'));

  it('publishes a burndown the validator accepts, with more history rows than the store keeps', async () => {
    const { MAX_BURNDOWN_HISTORY, parseBurndownSnapshot } = await import('@/lib/burndown');
    const now = Date.now();
    const result = parseBurndownSnapshot(wave6.burndownFixture(now), now);
    expect(result.ok && result.droppedHistory).toBe(100);
    expect(result.ok && result.snapshot.history).toHaveLength(MAX_BURNDOWN_HISTORY);
  });
});

describe('checks-wip-cap.cjs (story 20)', () => {
  const wipCap = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-wip-cap.cjs'));
  const helpers = { parseJson: checks.parseJson, brief: checks.brief, nonce: 'n0' };
  const AGENT = new Set(['claude-code', 'codex-cli', 'grok-cli']);
  const CAP = String(wipCap.FIXTURE_CAP);
  const SCRATCH_PORT = 18123;
  let root = '';
  let scratchHome = '';
  let liveHome = '';
  const writePort = (home: string, port: string | number) => {
    fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), `${port}\n`);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-wip-cap-'));
    scratchHome = path.join(root, 'pmxa.abc123', 'home');
    liveHome = path.join(root, 'live');
    writePort(scratchHome, SCRATCH_PORT);
    writePort(liveHome, 8022);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The scratch server as the CLI sees it: the cap rule of src/lib/tab-cap.ts (1..200, default 8).
  const fakeFleet = (opts: { setRc?: (value: string) => number; unsetRc?: number; countCap?: number; home?: string; agents?: Record<string, number> } = {}) => {
    const fleet = { cap: null as string | null, tabs: {} as Record<string, { tabId: string; panelType: string }[]>, calls: [] as string[] };
    for (const ws of ['ws-a', 'ws-b']) {
      fleet.tabs[ws] = Array.from({ length: opts.agents?.[ws] ?? 0 }, (_, i) => ({ tabId: `${ws}-seed-${i}`, panelType: 'claude-code' }));
    }
    let next = 0;
    const capOf = () => {
      const n = fleet.cap === null ? NaN : Number(fleet.cap);
      if (fleet.cap === null) return { cap: 8, capSource: 'default' };
      return Number.isInteger(n) && n >= 1 && n <= 200 ? { cap: n, capSource: 'fleet-config' } : { cap: 8, capSource: 'default-invalid' };
    };
    const count = (ws: string) => fleet.tabs[ws].filter((t) => AGENT.has(t.panelType)).length;
    const cli = vi.fn(async (args: string[]) => {
      fleet.calls.push(args.join(' '));
      const ok = (out = 'ok\n') => ({ rc: 0, out, err: '' });
      if (args[0] === 'config' && args[1] === 'set') {
        const rc = opts.setRc?.(args[3]) ?? 0;
        if (rc !== 0) return { rc, out: '', err: 'error: forbidden — not the admin' };
        fleet.cap = args[3];
        return ok();
      }
      if (args[0] === 'config' && args[1] === 'unset') {
        if (opts.unsetRc) return { rc: opts.unsetRc, out: '', err: 'error: config-not-found' };
        fleet.cap = null;
        return ok();
      }
      if (args[0] === 'tab' && args[1] === 'count') {
        const ws = args[3];
        const { cap, capSource } = capOf();
        return ok(JSON.stringify({ workspaceId: ws, count: count(ws), cap: opts.countCap ?? cap, capSource, overCap: count(ws) > cap }));
      }
      if (args[0] === 'tab' && args[1] === 'create') {
        const ws = args[3];
        const type = args[args.indexOf('-t') + 1];
        const { cap } = capOf();
        if (AGENT.has(type) && count(ws) >= cap) {
          return { rc: 3, out: '', err: `error: wip-cap (refused by state — close an agent tab first) — ${ws} holds ${count(ws)} of ${cap} agent tabs\n` };
        }
        const tab = { tabId: `tab-${next++}`, panelType: type };
        fleet.tabs[ws].push(tab);
        return ok(JSON.stringify({ ...tab, workspaceId: ws, sessionName: `pt-${ws}-p-${tab.tabId}` }));
      }
      if (args[0] === 'tab' && args[1] === 'close') {
        const ws = args[3];
        fleet.tabs[ws] = fleet.tabs[ws].filter((t) => t.tabId !== args[4]);
        return ok();
      }
      throw new Error(`unexpected command ${args.join(' ')}`);
    });
    const inst = { cli, state: { home: opts.home ?? scratchHome, port: SCRATCH_PORT, workspaces: { a: 'ws-a', b: 'ws-b' } } };
    return { fleet, inst };
  };
  const overCreate = (args: string[]) => args[0] === 'tab' && args[1] === 'create' && args[5].startsWith('acc-cap-over');

  it('the fixture cap is a value the server reads from fleet config', async () => {
    vi.doMock('@/lib/logger', () => ({ createLogger: () => ({ info: () => {}, warn: () => {} }) }));
    const { parseTabCap } = await import('@/lib/tab-cap');
    expect(parseTabCap(CAP)).toEqual({ cap: wipCap.FIXTURE_CAP, capSource: 'fleet-config', reason: null });
    vi.doUnmock('@/lib/logger');
  });

  it('sets the scratch cap and reads it back from both workspaces', async () => {
    const { fleet, inst } = fakeFleet();
    expect(await wipCap.setFixtureCap(inst, helpers, liveHome)).toMatchObject({ ok: true });
    expect(fleet.cap).toBe(CAP);
    expect(fleet.calls).toEqual([`config set tabs.cap-per-workspace ${CAP}`, 'tab count -w ws-a --json', 'tab count -w ws-b --json']);
  });

  it.each([
    ['the live HOME itself', () => liveHome, 'resolves to the live HOME'],
    ['a symlink to the live HOME', () => {
      const link = path.join(root, 'link-home');
      fs.symlinkSync(liveHome, link);
      return link;
    }, 'resolves to the live HOME'],
    ['a HOME whose .purplemux links to the live one', () => {
      const home = path.join(root, 'linked-purplemux');
      fs.mkdirSync(home);
      fs.symlinkSync(path.join(liveHome, '.purplemux'), path.join(home, '.purplemux'));
      return home;
    }, '/.purplemux resolves to the live'],
  ])('refuses %s and touches nothing', async (_name, home, reason) => {
    const { fleet, inst } = fakeFleet({ home: home() });
    const set = await wipCap.setFixtureCap(inst, helpers, liveHome);
    expect(set).toMatchObject({ ok: false, measured: expect.stringContaining(reason) });
    expect(fleet.calls).toEqual([]);
  });

  it.each([
    ['no port file', () => fs.rmSync(path.join(scratchHome, '.purplemux', 'port')), 'reads nothing'],
    ['a port other than the state port', () => writePort(scratchHome, 18124), 'reads 18124'],
    ['the live port', () => {
      writePort(scratchHome, 8022);
      return 8022;
    }, 'the live port'],
  ])('refuses a scratch HOME with %s and touches nothing', async (_name, arrange, reason) => {
    const statePort = arrange();
    const { fleet, inst } = fakeFleet();
    if (typeof statePort === 'number') inst.state.port = statePort;
    const set = await wipCap.setFixtureCap(inst, helpers, liveHome);
    expect(set).toMatchObject({ ok: false, measured: expect.stringContaining(reason) });
    expect(fleet.calls).toEqual([]);
  });

  it('a .purplemux missing on the live side is not the same directory', () => {
    fs.rmSync(path.join(liveHome, '.purplemux'), { recursive: true });
    expect(wipCap.scratchHomeProblem({ home: scratchHome, port: SCRATCH_PORT }, liveHome)).toBeNull();
  });

  it('fails the setup on a refused set or a read-back that does not show the value from fleet config', async () => {
    const refused = fakeFleet({ setRc: () => 3 });
    expect(await wipCap.setFixtureCap(refused.inst, helpers, liveHome))
      .toMatchObject({ ok: false, measured: expect.stringContaining('exit 3'), expected: expect.stringContaining(`cap ${CAP} from fleet-config`) });
    const wrongCap = fakeFleet({ countCap: 8 });
    expect((await wipCap.setFixtureCap(wrongCap.inst, helpers, liveHome)).ok).toBe(false);
  });

  it('the gate stops the run with one loud failure when the setup fails', async () => {
    const { inst } = fakeFleet({ setRc: () => 1 });
    const gate = await wipCap.fixtureCapGate(inst, helpers, { liveHome });
    expect(gate.proceed).toBe(false);
    expect(gate.results).toEqual([expect.objectContaining({ status: 'fail', id: 'fixture-cap', gate: true, what: expect.stringContaining('no check ran') })]);
  });

  it('SC-2: a create at the cap exits 3 wip-cap with the count and the cap, and the scratch cap is left as found', async () => {
    const { fleet, inst } = fakeFleet();
    const gate = await wipCap.fixtureCapGate(inst, helpers, { liveHome });
    expect(gate.proceed).toBe(true);
    expect(gate.results.map((r: { status: string; id: string; gate: boolean }) => `${r.status} ${r.id} ${r.gate}`))
      .toEqual(['pass fixture-cap true', 'pass wip-cap-refusal true']);
    expect(fleet.cap).toBe(CAP);
    expect(fleet.tabs['ws-a']).toEqual([]);
    expect(fleet.calls).toContain('config set tabs.cap-per-workspace 1');
  });

  it('SC-2 lowers the cap to the count it finds, and restores an unset cap by unsetting it', async () => {
    const { fleet, inst } = fakeFleet({ agents: { 'ws-a': 2 } });
    const refusal = await wipCap.wipCapRefusal(inst, helpers);
    expect(refusal).toMatchObject({ restored: true, result: { status: 'pass', id: 'wip-cap-refusal' } });
    expect(fleet.calls.indexOf('config unset tabs.cap-per-workspace')).toBeGreaterThan(fleet.calls.indexOf('config set tabs.cap-per-workspace 3'));
    expect(fleet.cap).toBeNull();
    expect(fleet.tabs['ws-a'].map((t) => t.tabId)).toEqual(['ws-a-seed-0', 'ws-a-seed-1']);
  });

  it('SC-2 accepts an unset that exits 7 when the read-back shows the default cap, and fails any other unset', async () => {
    const notFound = fakeFleet({ unsetRc: 7 });
    const real = notFound.inst.cli.getMockImplementation()!;
    notFound.inst.cli.mockImplementation(async (args: string[]) => {
      const result = await real(args);
      if (args[0] === 'config' && args[1] === 'unset') notFound.fleet.cap = null;
      return result;
    });
    expect(await wipCap.wipCapRefusal(notFound.inst, helpers)).toMatchObject({ restored: true, result: { status: 'pass' } });
    // Exit 7 that leaves the lowered cap in place, and any other exit, are not a restore.
    const left = fakeFleet({ unsetRc: 7 });
    expect(await wipCap.wipCapRefusal(left.inst, helpers)).toMatchObject({ restored: false, result: { status: 'fail' } });
    const broken = fakeFleet({ unsetRc: 3 });
    expect((await wipCap.wipCapRefusal(broken.inst, helpers)).restored).toBe(false);
  });

  it('SC-2 fails, and closes the tab, when the create at the cap is not refused', async () => {
    const { fleet, inst } = fakeFleet();
    fleet.cap = CAP;
    const real = inst.cli.getMockImplementation()!;
    inst.cli.mockImplementation(async (args: string[]) => {
      if (overCreate(args)) {
        fleet.calls.push(args.join(' '));
        fleet.tabs['ws-a'].push({ tabId: 'tab-leak', panelType: 'claude-code' });
        return { rc: 0, out: JSON.stringify({ tabId: 'tab-leak' }), err: '' };
      }
      return real(args);
    });
    const refusal = await wipCap.wipCapRefusal(inst, helpers);
    expect(refusal.result).toMatchObject({ status: 'fail', id: 'wip-cap-refusal', expected: expect.stringContaining('exits 3'), measured: expect.stringContaining('made tab-leak') });
    expect(refusal.restored).toBe(true);
    expect(fleet.tabs['ws-a']).toEqual([]);
  });

  it.each([
    ['names no count', 'error: wip-cap\n'],
    ['names another workspace', 'error: wip-cap (refused by state) — ws-b holds 1 of 1 agent tabs\n'],
    ['names a different count', 'error: wip-cap (refused by state) — ws-a holds 2 of 1 agent tabs\n'],
    ['is not the whole line', 'error: wip-cap (refused by state) — ws-a holds 1 of 1 agent tabs today\n'],
    ['is another code', 'error: forbidden (refused) — ws-a holds 1 of 1 agent tabs\n'],
  ])('SC-2 fails a refusal that %s', async (_name, err) => {
    const { fleet, inst } = fakeFleet();
    fleet.cap = CAP;
    const real = inst.cli.getMockImplementation()!;
    inst.cli.mockImplementation(async (args: string[]) => (overCreate(args) ? { rc: 3, out: '', err } : real(args)));
    const refusal = await wipCap.wipCapRefusal(inst, helpers);
    expect(refusal.result).toMatchObject({ status: 'fail', measured: expect.stringContaining(err.trim().split('\n')[0].slice(0, 40)) });
  });

  it('matches the refusal line the CLI printed in the measured run', () => {
    const line = "error: wip-cap (refused by state — close an agent tab first; only the workspace's orchestrator may pass --over-cap --reason) — ws-ZnzDut holds 8 of 8 agent tabs";
    expect(wipCap.refusalLine('ws-ZnzDut', 8).test(`${line}\n`)).toBe(true);
    expect(wipCap.refusalLine('ws-Znz.ut', 8).test(line)).toBe(false);
  });

  it('a cap that cannot be restored stops every later check', async () => {
    const { inst } = fakeFleet({ setRc: (value) => (value === CAP && inst.cli.mock.calls.length > 3 ? 1 : 0) });
    const gate = await wipCap.fixtureCapGate(inst, helpers, { liveHome });
    expect(gate.proceed).toBe(false);
    expect(gate.results.map((r: { status: string; id: string }) => `${r.status} ${r.id}`))
      .toEqual(['pass fixture-cap', 'fail wip-cap-refusal', 'fail fixture-cap-restore']);
  });

  it('SC-2 touches nothing when the cap it finds cannot be restored exactly', async () => {
    const { fleet, inst } = fakeFleet();
    fleet.cap = 'many';
    const refusal = await wipCap.wipCapRefusal(inst, helpers);
    expect(refusal).toMatchObject({ restored: true, result: { status: 'fail' } });
    expect(fleet.calls).toEqual(['tab count -w ws-a --json']);
  });

  it('summarize: gate results alone never pass a run', () => {
    expect(checks.summarize([{ status: 'pass', id: 'fixture-cap', what: 'w', gate: true }]).pass).toBe(false);
    expect(checks.summarize([{ status: 'pass', id: 'fixture-cap', what: 'w', gate: true }, { status: 'pass', id: 'tab-create', what: 'w' }]).pass).toBe(true);
  });

  it('parseArgs accepts --only-wave 1..WAVE_COUNT only, naming the range', () => {
    expect(checks.WAVE_COUNT).toBe(15);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '1']).onlyWave).toBe(1);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '9']).onlyWave).toBe(9);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '10']).onlyWave).toBe(10);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '11']).onlyWave).toBe(11);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '12']).onlyWave).toBe(12);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '13']).onlyWave).toBe(13);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '14']).onlyWave).toBe(14);
    expect(checks.parseArgs(['--state', 's', '--only-wave', '15']).onlyWave).toBe(15);
    for (const bad of ['0', '16', '1.5', '-1', 'x', '']) {
      expect(() => checks.parseArgs(['--state', 's', '--only-wave', bad])).toThrow(`--only-wave takes an integer 1..15, not ${JSON.stringify(bad)}`);
    }
    expect(() => checks.parseArgs(['--state', 's', '--only-wave'])).toThrow('--only-wave takes an integer 1..15, not null');
  });


  describe('checks.cjs runs the gate first (spawned against a fake candidate)', () => {
    // The fake CLI answers config and tab count; every other command fails, so wave 1 stops at tab-create.
    const FAKE_CLI = `const fs = require('fs'), path = require('path');
const home = process.env.HOME;
const mode = fs.readFileSync(path.join(home, 'mode'), 'utf8').trim();
const a = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls'), a.join(' ') + '\\n');
if (a[0] === 'config' && a[1] === 'set') {
  if (mode === 'setfail' || (mode === 'norestore' && fs.existsSync(path.join(home, 'cap')))) { process.stderr.write('error: forbidden\\n'); process.exit(3); }
  fs.writeFileSync(path.join(home, 'cap'), a[3]);
  process.exit(0);
}
if (a[0] === 'tab' && a[1] === 'count') {
  let c = null;
  try { c = fs.readFileSync(path.join(home, 'cap'), 'utf8'); } catch {}
  process.stdout.write(JSON.stringify({ workspaceId: a[3], count: 0, cap: c ? Number(c) : 8, capSource: c ? 'fleet-config' : 'default' }) + '\\n');
  process.exit(0);
}
process.stderr.write('error: unexpected\\n');
process.exit(1);
`;
    const runChecks = (mode: string, extra: string[] = []) => {
      const candidate = path.join(root, 'cand');
      fs.mkdirSync(path.join(candidate, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(candidate, 'bin', 'purplemux.js'), FAKE_CLI);
      fs.writeFileSync(path.join(scratchHome, 'mode'), mode);
      const scratch = path.dirname(scratchHome);
      const state = path.join(root, 'state.json');
      fs.writeFileSync(state, JSON.stringify({ scratch, home: scratchHome, tmuxTmpdir: path.join(scratch, 'tmux'), candidate,
        node: process.execPath, port: SCRATCH_PORT, workspaces: { a: 'ws-a', b: 'ws-b' } }));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/acceptance/checks.cjs'), '--state', state, ...extra], {
        env: asEnv({ PATH: process.env.PATH, HOME: liveHome }), encoding: 'utf-8', timeout: 30_000,
      });
      const calls = fs.existsSync(path.join(scratchHome, 'calls')) ? fs.readFileSync(path.join(scratchHome, 'calls'), 'utf8').trim().split('\n') : [];
      return { ...r, lines: r.stdout.trim().split('\n'), calls };
    };

    it('a refused cap set prints exactly one FAIL fixture-cap line, checks=1, exit 1, and runs no wave', () => {
      const r = runChecks('setfail');
      expect(r.status).toBe(1);
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0]).toMatch(/^FAIL fixture-cap — .*no check ran — measured: set exit 3, stderr: error: forbidden/);
      expect(r.lines[1]).toBe('ACCEPTANCE=FAIL checks=1 passed=0 failed=1 skipped=0');
      expect(r.calls).toEqual([`config set tabs.cap-per-workspace ${CAP}`, 'tab count -w ws-a --json', 'tab count -w ws-b --json']);
    });

    it('--only-wave 1 sets the cap but runs no wip-cap-refusal check', () => {
      const r = runChecks('ok', ['--only-wave', '1']);
      expect(r.lines[0]).toBe(`PASS fixture-cap — the scratch fleet's tabs.cap-per-workspace is ${CAP}, read back, before any check runs`);
      expect(r.stdout).not.toContain('wip-cap-refusal');
      expect(r.stdout).toContain('FAIL tab-create');
      expect(r.status).toBe(1);
      expect(r.calls.filter((c) => c.startsWith('config set'))).toEqual([`config set tabs.cap-per-workspace ${CAP}`]);
    });

    it('a full run runs SC-2 before wave 1, and a cap it cannot restore stops the run there', () => {
      const r = runChecks('norestore');
      expect(r.lines.map((l) => l.split(' — ')[0])).toEqual(['PASS fixture-cap', 'FAIL wip-cap-refusal', 'FAIL fixture-cap-restore',
        'ACCEPTANCE=FAIL checks=3 passed=1 failed=2 skipped=0']);
      expect(r.status).toBe(1);
      expect(r.calls).not.toContain('tab create -w ws-a -n acc-a1 -t terminal');
    });

    it('an out-of-range --only-wave is refused with exit 2 and runs nothing', () => {
      const r = runChecks('ok', ['--only-wave', '16']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--only-wave takes an integer 1..15, not "16"');
      expect(r.calls).toEqual([]);
    });

    it('a state whose port file is the live port is refused before any write', () => {
      writePort(liveHome, SCRATCH_PORT);
      const r = runChecks('ok');
      // runChecks points HOME (the live side) at liveHome; a state whose port file is the live one is refused.
      expect(r.lines[0]).toMatch(/^FAIL fixture-cap — .* the live port/);
      expect(r.calls).toEqual([]);
    });
  });
});

describe('checks-mission-control-page.cjs', () => {
  const wave7 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-mission-control-page.cjs'));

  it('tells the board view from the answers view, and neither from a page with both or none', () => {
    const section = '<section aria-labelledby="needs-you-heading"><div id="needs-you-heading"></div></section>';
    const board = '<div class="space-y-5" data-owner-board="">';
    expect(wave7.pageView(`<title>Mission Control · PurpleMux</title>${board}`).view).toBe('board');
    expect(wave7.pageView(section).view).toBe('answers');
    expect(wave7.pageView(`${board}${section}`).view).toBe('unknown');
    expect(wave7.pageView('<h1>Portfolio board</h1>')).toMatchObject({ needsYou: -1, board: -1, view: 'unknown' });
  });
});

describe('checks-board.cjs (story 12)', () => {
  const wave10 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-board.cjs'));

  it('accepts a served pulse and names each contract break', async () => {
    const { derivePulse } = await import('@/lib/pulse');
    const pulse = derivePulse({
      workspaceId: 'ws-a', now: Date.UTC(2026, 10, 3, 6), staleSince: null, oldestStuck: null,
      reads: [{ id: 'commits', events: [{ at: Date.UTC(2026, 10, 3, 5) }], reason: null, from: [] }],
      wip: { count: 0, basis: 'agent-tabs', basisReason: 'x', sources: { ledger: 'no-events', agentTabs: 'measured', missionControl: 'measured' } },
      priority: { basis: 'none', needsYou: 0, text: 'nothing waited in 24 h · needs you: 0' },
    });
    expect(wave10.pulseDefects(pulse)).toEqual([]);
    const zeroForUnknown = { ...pulse, sources: pulse.sources.map((source: { id: string }) => (source.id === 'gates' ? { ...source, count: 0 } : source)) };
    expect(wave10.pulseDefects(zeroForUnknown)).toEqual(['gates: unknown with count 0 and reason no reader']);
    expect(wave10.pulseDefects({ ...pulse, hours: [] })).toEqual(['hours: 0, expected 48 or null']);
    expect(wave10.pulseDefects(null)).toEqual(['no pulse']);
    const withShared = { ...pulse, sources: [...pulse.sources, { ...pulse.sources[1], sharedWith: ['Audit'] }] };
    expect(wave10.pulseDefects(withShared)).toEqual([]);
  });
});

describe('checks-mc-question-v2.cjs (ADR-0037)', () => {
  const wave8 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-mc-question-v2.cjs'));

  it('drafts one readable and one unreadable question, the second with exactly the defect the checks expect', async () => {
    const { validateMissionQuestion } = await import('@/lib/mission-question-format');
    const question = (options: unknown[]) => {
      const { itemId: _itemId, ...payload } = wave8.askDraft('ws-a', 'run-a', options).payload;
      return payload;
    };
    expect(validateMissionQuestion(question(wave8.READABLE), 2).ok).toBe(true);
    const refused = validateMissionQuestion(question(wave8.UNREADABLE), 2);
    expect(refused.ok ? [] : refused.defects.map((entry: { message: string }) => entry.message)).toEqual([wave8.ONE_OPTION_DEFECT]);
  });

  it('expects the reason the CLI prints for a draft no reshape can fix (story 23)', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'bin/cli.js'), 'utf8');
    expect(cli).toContain(wave8.RESHAPE_REASON);
  });
});

describe('checks-wave5.cjs fixtures (ADR-0021)', () => {
  const wave5 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-wave5.cjs'));

  it('findTab traverses panes and splits without accepting a different tab', () => {
    const wanted = { id: 'tab-wanted', sessionName: 'pt-ws-p-tab-wanted' };
    const root = { type: 'split', children: [
      { type: 'pane', tabs: [{ id: 'other' }] },
      { type: 'split', children: [{ type: 'pane', tabs: [wanted] }] },
    ] };
    expect(wave5.findTab(root, 'tab-wanted')).toBe(wanted);
    expect(wave5.findTab(root, 'tab-missing')).toBeNull();
  });

  it('the recovery daemon records provider identity and stays a Claude-named live process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-w5-'));
    try {
      const script = wave5.daemonStandIn(dir);
      const text = fs.readFileSync(script, 'utf8');
      expect(text).toContain('.claude/sessions');
      expect(text).toContain('"sessionId":"%s"');
      expect(text).toContain('exec -a claude sleep 3600');
      expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires plaintext close success plus a fresh matching reap with no survivors', () => {
    const freshAudit = {
      event: 'tab-reap', tabId: 'tab-test', session: 'session-test', keepProcesses: false,
      killed: [{ pid: 42, comm: 'sleep', args: 'sleep 300' }], survivors: [],
    };
    const base = {
      closed: { rc: 0, out: 'ok\nkilled 42 sleep sleep 300\n', err: '' },
      tabPresent: false,
      targetProbe: { rc: 1, out: '', err: "can't find window: session-test" },
      controlProbe: { rc: 0, out: 'control\t%1\t40\n', err: '' },
      entries: [{ event: 'earlier' }, freshAudit],
      auditOffset: 1,
      tabId: 'tab-test',
      sessionName: 'session-test',
    };
    expect(wave5.closeDurabilityEvidence(base)).toEqual({ ok: true, audit: freshAudit });
    for (const rejected of [
      { entries: [], auditOffset: 0 },
      { entries: [freshAudit], auditOffset: 1 },
      { entries: [{ ...freshAudit, session: 'other' }], auditOffset: 0 },
      { entries: [{ ...freshAudit, survivors: [{ pid: 43 }] }], auditOffset: 0 },
      { closed: { rc: 1, out: '', err: 'close-not-confirmed' } },
      { controlProbe: { rc: 1, out: '', err: 'no server running' } },
    ]) {
      expect(wave5.closeDurabilityEvidence({ ...base, ...rejected }).ok).toBe(false);
    }
  });
});

describe('checks-wave3.cjs judgements (story 23)', () => {
  const wave3 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-wave3.cjs'));
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-w3-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('judgeDeployLine: the fixed template passes; caller text or another template fails', () => {
    const line = '[purplemux deploy d-abcd1] purplemux restarts at ~2026-09-26T12:00:00Z (in 5 min) — details: purplemux deploy status d-abcd1; reach a checkpoint; tabs survive, in-flight hook events do not';
    expect(wave3.judgeDeployLine(line, 'd-abcd1', 'SECRET').ok).toBe(true);
    expect(wave3.judgeDeployLine(`${line} SECRET`, 'd-abcd1', 'SECRET').ok).toBe(false);
    expect(wave3.judgeDeployLine(line, 'd-other', 'SECRET').ok).toBe(false);
    expect(wave3.judgeDeployLine(undefined, 'd-abcd1', 'SECRET')).toEqual({ ok: false, measured: 'null' });
  });

  it('judgeDeployWithdrawal: a recipient delivered between status and withdrawal does not inflate the dropped count', () => {
    const before = ['a', 'b', 'c'].map((itemId) => ({ itemId, state: 'queued' }));
    const after = [
      { itemId: 'a', state: 'dropped' },
      { itemId: 'b', state: 'delivered' },
      { itemId: 'c', state: 'dropped' },
    ];
    expect(wave3.judgeDeployWithdrawal(before, after, 2)).toBe(true);
    expect(wave3.judgeDeployWithdrawal(before, after.map((r) => ({ ...r, state: 'dropped' })), 3)).toBe(true);
    expect(wave3.judgeDeployWithdrawal(before, after.map((r) => ({ ...r, state: 'delivered' })), 0)).toBe(true);
    expect(wave3.judgeDeployWithdrawal(before, after, 3)).toBe(false);
    expect(wave3.judgeDeployWithdrawal(before, [{ ...after[0], state: 'queued' }, after[1], after[2]], 1)).toBe(false);
    expect(wave3.judgeDeployWithdrawal(before, [after[0], after[0], after[2]], 2)).toBe(false);
    expect(wave3.judgeDeployWithdrawal(before, null, 2)).toBe(false);
    const alreadyDelivered = [{ itemId: 'a', state: 'delivered' }, before[1]];
    expect(wave3.judgeDeployWithdrawal(alreadyDelivered, [{ itemId: 'a', state: 'dropped' }, { itemId: 'b', state: 'dropped' }], 2)).toBe(false);
  });

  it('judgeWatchLine: needs the watch prefix, the target with its text, and the cleared tail', () => {
    const line = '[purplemux watch w-abcd1] o/r#1 is MERGED (aaaaaaaa) — watch cleared';
    expect(wave3.judgeWatchLine(line, 'o/r#1', 'is MERGED (aaaaaaaa)').ok).toBe(true);
    expect(wave3.judgeWatchLine(line, 'o/r#11', 'is MERGED (aaaaaaaa)').ok).toBe(false);
    expect(wave3.judgeWatchLine(line.replace(' — watch cleared', ''), 'o/r#1', 'is MERGED (aaaaaaaa)').ok).toBe(false);
    expect(wave3.judgeWatchLine('[purplemux note n-abcd] o/r#1 is MERGED (aaaaaaaa) — watch cleared', 'o/r#1', 'is MERGED (aaaaaaaa)').ok).toBe(false);
  });

  it('alertsFor: reads the kinds of `alert dispatched` records for one tab from every purplemux log', () => {
    const logs = path.join(dir, '.purplemux', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const rec = (o: object) => JSON.stringify({ level: 30, ...o });
    fs.writeFileSync(path.join(logs, 'purplemux.1.log'), [
      rec({ msg: 'alert dispatched', kind: 'bg-job-died', tabId: 'tab-a' }),
      rec({ msg: 'alert dispatched', kind: 'review', tabId: 'tab-b' }),
      'not json alert dispatched',
      rec({ msg: 'liveness nudge', kind: 'bg-failed', tabId: 'tab-a' }),
    ].join('\n'));
    fs.writeFileSync(path.join(logs, 'purplemux.2.log'), rec({ msg: 'alert dispatched', kind: 'bg-job-unknown', tabId: 'tab-a' }));
    fs.writeFileSync(path.join(logs, 'other.log'), rec({ msg: 'alert dispatched', kind: 'x', tabId: 'tab-a' }));
    expect(wave3.alertsFor(dir, 'tab-a').sort()).toEqual(['bg-job-died', 'bg-job-unknown']);
    expect(wave3.alertsFor(dir, 'tab-c')).toEqual([]);
    expect(wave3.alertsFor(path.join(dir, 'none'), 'tab-a')).toEqual([]);
  });

  it('the fake gh answers the nth read of a path, then the default, applies --jq, and 404s an unknown path', () => {
    fs.mkdirSync(path.join(dir, 'bin'));
    const answers = wave3.installFakeGh(dir);
    fs.writeFileSync(path.join(answers, 'repos_o_r_pulls_2.1'), 'first');
    fs.writeFileSync(path.join(answers, 'repos_o_r_pulls_2'), 'later');
    fs.writeFileSync(path.join(answers, 'repos_o_r_commits_c_check_runs_per_page_100'), JSON.stringify({ check_runs: [{ status: 'completed', conclusion: null }] }));
    const gh = (...args: string[]) => spawnSync(path.join(dir, 'bin', 'gh'), args, { encoding: 'utf-8' });
    expect(gh('api', 'repos/o/r/pulls/2').stdout).toBe('first');
    expect(gh('api', 'repos/o/r/pulls/2').stdout).toBe('later');
    expect(gh('api', 'repos/o/r/pulls/2').stdout).toBe('later');
    // The server's own --jq filter runs on the API body, as gh would.
    const filter = '.check_runs[] | [.status, (.conclusion // "")] | @tsv';
    expect(gh('api', '--paginate', 'repos/o/r/commits/c/check-runs?per_page=100', '--jq', filter).stdout).toBe('completed\t\n');
    const missing = gh('api', 'repos/o/r/pulls/9');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('HTTP 404');
  });
});

/** Pids whose environ carries a HOME under `dir` — what a leaked candidate would look like. */
const pidsWithHomeUnder = (dir: string) =>
  fs
    .readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        const home = fs.readFileSync(`/proc/${p}/environ`, 'utf-8').split('\0').find((l) => l.startsWith('HOME='));
        return Boolean(home && home.slice(5).startsWith(`${dir}/`));
      } catch {
        return false;
      }
    });

// A fake server launcher: writes the port, token and lock files the real server writes, then runs as
// `sleep` under the same pid. LEAK=1 re-execs with a live key in its environ.
const FAKE_TSX = `#!/bin/bash
mkdir -p "$HOME/.purplemux"
echo "$PORT" > "$HOME/.purplemux/port"
echo admin-token > "$HOME/.purplemux/cli-token"
printf '{"pid":%s,"port":%s}' "$$" "$PORT" > "$HOME/.purplemux/pmux.lock"
# HOME is <root>/s/pmxa.X/home, so the test root (where the flags live) is three levels up.
[[ -e "$HOME/../../../no-port" ]] && rm -f "$HOME/.purplemux/port"
[[ -e "$HOME/../../../leak" ]] && exec env PMUX_TOKEN=leaked sleep 600
[[ -e "$HOME/../../../bad-pristine" ]] && exec env __PMUX_PRISTINE_ENV='{not json' sleep 600
exec sleep 600
`;

// A fake curl: nothing answers on a bare port, /api/health is purplemux, and /api/workspace answers
// an id unless the flag file ws-fail exists next to the fakes.
const fakeCurl = (dir: string) => `#!/bin/bash
url="\${@: -1}"
case "$url" in
  */api/auth/setup|*/api/auth/login) echo '{}' ;;
  */api/health) echo '{"app":"purplemux","version":"0"}' ;;
  */api/workspace) [[ " $* " == *" -b "* && " $* " == *"Origin: "* ]] || exit 22; [[ -e "${dir}/ws-fail" ]] && exit 7; echo "{\\"id\\":\\"ws-$RANDOM\\"}" ;;
  *) exit 7 ;;
esac
`;

describe('isolated-instance.sh safety', { timeout: 60_000 }, () => {
  let root: string;
  let parent: string;
  let candidate: string;
  let home: string;
  const children: number[] = [];

  const built = (dir: string) => {
    for (const f of ['server.ts', 'bin/purplemux.js', 'node_modules/.bin/tsx', '.next/BUILD_ID']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
  };

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ACCEPT_NODE: process.execPath,
    ACCEPT_SCRATCH_PARENT: parent,
    ...extra,
  });

  const instance = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [INSTANCE, ...args], { env: asEnv(env(extra)), encoding: 'utf-8', timeout: 30_000 });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-inst-'));
    parent = path.join(root, 's');
    candidate = path.join(root, 'candidate');
    home = path.join(root, 'home');
    for (const d of [parent, candidate, path.join(home, '.purplemux')]) fs.mkdirSync(d, { recursive: true });
  });

  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses an unbuilt candidate before creating anything', () => {
    built(candidate);
    fs.rmSync(path.join(candidate, '.next'), { recursive: true });
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED CANDIDATE-UNBUILT');
    expect(r.stderr).toContain('.next/BUILD_ID');
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('refuses a socket path over the unix limit and removes its scratch directory', () => {
    built(candidate);
    const deep = path.join(parent, 'x'.repeat(90));
    fs.mkdirSync(deep);
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')], { ACCEPT_SCRATCH_PARENT: deep });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED SOCKET-PATH-LONG');
    expect(fs.readdirSync(deep)).toEqual([]);
  });

  it('refuses the live port and a port that answers', () => {
    built(candidate);
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), '8022\n');
    const live = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json'), '--port', '8022']);
    expect(live.status).toBe(2);
    expect(live.stderr).toContain('REFUSED LIVE-PORT');
    const fakeCurl = path.join(root, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const busy = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json'), '--port', '18123'], { ACCEPT_CURL: fakeCurl });
    expect(busy.status).toBe(2);
    expect(busy.stderr).toContain('REFUSED PORT-BUSY');
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('refuses a missing node', () => {
    built(candidate);
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')], { ACCEPT_NODE: path.join(root, 'no-node') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED NODE-MISSING');
  });

  const withFakes = (extra: Record<string, string> = {}) => {
    built(candidate);
    const tsx = path.join(root, 'tsx');
    fs.writeFileSync(tsx, FAKE_TSX, { mode: 0o755 });
    const curl = path.join(root, 'curl');
    fs.writeFileSync(curl, fakeCurl(root), { mode: 0o755 });
    return {
      ACCEPT_TSX: tsx,
      ACCEPT_CURL: curl,
      ACCEPT_START_TIMEOUT_S: '5',
      // What a shell inside a live tab carries; none of it may reach the candidate.
      PMUX_TOKEN: 'live-token',
      PMUX_TAB_TOKEN: 'live-tab-token',
      TMUX: '/tmp/tmux-1000/purple,1,1',
      __PMUX_PRISTINE_ENV: JSON.stringify({ HOME: '/home/live' }),
      ...extra,
    };
  };
  const flagForScratch = (name: string) => fs.writeFileSync(path.join(root, name), '');

  it('up starts the candidate with none of the live keys, writes its state, and down leaves nothing', () => {
    const state = path.join(root, 'state.json');
    const r = instance(['up', '--candidate', candidate, '--state', state], withFakes());
    expect(r.status, r.stderr).toBe(0);
    const s = JSON.parse(fs.readFileSync(state, 'utf-8'));
    expect(s.workspaces.a).toMatch(/^ws-/);
    const environ = fs.readFileSync(`/proc/${s.pid}/environ`, 'utf-8').split('\0');
    for (const key of ['PMUX_TOKEN', 'PMUX_TAB_TOKEN', 'TMUX', '__PMUX_PRISTINE_ENV']) {
      expect(environ.some((l) => l.startsWith(`${key}=`)), key).toBe(false);
    }
    expect(environ).toContain(`HOME=${s.home}`);
    const d = instance(['down', '--state', state]);
    expect(d.status, d.stderr).toBe(0);
    expect(pidsWithHomeUnder(parent)).toEqual([]);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('a failure after the start tears the candidate down, removes the scratch dir and empties the state', () => {
    fs.writeFileSync(path.join(root, 'ws-fail'), '');
    const state = path.join(root, 'state.json');
    const r = instance(['up', '--candidate', candidate, '--state', state], withFakes());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED WORKSPACES');
    expect(r.stderr).toContain('candidate server.log');
    expect(pidsWithHomeUnder(parent)).toEqual([]);
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(fs.readFileSync(state, 'utf-8')).toBe('');
  });

  it('refuses NOT-ISOLATED when a live key reaches the candidate, and tears it down', () => {
    flagForScratch('leak');
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')], withFakes({ ACCEPT_SCRATCH_PARENT: parent }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED NOT-ISOLATED');
    expect(r.stderr).toContain('PMUX_TOKEN');
    expect(pidsWithHomeUnder(parent)).toEqual([]);
  });

  it('refuses a pristine env it cannot parse, and tears the candidate down', () => {
    flagForScratch('bad-pristine');
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')], withFakes());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED NOT-ISOLATED');
    expect(r.stderr).toContain('HOME=<unparseable>');
    expect(pidsWithHomeUnder(parent)).toEqual([]);
  });

  it('a SIGTERM while up waits for the server tears the server down', async () => {
    flagForScratch('no-port');
    const state = path.join(root, 'state.json');
    const child = spawn('bash', [INSTANCE, 'up', '--candidate', candidate, '--state', state], {
      env: asEnv(env(withFakes({ ACCEPT_START_TIMEOUT_S: '30' }))),
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(fs.existsSync(state) && fs.readFileSync(state, 'utf-8').includes('"pid"'))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pidsWithHomeUnder(parent).length).toBeGreaterThan(0);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    expect(pidsWithHomeUnder(parent)).toEqual([]);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('down stops only processes started with the scratch HOME, and removes the scratch directory', async () => {
    const scratch = fs.mkdtempSync(path.join(parent, 'pmxa.'));
    const scratchHome = path.join(scratch, 'home');
    fs.mkdirSync(scratchHome);
    const ours = spawn('sleep', ['60'], { env: asEnv({ PATH: '/usr/bin:/bin', HOME: scratchHome }), stdio: 'ignore' });
    const live = spawn('sleep', ['60'], { env: asEnv({ PATH: '/usr/bin:/bin', HOME: home }), stdio: 'ignore' });
    children.push(ours.pid!, live.pid!);
    const oursExited = new Promise<NodeJS.Signals | null>((resolve) => ours.on('exit', (_code, signal) => resolve(signal)));
    const state = path.join(root, 'state.json');
    fs.writeFileSync(
      state,
      JSON.stringify({ scratch, home: scratchHome, tmuxTmpdir: path.join(scratch, 'tmux'), pid: live.pid, lockPid: ours.pid }),
    );
    const r = instance(['down', '--state', state]);
    expect(r.status, r.stderr).toBe(0);
    expect(live.exitCode).toBeNull();
    expect(fs.existsSync(`/proc/${live.pid}`)).toBe(true);
    expect(await oursExited).toBe('SIGTERM');
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it('down refuses a state file whose paths are not a scratch directory, including a .. escape', () => {
    const state = path.join(root, 'state.json');
    for (const scratch of [home, path.join(parent, 'pmxa.abcdef', '..', '..', 'home')]) {
      fs.writeFileSync(state, JSON.stringify({ scratch, home: path.join(scratch, 'home'), tmuxTmpdir: path.join(scratch, 'tmux') }));
      const r = instance(['down', '--state', state]);
      expect(r.status, scratch).toBe(2);
      expect(r.stderr).toContain('REFUSED STATE');
    }
    expect(fs.existsSync(home)).toBe(true);
  });

  it('down with an empty state has nothing to do', () => {
    const state = path.join(root, 'state.json');
    fs.writeFileSync(state, '');
    const r = instance(['down', '--state', state]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NOTHING-TO-DO');
  });
});

describe('run.sh verdicts', { timeout: 60_000 }, () => {
  let root: string;

  const fake = (name: string, body: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    return file;
  };

  const writeInstanceFake = (up = 0) =>
    fake(
      'instance',
      `echo "$*" >> "${root}/instance.log"
if [[ "$1" == up ]]; then
  while (($#)); do [[ "$1" == --state ]] && state="$2"; shift; done
  echo '{"workspaces":{"a":"ws-A","b":"ws-B"}}' > "$state"
  [[ -e "${root}/up-hangs" ]] && { touch "${root}/up-started"; sleep 30; }
  exit ${up}
fi
exit 0`,
    );
  const runGate = (opts: { up?: number; checks?: number; live?: string[]; tmuxRc?: number; tmuxErr?: string } = {}) => {
    const instance = fake(
      'instance',
      `echo "$*" >> "${root}/instance.log"
if [[ "$1" == up ]]; then
  while (($#)); do [[ "$1" == --state ]] && state="$2"; shift; done
  echo '{"workspaces":{"a":"ws-A","b":"ws-B"}}' > "$state"
  [[ -e "${root}/up-hangs" ]] && { touch "${root}/up-started"; sleep 30; }
  exit ${opts.up ?? 0}
fi
exit 0`,
    );
    const checksScript = path.join(root, 'checks.cjs');
    fs.writeFileSync(checksScript, `console.log('PASS x — fake'); process.exit(${opts.checks ?? 0});\n`);
    const tmux = fake(
      'tmux',
      opts.tmuxRc ? `echo '${opts.tmuxErr ?? 'error'}' >&2; exit ${opts.tmuxRc}` : `printf '%s\\n' ${(opts.live ?? ['pt-ws-live-p-tab-1']).map((s) => `'${s}'`).join(' ')}`,
    );
    const log = path.join(root, 'gate.log');
    const r = spawnSync('bash', [RUN, '--candidate', root, '--log', log], {
      env: asEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: root, ACCEPT_INSTANCE: instance, ACCEPT_CHECKS: checksScript, ACCEPT_TMUX: tmux, ACCEPT_NODE: process.execPath }),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { status: r.status, out: r.stdout, log: fs.readFileSync(log, 'utf-8'), calls: fs.readFileSync(path.join(root, 'instance.log'), 'utf-8') };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-run-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when every check passes and nothing leaked, and always takes the instance down', () => {
    const r = runGate();
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('PASS live-socket-untouched');
    expect(r.log).toMatch(/^ACCEPTANCE=PASS log=/m);
    expect(r.calls).toMatch(/^up --candidate /m);
    expect(r.calls).toMatch(/^down --state /m);
  });

  it('fails when a check fails, still taking the instance down', () => {
    const r = runGate({ checks: 1 });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/^ACCEPTANCE=FAIL checks_exit=1 live_socket=ok/m);
    expect(r.calls).toMatch(/^down /m);
  });

  it('fails when an isolated session appears on the live tmux socket', () => {
    const r = runGate({ live: ['pt-ws-live-p-tab-1', 'pt-ws-B-pane-x-tab-y'] });
    expect(r.status).toBe(1);
    expect(r.log).toContain('FAIL live-socket-untouched');
    expect(r.log).toContain('pt-ws-B-pane-x-tab-y');
    expect(r.log).toMatch(/live_socket=fail/);
  });

  it('reports REFUSED with exit 2 when the instance cannot start, and still calls down on the state it wrote', () => {
    const r = runGate({ up: 2 });
    expect(r.status).toBe(2);
    expect(r.log).toMatch(/^ACCEPTANCE=REFUSED /m);
    expect(r.calls).toMatch(/^down --state /m);
  });

  it('a SIGTERM to run.sh while up runs is acted on at once, and down still runs', async () => {
    fs.writeFileSync(path.join(root, 'up-hangs'), '');
    writeInstanceFake();
    const started = Date.now();
    const done = new Promise<number | null>((resolve) => {
      const child = spawn('bash', [RUN, '--candidate', root, '--log', path.join(root, 'gate.log')], {
        env: asEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: root, ACCEPT_INSTANCE: path.join(root, 'instance'), ACCEPT_NODE: process.execPath }),
        stdio: 'ignore',
      });
      const poll = setInterval(() => {
        if (fs.existsSync(path.join(root, 'up-started'))) {
          clearInterval(poll);
          child.kill('SIGTERM');
        }
      }, 50);
      child.on('exit', (code) => resolve(code));
    });
    expect(await done).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(fs.readFileSync(path.join(root, 'gate.log'), 'utf-8')).toContain('ACCEPTANCE=FAIL interrupted');
    expect(fs.readFileSync(path.join(root, 'instance.log'), 'utf-8')).toMatch(/^down --state /m);
  });

  it('an unreadable live socket is a FAIL, never a silent pass; no live server at all is a pass that says so', () => {
    const unreadable = runGate({ tmuxRc: 1, tmuxErr: 'error connecting to /tmp/tmux-1000/purple (Permission denied)' });
    expect(unreadable.status).toBe(1);
    expect(unreadable.log).toContain('FAIL live-socket-untouched — the live tmux socket could not be read');
    const none = runGate({ tmuxRc: 1, tmuxErr: 'no server running on /tmp/tmux-1000/purple' });
    expect(none.status).toBe(0);
    expect(none.log).toContain('PASS live-socket-untouched — no live tmux server is running');
  });
});

// The real thing, against a built candidate: ACCEPTANCE_E2E_CANDIDATE=<built checkout>.
const E2E = process.env.ACCEPTANCE_E2E_CANDIDATE;
describe.skipIf(!E2E)('acceptance end to end (opt-in)', () => {
  it('passes every wave-1, story-15 and wave-2 check on an isolated instance', { timeout: 600_000 }, () => {
    const log = path.join(os.tmpdir(), `acceptance-e2e-${process.pid}.log`);
    // The real HOME and the real tmux socket directory: the harness's live-home
    // refusal, live-port avoidance and live-socket leak check must look at the
    // live instance, not at the test run's isolated HOME and TMUX_TMPDIR.
    const env = {
      ...process.env,
      HOME: process.env.PMUX_TEST_REAL_HOME ?? process.env.HOME,
      ACCEPT_LIVE_TMUX_TMPDIR: process.env.PMUX_TEST_REAL_TMUX_TMPDIR ?? '/tmp',
    };
    const r = spawnSync('bash', [RUN, '--candidate', E2E!, '--log', log], { encoding: 'utf-8', timeout: 590_000, env });
    expect(r.status, fs.readFileSync(log, 'utf-8')).toBe(0);
    const body = fs.readFileSync(log, 'utf-8');
    // Without --bash-guard the guard check is the one SKIP; every other check must pass.
    expect(body).toMatch(/^ACCEPTANCE=PASS checks=82 passed=81 failed=0 skipped=1$/m);
    // The wave-2 checks (story 22) ran, each by id.
    for (const id of ['config-authority', 'config-constructor-key', 'tab-close-reaps-own', 'note-delivered', 'note-ack',
      'api-error-resume', 'usage-warning-negative', 'compaction-no-turn-end', 'result-suggestion']) {
      expect(body).toMatch(new RegExp(`^PASS ${id} — `, 'm'));
    }
    for (const id of ['recovery-live-refusal', 'recovery-stale-cas', 'recovery-own-workspace-success',
      'recovery-authenticated-app-input', 'recovery-terminal-ready', 'recovery-unattributable-hooks-retain',
      'recovery-raw-order-coalescing', 'recovery-raw-persistence-refusal']) {
      expect(body).toMatch(new RegExp(`^PASS ${id} — `, 'm'));
    }
    expect(body.match(/^SKIP .*/gm)).toEqual(['SKIP bash-guard — no --bash-guard path given']);
  });
});

it('isolated intentional ownership changes send one human CAS replacement with the read revision', async () => {
  const inst = Object.create(checks.Instance.prototype);
  inst.cli = vi.fn(async () => ({ rc: 0, out: JSON.stringify({ orchestration: { revision: 7, orchestratorTabId: 'old' } }) }));
  inst.human = vi.fn(async () => ({ status: 409, body: 'changed' }));
  expect(await inst.designate('ws-a', 'next')).toMatchObject({ rc: 1 });
  expect(inst.cli).toHaveBeenCalledOnce(); expect(inst.human).toHaveBeenCalledOnce();
  expect(inst.human).toHaveBeenCalledWith('PATCH', '/api/workspace/ws-a', { orchestration: { enabled: true, orchestratorTabId: 'next' }, expectedRevision: 7, mode: 'replace' });
});

describe('wave 12: one attention alert per item that becomes owner-visible (story 33 round 2)', () => {
  const alertWave = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-attention-alert.cjs'));
  const frame = (itemId: string, revision: number) => ({ type: 'notification:alert', alert: { kind: 'attention-opened', itemId, question: { revision } } });
  const base = {
    socketOpen: true, sends: { started: 0, opened: 0, candidate: 0, promoted: 0 }, states: { opened: 'open', promoted: 'open' },
    openedId: 'acc-alert-x-opened', promotedId: 'acc-alert-x-promoted', runPrefix: 'acc-alert-x',
  };

  it('passes on exactly one alert for each item at revisions 1 and 2', () => {
    const judged = alertWave.judgeAttentionAlerts({ ...base, frames: [{ type: 'status:sync' }, frame('acc-alert-x-opened', 1), frame('acc-alert-x-promoted', 2), frame('other-ws-item', 1)] });
    expect(judged).toMatchObject({ ok: true });
    expect(judged.measured).toContain('opened x1 (revision 1), promoted x1 (revision 2), other items of this run x0');
  });

  it('fails on a missing promotion alert, a duplicate, a wrong revision, a stray item, a closed socket or a refused send', () => {
    const ok = [frame('acc-alert-x-opened', 1), frame('acc-alert-x-promoted', 2)];
    expect(alertWave.judgeAttentionAlerts({ ...base, frames: [frame('acc-alert-x-opened', 1)] }).ok).toBe(false);
    expect(alertWave.judgeAttentionAlerts({ ...base, frames: [...ok, frame('acc-alert-x-opened', 1)] }).ok).toBe(false);
    expect(alertWave.judgeAttentionAlerts({ ...base, frames: [frame('acc-alert-x-opened', 1), frame('acc-alert-x-promoted', 3)] }).ok).toBe(false);
    expect(alertWave.judgeAttentionAlerts({ ...base, frames: [...ok, frame('acc-alert-x-cancel', 1)] }).ok).toBe(false);
    expect(alertWave.judgeAttentionAlerts({ ...base, socketOpen: false, frames: ok }).ok).toBe(false);
    expect(alertWave.judgeAttentionAlerts({ ...base, sends: { ...base.sends, promoted: 3 }, frames: ok }).ok).toBe(false);
    expect(alertWave.judgeAttentionAlerts({ ...base, states: { opened: 'open', promoted: 'candidate' }, frames: ok }).ok).toBe(false);
  });

  it('runs twelfth, after the context lifecycle wave and before the effects wave (story 15 merge, M2)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'scripts/acceptance/checks.cjs'), 'utf8'))
      .toMatch(/\(\) => wave11\(inst, helpers\), \(\) => waveAttentionAlert\(inst, helpers\),\n {2}\(\) => wave13\(inst, helpers\), \(\) => wave14\(inst, helpers\),/);
  });

  it('the local curator runs fourteenth, after the effects wave (story 16 merge, M3)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'scripts/acceptance/checks.cjs'), 'utf8');
    expect(text).toMatch(/\(\) => wave13\(inst, helpers\), \(\) => wave14\(inst, helpers\),/);
    expect(text).toContain("const { wave14 } = require('./checks-curator.cjs');");
    expect(fs.readFileSync(path.join(ROOT, 'scripts/acceptance/checks-curator.cjs'), 'utf8')).toMatch(/^\/\/ Wave-14 acceptance checks/m);
  });

  it('curator routing runs fifteenth, last, after the curator wave (story 23)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'scripts/acceptance/checks.cjs'), 'utf8');
    expect(text).toMatch(/\(\) => wave14\(inst, helpers\),\n {2}\(\) => wave15\(inst, helpers\)\];/);
    expect(text).toContain("const { wave15 } = require('./checks-curator-routing.cjs');");
    const wave = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-curator-routing.cjs'));
    expect(fs.readFileSync(path.join(ROOT, 'scripts/acceptance/checks-curator-routing.cjs'), 'utf8')).toMatch(/^\/\/ Wave-15 acceptance checks/m);
    expect(wave.RESHAPE_DRAFT('ws-a').payload.options.map((o: { id: string }) => o.id)).toEqual(['friday', 'tonight']);
  });
});
