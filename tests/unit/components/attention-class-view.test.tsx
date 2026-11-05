import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AnswersByClassStrip,
  AttentionClassBadge,
  statedDefaultLabel,
} from '@/components/features/mission-control/attention-class-view';
import type { IMissionAttentionItem } from '@/types/mission-control';

const item = (over: Partial<IMissionAttentionItem>): IMissionAttentionItem => ({
  id: 'q', workspaceId: 'ws', runId: 'run', revision: 1, state: 'open', kind: 'question', title: 'T', context: 'C',
  storyIds: [], options: [{ id: 'yes', label: 'Yes, raise it' }], recommendation: null, blockingScope: 'none', canContinue: true,
  evidence: { source: 'agent', sourceId: 'e', observedAt: 1, confidence: 'confirmed' }, answerId: null, resolution: null,
  humanReview: null, candidateReason: null, class: null, defaultOptionId: null, autoAnswer: null, evidenceLinks: [], lint: [], changes: null, createdAt: 1, updatedAt: 1, ...over,
});

describe('AttentionClassBadge', () => {
  it.each([
    ['money', 'Money'], ['irreversible', 'Irreversible'], ['scope', 'Scope'], ['bookkeeping', 'Bookkeeping'],
  ] as const)('labels %s', (value, label) => {
    expect(renderToStaticMarkup(<AttentionClassBadge value={value} />)).toMatch(new RegExp(`data-attention-class="${value}">${label}<`));
  });

  it('labels a null class Unclassified with no served detail', () => {
    const html = renderToStaticMarkup(<AttentionClassBadge value={null} />);
    expect(html).toMatch(/data-attention-class="unclassified">Unclassified</);
    expect(html).not.toContain('title=');
  });
});

describe('statedDefaultLabel', () => {
  it('names the option label, never the raw ID', () => {
    expect(statedDefaultLabel(item({ defaultOptionId: 'yes' }))).toBe('Yes, raise it');
    expect(statedDefaultLabel(item({ defaultOptionId: 'gone' }))).toBe('an option no longer offered');
    expect(statedDefaultLabel(item({}))).toBeNull();
  });
});

describe('AnswersByClassStrip', () => {
  it('spans the 7 UTC days ending on the snapshot day, whatever the hour', () => {
    const lateUtc = Date.UTC(2026, 9, 27, 23, 59, 59);
    const html = renderToStaticMarkup(<AnswersByClassStrip rows={[]} generatedAt={lateUtc} />);
    expect(html).toContain('data-strip-cell="2026-10-21:money"');
    expect(html).toContain('data-strip-cell="2026-10-27:unclassified"');
    expect(html).not.toContain('2026-10-20');
    expect(html).not.toContain('2026-10-28');
    expect(html.match(/data-strip-cell=/g)).toHaveLength(35);
  });

  it('counts an unknown served class under Unclassified', () => {
    const html = renderToStaticMarkup(<AnswersByClassStrip
      rows={[{ day: '2026-10-27', class: 'urgent' as never, by: 'human', count: 2 }, { day: '2026-10-27', class: 'unclassified', by: 'human', count: 1 }]}
      generatedAt={Date.UTC(2026, 9, 27, 1)}
    />);
    expect(html).toContain('data-strip-cell="2026-10-27:unclassified">3<');
    expect(html).not.toContain('urgent');
  });

  it('says not available, never zeros, when the server sends no answersByClass', () => {
    const html = renderToStaticMarkup(<AnswersByClassStrip rows={undefined} generatedAt={1} />);
    expect(html).toContain('not available');
    expect(html).not.toContain('>0<');
  });
});
