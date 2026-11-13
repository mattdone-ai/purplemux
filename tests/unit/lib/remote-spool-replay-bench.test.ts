import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * PMUX-REMOTE-RESILIENCE fix 5: the replay cost of a remote hook spool, measured. Skipped unless
 * PMUX_BENCH_REMOTE_SPOOL=1, so no gate pays for it. A fake `ssh` on PATH adds a fixed delay per call
 * (PMUX_FAKE_SSH_DELAY, default 1 s) and runs the command here, so the real replay path runs end to end:
 * drainHookSpoolsWithRemotePull → dispatchHook → handleRemoteClaudeHook → syncRemoteTranscript → runSshBuffer.
 */
const BENCH = process.env.PMUX_BENCH_REMOTE_SPOOL === '1';
const EVENTS = 50;
const SESSION = 'pt-ws-bench-pane-p-tab-bench';
const SESSION_ID = '0b5c0a1e-7d2f-4c55-9a3e-5b8e0f1c2d3e';

const applied = vi.hoisted(() => ({ events: 0, metas: 0 }));
vi.mock('@/lib/session-host', () => ({
  remoteHostsInUse: async () => [],
  knownRemoteHosts: () => [],
  sessionHostOf: async (s: string) => (s === SESSION ? 'benchhost' : null),
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    applyAgentHookMeta: () => { applied.metas += 1; },
    handleProviderEvent: () => { applied.events += 1; },
    handleToolActivity: () => { applied.events += 1; },
  }),
}));

const FAKE_SSH = `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift; shift
sleep "\${PMUX_FAKE_SSH_DELAY:-1}"
exec sh -c "$1"
`;

describe.skipIf(!BENCH)('remote hook spool replay, 50 events (bench)', () => {
  it('replays the spool and reports the time per event', { timeout: 600_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-spool-bench-'));
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const transcriptPath = path.join(root, 'remote', 'projects', 'bench', `${SESSION_ID}.jsonl`);
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'assistant', uuid: `a-${i}`, message: { content: [{ type: 'text', text: `step ${i}` }] } })).join('\n') + '\n');

    const { HOOK_SPOOL_DIR } = await import('@/lib/hook-spool');
    await fs.mkdir(HOOK_SPOOL_DIR, { recursive: true });
    const now = Date.now();
    const kinds = ['tool', 'tool', 'tool', 'stop', 'prompt-submit'];
    for (let i = 0; i < EVENTS; i += 1) {
      const kind = kinds[i % kinds.length];
      const event = kind === 'tool' ? 'post-tool-use' : kind;
      const query = `remote=claude&session=${SESSION}&event=${event}${kind === 'tool' ? '&kind=tool' : ''}`;
      const body = { session_id: SESSION_ID, transcript_path: transcriptPath, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'true' } };
      const at = now - (EVENTS - i) * 1000;
      await fs.writeFile(path.join(HOOK_SPOOL_DIR, `${at}-r1-${i.toString(16).padStart(4, '0')}.json`), JSON.stringify({ v: 1, at, session: SESSION, query, body }));
    }

    const { dispatchHook } = await import('@/lib/hook-dispatch');
    const { drainHookSpoolsWithRemotePull } = await import('@/lib/remote-spool');
    const started = performance.now();
    const result = await drainHookSpoolsWithRemotePull(dispatchHook);
    const ms = performance.now() - started;
    const mirror = (await fs.readdir(path.join(os.homedir(), '.purplemux', 'remote-transcripts', 'tab-bench'))).filter((f) => f.endsWith('.jsonl'));
    console.log(`[bench] ${EVENTS} remote events, fake ssh delay ${process.env.PMUX_FAKE_SSH_DELAY ?? '1'} s: ${(ms / 1000).toFixed(1)} s total, ${(ms / EVENTS).toFixed(0)} ms per event; applied ${result.applied}, timed out ${result.timedOut}, bad ${result.bad}`);
    expect(result.applied).toBe(EVENTS);
    expect(applied.events).toBe(EVENTS);
    expect(mirror).toEqual([`${SESSION_ID}.jsonl`]);
    await fs.rm(root, { recursive: true, force: true });
  });
});
