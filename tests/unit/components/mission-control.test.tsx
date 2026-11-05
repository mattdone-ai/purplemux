import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionControlDashboard from '@/components/features/mission-control/mission-control-dashboard';
import {
  adoptCurrentMissionItem,
  createMissionDraft,
  deliveryStatus,
  editMissionDraft,
  isMissionHumanInboxItem,
  mergeMissionRefreshSnapshot,
  missionWorkspaceIssuePresentation,
  missionDraftRequest,
  reconcileMissionDraftWithItem,
  shouldApplyMissionSnapshot,
} from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAttentionItem,
  IMissionSnapshot,
} from '@/types/mission-control';

const now = 2_000_000;

const item = (over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem => ({
  id: 'question-1',
  workspaceId: 'ws-1',
  runId: 'run-1',
  revision: 1,
  state: 'open',
  kind: 'question',
  title: 'Choose a release path',
  context: 'The deployment is ready for a decision.',
  storyIds: ['PAY-42'],
  options: [
    { id: 'staged', label: 'Staged rollout', description: 'Start with one tenant.' },
    { id: 'all', label: 'All tenants' },
  ],
  recommendation: 'Use a staged rollout.',
  blockingScope: 'story',
  canContinue: true,
  evidence: { source: 'agent', sourceId: 'event-1', observedAt: now - 10_000, confidence: 'confirmed' },
  answerId: null,
  resolution: null,
  humanReview: {
    humanNeed: 'decision',
    humanReason: 'Choose the release path that matches the product risk tolerance.',
    handling: 'The orchestrator checked the rollout plan and cannot choose product risk tolerance.',
    reviewerTabId: 'tab-1',
    binding: {
      tabId: 'tab-1', providerId: 'codex', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1',
    },
    eventId: 'event-review-1',
    reviewedAt: now - 10_000,
  },
  candidateReason: null,
  class: null,
  defaultOptionId: null,
  autoAnswer: null,
  evidenceLinks: [],
  lint: [],
  changes: null,
  createdAt: now - 60_000,
  updatedAt: now - 10_000,
  ...over,
});

const snapshot = (): IMissionSnapshot => ({
  schemaVersion: 1,
  cursor: 8,
  generatedAt: now,
  workspaces: [{
    workspaceId: 'ws-1',
    name: 'Payments',
    orphaned: false,
    activity: 'active',
    agents: [{
      tabId: 'tab-1',
      name: 'orchestrator',
      providerId: 'codex',
      sessionId: 'session-1',
      cliState: 'busy',
      alive: true,
      lastActivityAt: now - 2_000,
    }],
    runIds: ['run-1'],
    openItems: 1,
    awaitingAcknowledgement: 1,
    lastActivityAt: now - 2_000,
    lastProgressAt: now - 30_000,
    stale: false,
    evidence: { source: 'harness', sourceId: 'tab-1', observedAt: now, confidence: 'confirmed' },
  }],
  runs: [{
    id: 'run-1',
    workspaceId: 'ws-1',
    revision: 3,
    objective: 'Ship durable answer delivery',
    epic: { id: 'EP-9', title: 'Mission Control', url: 'https://example.test/epic/9' },
    phase: 'implementation',
    state: 'running',
    nextStep: 'Verify the responsive UI',
    binding: null,
    evidence: { source: 'agent', sourceId: 'run-event', observedAt: now, confidence: 'confirmed' },
    closeoutPending: true,
    storyCounts: { total: 5, done: 3, blocked: 1 },
    lastProgressAt: now - 30_000,
    createdAt: now - 600_000,
    updatedAt: now,
  }],
  items: [
    item(),
    item({
      id: 'candidate-1', state: 'candidate', title: 'Historical blocker?', humanReview: null,
      candidateReason: 'historical-context',
      evidence: { source: 'bootstrap', sourceId: 'candidate', observedAt: now, confidence: 'provisional' },
    }),
    item({ id: 'answered-1', state: 'answered', title: 'Choose the database', answerId: 'answer-1', revision: 2 }),
  ],
  answers: [{
    id: 'answer-1',
    source: null,
    submissionId: '11111111-1111-4111-8111-111111111111',
    expectedRevision: 1,
    appliedRevision: 1,
    optionIds: ['staged'],
    text: 'Proceed carefully.',
    actionCompleted: false,
    workspaceId: 'ws-1',
    runId: 'run-1',
    itemId: 'answered-1',
    actor: 'user',
    createdAt: now,
  }],
  deliveries: [{
    id: 'delivery-1',
    answerId: 'answer-1',
    workspaceId: 'ws-1',
    runId: 'run-1',
    binding: null,
    state: 'submitted',
    attempts: 1,
    nextAttemptAt: null,
    lastError: null,
    submittedAt: now,
    acknowledgedAt: null,
    updatedAt: now,
  }],
  recentEvents: [{
    seq: 8,
    id: 'event-8',
    schemaVersion: 1,
    workspaceId: 'ws-1',
    runId: 'run-1',
    entityId: 'question-1',
    revision: 1,
    type: 'attention.opened',
    payload: {},
    producerAt: now,
    committedAt: now,
  }],
  bootstrap: null,
});

describe('Mission Control draft lifecycle', () => {
  it('retains the submission UUID for a retry and replaces it after a deliberate edit', () => {
    const initial = createMissionDraft(item(), '11111111-1111-4111-8111-111111111111');
    const edited = editMissionDraft(initial, { text: 'Use staged rollout' }, 'unused');
    const failed = { ...edited, status: 'error' as const, hasAttempted: true };

    expect(missionDraftRequest(failed).submissionId).toBe('11111111-1111-4111-8111-111111111111');

    const changed = editMissionDraft(failed, { text: 'Use staged rollout for tenant A' }, '22222222-2222-4222-8222-222222222222');
    expect(changed.submissionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(changed.hasAttempted).toBe(false);
  });

  it('keeps stale draft text while adopting the current question revision', () => {
    const stale = {
      ...createMissionDraft(item(), '11111111-1111-4111-8111-111111111111'),
      optionIds: ['staged'],
      text: 'Keep this draft',
      hasAttempted: true,
      status: 'conflict' as const,
      currentItem: item({ revision: 2, title: 'Choose the revised release path', options: [{ id: 'all', label: 'All tenants' }] }),
    };

    const adopted = adoptCurrentMissionItem(stale, '22222222-2222-4222-8222-222222222222');
    expect(adopted.text).toBe('Keep this draft');
    expect(adopted.optionIds).toEqual([]);
    expect(adopted.expectedRevision).toBe(2);
    expect(adopted.submissionId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('preserves the authoritative server question while a conflicted draft is edited', () => {
    const currentItem = item({ revision: 2, title: 'Current server question' });
    const conflicted = {
      ...createMissionDraft(item(), '11111111-1111-4111-8111-111111111111'),
      text: 'Stale answer',
      hasAttempted: true,
      status: 'conflict' as const,
      currentItem,
    };

    const edited = editMissionDraft(
      conflicted,
      { text: 'Edited stale answer' },
      '22222222-2222-4222-8222-222222222222',
    );

    expect(edited.status).toBe('conflict');
    expect(edited.currentItem).toBe(currentItem);
    expect(edited.expectedRevision).toBe(1);
    expect(edited.submissionId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('retains an empty same-ID draft and submission ID when an open item moves to workspace review', () => {
    const draft = createMissionDraft(item(), '11111111-1111-4111-8111-111111111111');
    const candidate = item({
      revision: 2,
      state: 'candidate',
      humanReview: null,
      candidateReason: 'legacy-review',
    });

    const reconciled = reconcileMissionDraftWithItem(draft, candidate);

    expect(reconciled).toMatchObject({
      submissionId: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 1,
      status: 'conflict',
      currentItem: candidate,
    });
  });

  it('does not apply a snapshot older than the one already displayed', () => {
    const current = snapshot();
    expect(shouldApplyMissionSnapshot(current, { ...current, cursor: 7, generatedAt: now + 1_000 })).toBe(false);
    expect(shouldApplyMissionSnapshot(current, { ...current, cursor: 8, generatedAt: now + 1_000 })).toBe(true);
  });

  it.each([
    ['an older bootstrap', {
      id: 'bootstrap-old', boundarySeq: 8, createdAt: now - 1_000, entries: [],
    }],
    ['no bootstrap', null],
  ])('preserves a bootstrap mutation that interleaved with a GET containing %s', (_label, incomingBootstrap) => {
    const authoritativeBootstrap = {
      id: 'bootstrap-new', boundarySeq: 8, createdAt: now + 1_000, entries: [],
    };
    const current = { ...snapshot(), bootstrap: authoritativeBootstrap };
    const incoming = {
      ...snapshot(),
      generatedAt: now + 2_000,
      bootstrap: incomingBootstrap,
    };

    const merged = mergeMissionRefreshSnapshot(current, incoming, 4, 5);

    expect(merged.bootstrap).toBe(authoritativeBootstrap);
    expect(merged.generatedAt).toBe(now + 2_000);
  });

  it('distinguishes saved, delivered, and acknowledged states', () => {
    expect(deliveryStatus({ ...snapshot().deliveries[0], state: 'queued' }).label).toContain('Saved');
    expect(deliveryStatus(snapshot().deliveries[0]).label).toContain('Delivered');
    expect(deliveryStatus({ ...snapshot().deliveries[0], state: 'acknowledged' }).label).toContain('Acknowledged');
  });

  it('requires an explicit human review for the actionable inbox', () => {
    const reviewed = item();
    expect(isMissionHumanInboxItem(reviewed)).toBe(true);
    expect(isMissionHumanInboxItem({ ...reviewed, humanReview: null })).toBe(false);
    expect(isMissionHumanInboxItem({
      ...reviewed,
      humanReview: {
        humanNeed: 'none',
        handling: 'The orchestrator can handle this from existing instructions.',
        reviewerTabId: 'tab-1',
        binding: reviewed.humanReview!.binding,
        eventId: 'event-none',
        reviewedAt: now,
      },
    })).toBe(false);
  });

  it('describes migrated review and workspace handling distinctly', () => {
    expect(missionWorkspaceIssuePresentation(item({
      state: 'candidate', humanReview: null, candidateReason: 'legacy-review',
    }))).toEqual({
      badge: 'Orchestrator review required',
      explanation: 'Previously shown in Needs you. Awaiting review of whether your input is required.',
    });
    expect(missionWorkspaceIssuePresentation(item({
      state: 'candidate',
      candidateReason: 'workspace-issue',
      humanReview: {
        humanNeed: 'none',
        handling: 'The orchestrator will apply the existing rollout policy.',
        reviewerTabId: 'tab-1',
        binding: item().humanReview!.binding,
        eventId: 'event-handled',
        reviewedAt: now,
      },
    }))).toMatchObject({
      badge: 'Orchestrator handling',
      explanation: 'The orchestrator will apply the existing rollout policy.',
    });
  });
});

describe('Mission Control dashboard', () => {
  it('leaves the inbox to the default view, keeps candidates separate, and exposes honest delivery state', () => {
    const data = snapshot();
    data.bootstrap = {
      id: 'bootstrap-1',
      boundarySeq: 8,
      createdAt: now,
      entries: [{
        workspaceId: 'ws-1',
        runId: 'run-1',
        binding: null,
        state: 'confirmed',
        reason: null,
        updatedAt: now,
      }],
    };
    const open = data.items[0];
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [open.id]: createMissionDraft(open, '11111111-1111-4111-8111-111111111111') }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(html).not.toContain('id="needs-you-heading"');
    expect(html).not.toContain('Why you&#x27;re needed');
    expect(html.indexOf('Answer delivery')).toBeLessThan(html.indexOf('Workspaces'));
    expect(html.indexOf('Workspaces')).toBeLessThan(html.indexOf('Workspace issues'));
    expect(html).toContain('Delivered · awaiting acknowledgement');
    expect(html).toContain('Workspace issues');
    expect(html).toContain('Orchestrator review required');
    expect(html).toContain('Epic closeout pending');
    expect(html).toContain('Answer delivery, active work, and workspace issues across all workspaces.');
    expect(html).toContain('1 confirmed');
    expect(html).toContain('Discover again');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });

  it('shows a delivery or bootstrap waiting in the inbox as waiting, and a held one with its inbox reason (story 12)', () => {
    const render = (data: ReturnType<typeof snapshot>) => renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{}}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );
    const waiting = snapshot();
    waiting.deliveries[0] = { ...waiting.deliveries[0], state: 'queued', lastError: 'inbox:i-waiting1', submittedAt: null };
    waiting.bootstrap = {
      id: 'bootstrap-1', boundarySeq: 8, createdAt: now,
      entries: [{ workspaceId: 'ws-1', runId: 'run-1', binding: null, state: 'queued', reason: 'inbox:i-boot1', updatedAt: now }],
    };
    const waitingHtml = render(waiting);
    expect(waitingHtml).toContain('Waiting in the orchestrator&#x27;s inbox until its composer is free');
    expect(waitingHtml).toContain('Waiting in the tab inbox');
    expect(waitingHtml).not.toContain('inbox:i-');
    expect(waitingHtml).not.toMatch(/Inbox:i/);

    const held = snapshot();
    held.deliveries[0] = { ...held.deliveries[0], state: 'held', lastError: 'composer-not-ready:busy (undelivered after 24 h)', submittedAt: null };
    const heldHtml = render(held);
    expect(heldHtml).toContain('composer-not-ready:busy (undelivered after 24 h)');
    expect(heldHtml).not.toContain('Waiting in the orchestrator');
  });

  it('keeps a migrated same-ID draft with its workspace issue and disables submission', () => {
    const migrated = item({
      id: 'legacy-question',
      revision: 2,
      state: 'candidate',
      title: 'Review the old escalation',
      humanReview: null,
      candidateReason: 'legacy-review',
    });
    const oldOpen = item({ id: migrated.id, revision: 1, title: migrated.title });
    const draft = {
      ...createMissionDraft(oldOpen, '11111111-1111-4111-8111-111111111111'),
      text: 'Keep this answer draft',
      status: 'conflict' as const,
      currentItem: migrated,
      hasAttempted: true,
    };
    const data = { ...snapshot(), items: [migrated], answers: [], deliveries: [] };
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [migrated.id]: draft }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(html).toContain('Previously shown in Needs you. Awaiting review of whether your input is required.');
    expect(html).toContain('Saved answer draft');
    expect(html).toContain('Keep this answer draft');
    expect(html).toContain('data-disabled=""');
    expect(draft.submissionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('shows a competing-device answer draft as a saved draft with submission disabled', () => {
    const open = item({ id: 'competing-answer' });
    const original = {
      ...createMissionDraft(open, '11111111-1111-4111-8111-111111111111'),
      optionIds: ['staged'],
      text: 'Keep this competing answer',
    };
    const answered = item({
      id: open.id,
      revision: 2,
      state: 'answered',
      answerId: 'other-answer',
    });
    const retained = reconcileMissionDraftWithItem(original, answered)!;
    const data = { ...snapshot(), items: [answered], answers: [], deliveries: [] };
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [answered.id]: retained }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(retained).toMatchObject({
      submissionId: '11111111-1111-4111-8111-111111111111',
      text: 'Keep this competing answer',
      currentItem: answered,
    });
    expect(html).toContain('Saved drafts');
    expect(html).toContain('Keep this competing answer');
    expect(html).toContain('The item changed elsewhere. This draft is retained for reference and cannot be submitted.');
    expect(html).toContain('data-disabled=""');
  });

  it('keeps a migrated draft visible and disabled after the item is cancelled', () => {
    const oldOpen = item({ id: 'cancelled-migration' });
    const original = {
      ...createMissionDraft(oldOpen, '22222222-2222-4222-8222-222222222222'),
      text: 'Keep this migrated answer',
    };
    const migrated = item({
      id: oldOpen.id,
      revision: 2,
      state: 'candidate',
      humanReview: null,
      candidateReason: 'legacy-review',
    });
    const afterMigration = reconcileMissionDraftWithItem(original, migrated)!;
    const cancelled = item({
      id: oldOpen.id,
      revision: 3,
      state: 'cancelled',
      humanReview: null,
      candidateReason: 'legacy-review',
    });
    const retained = reconcileMissionDraftWithItem(afterMigration, cancelled)!;
    const data = { ...snapshot(), items: [cancelled], answers: [], deliveries: [] };
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [cancelled.id]: retained }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(retained).toMatchObject({
      submissionId: '22222222-2222-4222-8222-222222222222',
      text: 'Keep this migrated answer',
      currentItem: cancelled,
    });
    expect(html).toContain('Saved drafts');
    expect(html).toContain('Keep this migrated answer');
    expect(html).toContain('data-disabled=""');
  });

  it('uses a single-column, overflow-safe base layout suitable for 320px screens', () => {
    const data = snapshot();
    const open = data.items[0];
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [open.id]: createMissionDraft(open) }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(html).toContain('px-3');
    expect(html).toContain('min-w-0');
    expect(html).toContain('w-full shrink-0 sm:w-auto');
    expect(html).toContain('lg:grid-cols-2');
  });
});
