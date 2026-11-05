import { describe, expect, it } from 'vitest';
import { alertFor, isStallEpisodeEnd, shouldAlert, standupAlertTabId } from '@/lib/alert-policy';
import { buildFcmMessage, FCM_DATA_BUDGET_BYTES, fcmDataBytes } from '@/lib/fcm-channel';
import type { IWorkspace } from '@/types/terminal';
import type { IWorkspaceStandup } from '@/types/status';

const ORCH_TAB = 'T1';
const WORKER_TAB = 'T2';
const AT = 1_700_000_000_000;

const workspace = (orchestration?: IWorkspace['orchestration']): IWorkspace => ({
  id: 'ws-1',
  name: 'Epic',
  directories: ['/tmp/epic'],
  orchestration,
});

const orchestrated = workspace({ enabled: true, orchestratorTabId: ORCH_TAB });
const plain = workspace(undefined);
const disabledOrch = workspace({ enabled: false, orchestratorTabId: ORCH_TAB });

describe('shouldAlert', () => {
  describe('orchestrator-only (default, alertsOrchestratorOnly === true)', () => {
    it('alerts for the orchestrator tab of an orchestrated workspace', () => {
      expect(shouldAlert({ id: ORCH_TAB }, orchestrated, { alertsOrchestratorOnly: true })).toBe(true);
    });

    it('stays silent for worker tabs of an orchestrated workspace', () => {
      expect(shouldAlert({ id: WORKER_TAB }, orchestrated, { alertsOrchestratorOnly: true })).toBe(false);
    });

    it('stays silent for every tab of a workspace without orchestration', () => {
      expect(shouldAlert({ id: ORCH_TAB }, plain, { alertsOrchestratorOnly: true })).toBe(false);
      expect(shouldAlert({ id: WORKER_TAB }, plain, { alertsOrchestratorOnly: true })).toBe(false);
    });

    it('treats orchestration.enabled === false as no orchestrator', () => {
      expect(shouldAlert({ id: ORCH_TAB }, disabledOrch, { alertsOrchestratorOnly: true })).toBe(false);
    });

    it('is the default when the config key is absent', () => {
      expect(shouldAlert({ id: WORKER_TAB }, orchestrated, {})).toBe(false);
      expect(shouldAlert({ id: ORCH_TAB }, orchestrated, undefined)).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, plain, null)).toBe(false);
    });
  });

  // The pre-dispatcher rule: every agent tab alerted, and workers were muted
  // only when the workspace had an orchestrator to handle them.
  describe('legacy rule (alertsOrchestratorOnly === false)', () => {
    it('alerts for every tab of a workspace without orchestration', () => {
      expect(shouldAlert({ id: ORCH_TAB }, plain, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, plain, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, undefined, { alertsOrchestratorOnly: false })).toBe(true);
    });

    it('alerts for the orchestrator and mutes workers when an orchestrator exists', () => {
      expect(shouldAlert({ id: ORCH_TAB }, orchestrated, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, orchestrated, { alertsOrchestratorOnly: false })).toBe(false);
    });

    it('alerts for every tab when orchestration is configured but disabled', () => {
      expect(shouldAlert({ id: WORKER_TAB }, disabledOrch, { alertsOrchestratorOnly: false })).toBe(true);
    });

    it('alerts for every tab when orchestration is enabled with no orchestrator tab', () => {
      const noTab = workspace({ enabled: true, orchestratorTabId: null });
      expect(shouldAlert({ id: WORKER_TAB }, noTab, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, noTab, { alertsOrchestratorOnly: true })).toBe(false);
    });
  });
});

