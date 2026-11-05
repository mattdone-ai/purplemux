import { beforeEach, describe, expect, it } from 'vitest';
import useOrchestrationStore from '@/hooks/use-orchestration-store';
import type { IOrchestrationNudge } from '@/types/status';

const nudge = (id: string, extra: Partial<IOrchestrationNudge> = {}): IOrchestrationNudge => ({
  id, workspaceId: 'ws-1', tabId: 'w', tabName: 'w', kind: 'turn-marker', message: id, at: Number(id.slice(3)),
  delivered: false, wakeClass: 'digest', ...extra,
});

describe('the nudge store (ADR-0035)', () => {
  beforeEach(() => useOrchestrationStore.setState({ nudges: [] }));

  it('replaces a held nudge in place when its digest delivery is broadcast with the same id', () => {
    const { addNudge } = useOrchestrationStore.getState();
    addNudge(nudge('te-1'));
    addNudge(nudge('te-2', { wakeClass: 'urgent', delivered: true }));
    addNudge(nudge('te-1', { delivered: true }));
    expect(useOrchestrationStore.getState().nudges.map((n) => [n.id, n.delivered])).toEqual([['te-1', true], ['te-2', true]]);
  });

  it('a fetched list updates the ids it already holds and adds the rest; an unchanged list changes nothing', () => {
    const { addNudge, mergeNudges } = useOrchestrationStore.getState();
    addNudge(nudge('te-1'));
    mergeNudges([nudge('te-1', { delivered: true }), nudge('te-3')]);
    expect(useOrchestrationStore.getState().nudges.map((n) => [n.id, n.delivered])).toEqual([['te-1', true], ['te-3', false]]);
    const before = useOrchestrationStore.getState().nudges;
    mergeNudges([nudge('te-3')]);
    expect(useOrchestrationStore.getState().nudges).toBe(before);
  });
});
