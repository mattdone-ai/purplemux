import { describe, expect, it } from 'vitest';
import { parseStandupReport } from '@/lib/standup';

const WS = 'ws-test';
const AT = 1_700_000_000_000;

describe('parseStandupReport', () => {
  it('accepts a full report and stamps workspace + time', () => {
    const standup = parseStandupReport({
      state: 'on-track',
      headline: '4/7 stories done',
      items: [
        { label: 'story-01', status: 'done' },
        { label: 'story-02', status: 'active', note: 'tests running' },
      ],
      blockers: [{ what: 'schema decision', needs: 'pick option A or B' }],
      needsHuman: true,
      next: ['review story-02'],
    }, WS, AT);

    expect(standup).toMatchObject({
      workspaceId: WS,
      at: AT,
      state: 'on-track',
      headline: '4/7 stories done',
      needsHuman: true,
      next: ['review story-02'],
    });
    expect(standup?.items).toHaveLength(2);
    expect(standup?.items[1].note).toBe('tests running');
    expect(standup?.blockers[0]).toEqual({ what: 'schema decision', needs: 'pick option A or B' });
  });

  it('rejects a missing or unknown state', () => {
    expect(parseStandupReport({ headline: 'x' }, WS, AT)).toBeNull();
    expect(parseStandupReport({ state: 'cruising', headline: 'x' }, WS, AT)).toBeNull();
  });

  it('rejects a missing or empty headline', () => {
    expect(parseStandupReport({ state: 'done' }, WS, AT)).toBeNull();
    expect(parseStandupReport({ state: 'done', headline: '   ' }, WS, AT)).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(parseStandupReport(null, WS, AT)).toBeNull();
    expect(parseStandupReport('done', WS, AT)).toBeNull();
  });

  it('defaults needsHuman from state when not a boolean', () => {
    expect(parseStandupReport({ state: 'blocked', headline: 'x' }, WS, AT)?.needsHuman).toBe(true);
    expect(parseStandupReport({ state: 'awaiting-human', headline: 'x' }, WS, AT)?.needsHuman).toBe(true);
    expect(parseStandupReport({ state: 'on-track', headline: 'x' }, WS, AT)?.needsHuman).toBe(false);
    expect(parseStandupReport({ state: 'blocked', headline: 'x', needsHuman: false }, WS, AT)?.needsHuman).toBe(false);
  });

  it('drops malformed rows instead of rejecting the tick', () => {
    const standup = parseStandupReport({
      state: 'at-risk',
      headline: 'x',
      items: [
        { label: 'ok', status: 'todo' },
        { label: 'bad status', status: 'paused' },
        { status: 'done' },
        'not an object',
      ],
      blockers: [{ what: 'ok' }, { needs: 'no what' }, 42],
      next: ['ok', 7, ''],
    }, WS, AT);

    expect(standup?.items).toEqual([{ label: 'ok', status: 'todo' }]);
    expect(standup?.blockers).toEqual([{ what: 'ok', needs: 'unspecified' }]);
    expect(standup?.next).toEqual(['ok']);
  });

  it('clamps overlong text and caps list lengths', () => {
    const long = 'a'.repeat(500);
    const standup = parseStandupReport({
      state: 'on-track',
      headline: long,
      items: Array.from({ length: 40 }, (_, i) => ({ label: `item-${i}`, status: 'todo' })),
    }, WS, AT);

    expect(standup?.headline.length).toBe(200);
    expect(standup?.headline.endsWith('…')).toBe(true);
    expect(standup?.items).toHaveLength(30);
  });
});