describe('alertFor', () => {
  const base = {
    tabId: ORCH_TAB,
    workspaceId: 'ws-1',
    workspaceName: 'Epic',
    tabName: 'orchestrator',
    providerId: 'claude' as const,
    isOrchestrator: true,
    at: AT,
  };

  it('builds a needs-input alert with the existing push title and body', () => {
    expect(alertFor({ ...base, kind: 'needs-input', lastUserMessage: 'run the migration' })).toEqual({
      ...base,
      kind: 'needs-input',
      title: 'Input Required',
      body: 'run the migration',
    });
  });

  it('builds a review alert with the existing push title', () => {
    const alert = alertFor({ ...base, kind: 'review', lastUserMessage: null });
    expect(alert.title).toBe('Task Complete');
    expect(alert.body).toBe('orchestrator');
  });

  it('clamps the body to the first 100 characters of the last user message', () => {
    const alert = alertFor({ ...base, kind: 'review', lastUserMessage: 'x'.repeat(200) });
    expect(alert.body).toHaveLength(100);
  });

  it('falls back to the tab id when there is no message and no tab name', () => {
    expect(alertFor({ ...base, kind: 'review', tabName: '' }).body).toBe(ORCH_TAB);
  });

  it('uses the standup headline as the body of a standup-needs-human alert', () => {
    const alert = alertFor({ ...base, kind: 'standup-needs-human', headline: 'blocked on a schema decision' });
    expect(alert.kind).toBe('standup-needs-human');
    expect(alert.body).toBe('blocked on a schema decision');
  });

  it('builds liveness alerts from the event detail', () => {
    const stalled = alertFor({ ...base, kind: 'work-stalled', detail: 'probe "drain" reports no progress for ~19 min' });
    expect(stalled.title).toBe('Work Stalled');
    expect(stalled.body).toBe('probe "drain" reports no progress for ~19 min');

    const died = alertFor({ ...base, kind: 'bg-job-died', detail: 'pid 4242 exited with code 137' });
    expect(died.title).toBe('Background Job Died');
    expect(died.body).toBe('pid 4242 exited with code 137');

    const unknown = alertFor({ ...base, kind: 'bg-job-unknown', detail: 'pid 4242 exited with unknown status' });
    expect(unknown.title).toBe('Background Job Status Unknown');
    expect(unknown.body).toBe('pid 4242 exited with unknown status');
  });

  // Story 36: at 100 code points a line lost its options mid-word ("(b) follo") with no sign of the cut.
  it('a needs-decision alert keeps the question and its options: up to 400 code points, cut at a word with a trailing …', () => {
    const line = `w1 · ws-a: Which budget do we take for the epic, now that D2 and D7 do not fit? (a) raise the budget to 40 (b) follow on`;
    expect(alertFor({ ...base, kind: 'needs-decision', detail: line })).toMatchObject({ title: 'Decision needed: no Mission Control item', body: line });
    const long = `w1 · ws-a: ${'which rule do we ship '.repeat(30)}(a) base currency (b) transaction currency`;
    const body = alertFor({ ...base, kind: 'needs-decision', detail: long }).body;
    const points = Array.from(body);
    expect(points.length).toBeLessThanOrEqual(400);
    expect(points.length).toBeGreaterThan(380);
    expect(body.endsWith('…')).toBe(true);
    const kept = body.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
    expect(alertFor({ ...base, kind: 'needs-decision', detail: 'w1 · ws-a: Ship it?' }).body).toBe('w1 · ws-a: Ship it?');
  });

  it('a needs-decision body with no space to cut at is cut at 399 code points plus …, never inside a surrogate pair', () => {
    const body = alertFor({ ...base, kind: 'needs-decision', detail: '😀'.repeat(500) }).body;
    expect(Array.from(body)).toHaveLength(400);
    expect(body).toBe(`${'😀'.repeat(399)}…`);
  });

  it('the longest needs-decision body, at 4 UTF-8 bytes a code point, keeps the FCM data map under its budget', () => {
    const alert = { ...alertFor({ ...base, kind: 'needs-decision', detail: '😀'.repeat(500), tabName: 't'.repeat(60), workspaceName: 'w'.repeat(60) }), id: 'a-1', seq: 1 };
    const message = buildFcmMessage(alert, { agentSessionId: 's'.repeat(36), workspaceDir: `/home/${'d'.repeat(100)}` } as never, 'token');
    expect(fcmDataBytes(message.message.data)).toBeLessThanOrEqual(FCM_DATA_BUDGET_BYTES);
  });

  it('clamps liveness alert bodies and falls back to the tab name', () => {
    expect(alertFor({ ...base, kind: 'work-stalled', detail: 'x'.repeat(200) }).body).toHaveLength(100);
    expect(alertFor({ ...base, kind: 'bg-job-died', detail: null }).body).toBe('orchestrator');
    expect(alertFor({ ...base, kind: 'bg-job-unknown', detail: null }).body).toBe('orchestrator');
  });

  it('builds a flag alert from its detail, then its flag text, then the tab name, and carries the flag (ADR-0032)', () => {
    const flag = { source: 'flow' as const, rule: 'queue-long', subject: 'landing', text: 'landing holds 12 items (threshold 10)' };
    const alert = alertFor({ ...base, kind: 'flag', detail: 'worker: landing holds 12 items', flag });
    expect(alert.title).toBe('Flag Raised');
    expect(alert.body).toBe('worker: landing holds 12 items');
    expect(alert.flag).toEqual(flag);
    expect(alert.flag).not.toBe(flag);
    expect(alertFor({ ...base, kind: 'flag', flag }).body).toBe('landing holds 12 items (threshold 10)');
    expect(alertFor({ ...base, kind: 'flag' }).body).toBe('orchestrator');
    expect(alertFor({ ...base, kind: 'flag' })).not.toHaveProperty('flag');
  });

  it('cuts a flag body to 100 code points, never inside a surrogate pair, and keeps the full text on the flag', () => {
    const text = `${'🚦'.repeat(60)}${'x'.repeat(60)}`;
    const alert = alertFor({ ...base, kind: 'flag', flag: { source: 'flow', rule: 'meter-over', subject: 'm', text } });
    expect(Array.from(alert.body)).toHaveLength(100);
    expect(alert.body).toBe(`${'🚦'.repeat(60)}${'x'.repeat(40)}`);
    expect(alert.flag?.text).toBe(text);
    expect(alertFor({ ...base, kind: 'flag', detail: 'y'.repeat(100) }).body).toBe('y'.repeat(100));
    expect(alertFor({ ...base, kind: 'flag', detail: 'y'.repeat(101) }).body).toBe('y'.repeat(100));
  });

  it('describes a stall with the supplied detail', () => {
    const alert = alertFor({ ...base, kind: 'orchestrator-stalled', detail: 'idle 30 min, no workers' });
    expect(alert.title).toBe('Orchestrator Stalled');
    expect(alert.body).toBe('idle 30 min, no workers');
  });

  it('describes a stall without a detail', () => {
    expect(alertFor({ ...base, kind: 'orchestrator-stalled' }).body.length).toBeGreaterThan(0);
  });

  it('builds a bounded missing-orchestrator alert from its reason', () => {
    const alert = alertFor({ ...base, kind: 'orchestrator-missing', detail: 'x'.repeat(200) });
    expect(alert.title).toBe('Orchestrator Missing');
    expect(alert.body).toHaveLength(100);
  });
});

