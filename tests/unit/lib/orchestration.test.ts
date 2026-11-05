import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KICKOFF_TEMPLATE,
  resolveKickoffTemplate,
  buildNudgeMessage,
  nudgeKindForTransition,
  NUDGE_PREFIX,
} from '@/lib/orchestration';

describe('resolveKickoffTemplate', () => {
  it('fills all placeholders', () => {
    const resolved = resolveKickoffTemplate(DEFAULT_KICKOFF_TEMPLATE, {
      workspaceId: 'ws-abc123',
      workspaceName: 'my-epic',
      task: 'Build the thing',
    });
    expect(resolved).toContain('ws-abc123');
    expect(resolved).toContain('my-epic');
    expect(resolved).toContain('Build the thing');
    expect(resolved).toContain('purplemux tab count -w ws-abc123');
    expect(resolved).not.toMatch(/Max \d+ concurrent workers/);
    expect(resolved).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('replaces repeated placeholders', () => {
    const resolved = resolveKickoffTemplate('{{WORKSPACE_ID}} {{WORKSPACE_ID}}', {
      workspaceId: 'ws-x',
      workspaceName: 'n',
    });
    expect(resolved).toBe('ws-x ws-x');
  });

  it('defaults the task, and a stored {{MAX_WORKERS}} names the enforced WIP cap, never a number of its own (story 15, AC 3)', () => {
    const resolved = resolveKickoffTemplate('{{TASK}}|{{MAX_WORKERS}}', {
      workspaceId: 'ws-x',
      workspaceName: 'n',
    });
    expect(resolved).toBe('(described in the next message)|the WIP cap (purplemux tab count -w ws-x)');
  });
});

describe('the kickoff dialog\'s placeholder hint (story 15, review R6)', () => {
  it('offers no MAX_WORKERS in any locale: the enforced WIP cap is the only cap, and a stored template still resolves it', () => {
    const dir = path.resolve('messages');
    const locales = fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, 'orchestration.json')));
    expect(locales.length).toBeGreaterThanOrEqual(11);
    for (const locale of locales) {
      const hint = JSON.parse(fs.readFileSync(path.join(dir, locale, 'orchestration.json'), 'utf8')).templateHint as string;
      expect(hint, locale).toContain('WORKSPACE_ID');
      expect(hint, locale).not.toContain('MAX_WORKERS');
    }
  });
});

describe('nudgeKindForTransition', () => {
  it.each([
    ['busy', 'needs-input', false, 'needs-input'],
    ['busy', 'ready-for-review', false, 'ready-for-review'],
    ['busy', 'idle', false, 'turn-ended'],
    ['idle', 'inactive', false, 'inactive'],
    ['busy', 'inactive', true, 'inactive'],
  ] as const)('%s -> %s (silent=%s) yields %s', (prev, next, silent, expected) => {
    expect(nudgeKindForTransition(prev, next, silent)).toBe(expected);
  });

  it.each([
    ['idle', 'busy', false],
    ['inactive', 'idle', false],
    ['busy', 'idle', true],
    ['busy', 'needs-input', true],
    ['busy', 'ready-for-review', true],
    ['unknown', 'inactive', false],
  ] as const)('%s -> %s (silent=%s) yields null', (prev, next, silent) => {
    expect(nudgeKindForTransition(prev, next, silent)).toBeNull();
  });
});

describe('buildNudgeMessage', () => {
  it('includes prefix, tab id, and capture command for actionable kinds', () => {
    for (const kind of ['needs-input', 'ready-for-review', 'turn-ended', 'stuck'] as const) {
      const msg = buildNudgeMessage(kind, 'tab-1', 'story-06', 'ws-abc');
      expect(msg).toContain(NUDGE_PREFIX);
      expect(msg).toContain('tab-1');
      expect(msg).toContain('story-06');
      expect(msg).toContain('purplemux tab result -w ws-abc tab-1');
    }
  });

  it('handles inactive without a capture command and unnamed tabs', () => {
    const msg = buildNudgeMessage('inactive', 'tab-2', '', 'ws-abc');
    expect(msg).toContain(NUDGE_PREFIX);
    expect(msg).toContain('unnamed');
    expect(msg).toContain('INACTIVE');
  });

  it('builds liveness nudges with detail and capture command', () => {
    const stalled = buildNudgeMessage('stalled', 'tab-3', 'drain', 'ws-abc', 'probe "drain" reports no progress for ~19 min (threshold 15 min)');
    expect(stalled).toContain('STALLED');
    expect(stalled).toContain('no progress for ~19 min');
    expect(stalled).toContain('purplemux tab result -w ws-abc tab-3');

    const completed = buildNudgeMessage('bg-completed', 'tab-3', 'drain', 'ws-abc', 'pid 4242 exited with code 0');
    expect(completed).toContain('BACKGROUND JOB COMPLETED');
    expect(completed).toContain('verify its artifacts');
    expect(completed).not.toContain('restart');

    const failed = buildNudgeMessage('bg-failed', 'tab-3', 'drain', 'ws-abc', 'pid 4242 exited with code 137');
    expect(failed).toContain('BACKGROUND JOB FAILED');
    expect(failed).toContain('pid 4242 exited with code 137');

    const unknown = buildNudgeMessage('bg-exited-unknown', 'tab-3', 'drain', 'ws-abc', 'pid 4242 exited with unknown exit code');
    expect(unknown).toContain('BACKGROUND JOB EXITED');
    expect(unknown).toContain('Inspect its artifacts');
    expect(unknown).not.toContain('mark the task blocked');

    const legacy = buildNudgeMessage('bg-died', 'tab-3', 'drain', 'ws-abc');
    expect(legacy).toContain('legacy background-job notification');
    expect(legacy).toContain('Inspect its artifacts');

    const failing = buildNudgeMessage('probe-failed', 'tab-3', 'drain', 'ws-abc', 'probe "drain" failed 3x in a row');
    expect(failing).toContain('PROBE FAILING');
    expect(failing).toContain('failed 3x');
    expect(failing).toContain('not a green light');
  });

  it('falls back to generic detail for liveness nudges', () => {
    for (const kind of ['stalled', 'probe-failed', 'bg-completed', 'bg-failed', 'bg-exited-unknown', 'bg-died', 'model-drift'] as const) {
      const msg = buildNudgeMessage(kind, 'tab-3', 'drain', 'ws-abc');
      expect(msg).toContain(NUDGE_PREFIX);
      expect(msg.length).toBeGreaterThan(50);
    }
  });
});

describe('kickoff template liveness doctrine', () => {
  it('tells the orchestrator to arm both watchers at dispatch', () => {
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('TWO watchers AT DISPATCH');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('purplemux tab probe set');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('purplemux tab bg add');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('BACKGROUND JOB COMPLETED');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('BACKGROUND JOB FAILED');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('needsHuman=true');
  });

  it('requires every automated worker creation to include its assigned model and effort', () => {
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('-m <assigned-model> -r <assigned-effort>');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('Every automated worker creation');
    expect(DEFAULT_KICKOFF_TEMPLATE).not.toContain('send /model');
  });
});
