import { describe, expect, it } from 'vitest';
import { normalizeMissionItem, normalizeMissionSnapshot } from '@/hooks/use-mission-control';
import type { IMissionAttentionItem, IMissionSnapshot } from '@/types/mission-control';

// ADR-0031 rollback case: a browser keeps polling a rolled-back server, whose items omit both keys.

const item = (over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem => ({
  id: 'q', workspaceId: 'ws', runId: 'run', revision: 1, state: 'open', kind: 'question', title: 'T', context: 'C',
  storyIds: [], options: [{ id: 'yes', label: 'Yes' }], recommendation: null, blockingScope: 'none', canContinue: true,
  evidence: { source: 'agent', sourceId: 'e', observedAt: 1, confidence: 'confirmed' }, answerId: null, resolution: null,
  humanReview: null, candidateReason: null, class: null, defaultOptionId: null, autoAnswer: null, evidenceLinks: [], lint: [], changes: null, createdAt: 1, updatedAt: 1, ...over,
});

const legacy = (): IMissionAttentionItem => {
  const { class: ignoredClass, defaultOptionId: ignoredDefault, autoAnswer: ignoredAutoAnswer, ...shaped } = item();
  void ignoredClass;
  void ignoredDefault;
  void ignoredAutoAnswer;
  return shaped as IMissionAttentionItem;
};

describe('normalizeMissionItem', () => {
  it('maps absent class, defaultOptionId and autoAnswer to null', () => {
    const normalized = normalizeMissionItem(legacy());
    expect(normalized.class).toBeNull();
    expect(normalized.defaultOptionId).toBeNull();
    expect(normalized.autoAnswer).toBeNull();
    expect(normalized).toEqual(item());
  });

  it('keeps served values unchanged', () => {
    const autoAnswer = { rule: 'attention.auto-answer.bookkeeping-minutes', ruleVersion: 2, appliedOptionId: 'yes', at: 5, note: 'N' };
    expect(normalizeMissionItem(item({ class: 'bookkeeping', defaultOptionId: 'yes', autoAnswer })))
      .toMatchObject({ class: 'bookkeeping', defaultOptionId: 'yes', autoAnswer });
  });
});

describe('normalizeMissionSnapshot', () => {
  it('normalizes every item and leaves an absent answersByClass absent', () => {
    const snapshot = {
      schemaVersion: 1, cursor: 1, generatedAt: 1, workspaces: [], runs: [], items: [legacy(), item({ id: 'b', class: 'scope' })],
      answers: [], deliveries: [], recentEvents: [], bootstrap: null,
    } as IMissionSnapshot;
    const normalized = normalizeMissionSnapshot(snapshot);
    expect(normalized.items.map((entry) => [entry.class, entry.defaultOptionId])).toEqual([[null, null], ['scope', null]]);
    expect(normalized).not.toHaveProperty('answersByClass');
    expect(normalized).not.toHaveProperty('autoAnswered');
  });
});