describe('standupAlertTabId', () => {
  const standup = (overrides: Partial<IWorkspaceStandup> = {}): Pick<IWorkspaceStandup, 'needsHuman' | 'state'> => ({
    needsHuman: false,
    state: 'on-track',
    ...overrides,
  });

  it('addresses the orchestrator tab when the tick needs a human', () => {
    expect(standupAlertTabId(standup({ needsHuman: true }), orchestrated, {})).toBe(ORCH_TAB);
  });

  it('stays silent when the tick needs nobody', () => {
    expect(standupAlertTabId(standup(), orchestrated, {})).toBeNull();
  });

  it('treats blocked and awaiting-human as needing a human', () => {
    expect(standupAlertTabId(standup({ state: 'blocked' }), orchestrated, {})).toBe(ORCH_TAB);
    expect(standupAlertTabId(standup({ state: 'awaiting-human' }), orchestrated, {})).toBe(ORCH_TAB);
    expect(standupAlertTabId(standup({ state: 'done' }), orchestrated, {})).toBeNull();
  });

  it('has nothing to address in a workspace without an orchestrator', () => {
    expect(standupAlertTabId(standup({ needsHuman: true }), plain, {})).toBeNull();
    expect(standupAlertTabId(standup({ needsHuman: true }), disabledOrch, {})).toBeNull();
  });

  it('still addresses the orchestrator with the orchestrator-only flag off', () => {
    expect(standupAlertTabId(standup({ needsHuman: true }), orchestrated, { alertsOrchestratorOnly: false })).toBe(ORCH_TAB);
  });
});

describe('isStallEpisodeEnd', () => {
  it('fires once on the last heartbeat of an episode', () => {
    const MAX = 3;
    let alerted = false;
    const fired: number[] = [];
    // One idle episode: three heartbeats, then the keeper stops beating.
    for (const beats of [1, 2, 3]) {
      if (isStallEpisodeEnd(beats, MAX, alerted)) {
        fired.push(beats);
        alerted = true;
      }
    }
    expect(fired).toEqual([3]);
  });

  it('does not fire again while the same episode is still exhausted', () => {
    expect(isStallEpisodeEnd(4, 3, true)).toBe(false);
  });

  it('fires again for a fresh episode once the keeper resets the flag', () => {
    expect(isStallEpisodeEnd(3, 3, false)).toBe(true);
  });

  it('stays quiet before the heartbeat budget is spent', () => {
    expect(isStallEpisodeEnd(1, 3, false)).toBe(false);
    expect(isStallEpisodeEnd(2, 3, false)).toBe(false);
  });
});

describe('alertFor kind attention-opened', () => {
  const source = (overrides: Partial<Parameters<typeof alertFor>[0]> = {}) => ({
    kind: 'attention-opened' as const,
    tabId: ORCH_TAB,
    workspaceId: 'ws-1',
    workspaceName: 'Epic',
    tabName: 'orchestrator',
    providerId: 'claude' as const,
    isOrchestrator: true,
    at: AT,
    itemId: 'item-1',
    itemTitle: '  Approve the go-live?  ',
    ...overrides,
  });

  it('titles the alert for Mission Control, uses the trimmed item title as body and carries the itemId', () => {
    expect(alertFor(source())).toEqual({
      kind: 'attention-opened',
      tabId: ORCH_TAB,
      workspaceId: 'ws-1',
      workspaceName: 'Epic',
      tabName: 'orchestrator',
      providerId: 'claude',
      isOrchestrator: true,
      title: 'Mission Control: answer needed',
      body: 'Approve the go-live?',
      at: AT,
      itemId: 'item-1',
    });
  });

  it('cuts a long title to 100 code points', () => {
    expect(alertFor(source({ itemTitle: 'x'.repeat(150) })).body).toBe('x'.repeat(100));
  });

  it('falls back to the workspace name when the item has no title', () => {
    expect(alertFor(source({ itemTitle: '   ' })).body).toBe('Epic');
    expect(alertFor(source({ itemTitle: null, workspaceName: '' })).body).toBe('orchestrator');
    expect(alertFor(source({ itemTitle: null, workspaceName: '', tabName: '' })).body).toBe(ORCH_TAB);
  });

  it('carries no itemId when none is given', () => {
    expect(alertFor(source({ itemId: undefined }))).not.toHaveProperty('itemId');
  });

  it('carries the question summary on attention-opened only (story 33 AC 3)', () => {
    const question = { formatVersion: 2 as const, decision: 'Ship?', answerType: 'confirm' as const, revision: 1, options: [] };
    expect(alertFor(source({ question })).question).toEqual(question);
    expect(alertFor(source())).not.toHaveProperty('question');
    expect(alertFor({ ...source({ question }), kind: 'review' })).not.toHaveProperty('question');
  });
});
