import { describe, expect, it } from 'vitest';
import {
  STANDUP_DUE_DEFAULT_MS,
  buildStandupDueLine,
  parseStandupDueMinutes,
  parseStandupReport,
  standupDueBucketMs,
} from '@/lib/standup';

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

const MIN = 60_000;

describe('standup due (story hfl2-10)', () => {
  it('defaults to 45 min', () => {
    expect(STANDUP_DUE_DEFAULT_MS).toBe(45 * MIN);
  });

  it.each([
    ['45', 45 * MIN], ['0', 0], [' 90 ', 90 * MIN], ['0.05', 3_000], ['1440', 1440 * MIN],
  ])('reads %j as %d ms; 0 is valid and means off (AC 3)', (value, ms) => {
    expect(parseStandupDueMinutes(value)).toBe(ms);
  });

  it.each([null, undefined, '', '-1', '1441', 'off', '45m', '1e3'])('refuses %j: the default applies', (value) => {
    expect(parseStandupDueMinutes(value)).toBeNull();
  });

  it('puts an age in its bucket: due, then each doubling of it (AC 2)', () => {
    const due = 45 * MIN;
    expect(standupDueBucketMs(44 * MIN, due)).toBeNull();
    expect(standupDueBucketMs(45 * MIN, due)).toBe(45 * MIN);
    expect(standupDueBucketMs(89 * MIN, due)).toBe(45 * MIN);
    expect(standupDueBucketMs(90 * MIN, due)).toBe(90 * MIN);
    expect(standupDueBucketMs(179 * MIN, due)).toBe(90 * MIN);
    expect(standupDueBucketMs(180 * MIN, due)).toBe(180 * MIN);
    expect(standupDueBucketMs(400 * MIN, due)).toBe(360 * MIN);
  });

  it('has no bucket when the line is off (dueMin 0) or the age is not a number (AC 3)', () => {
    expect(standupDueBucketMs(10_000 * MIN, 0)).toBeNull();
    expect(standupDueBucketMs(Number.NaN, 45 * MIN)).toBeNull();
  });

  it('writes the one line the orchestrator acts on (AC 1)', () => {
    expect(buildStandupDueLine('ws-a', 61 * MIN + 59_000, AT)).toBe('standup due: last posted 61 min ago (purplemux standup report -w ws-a)');
  });

  it('never claims a last post a workspace with no standup does not have', () => {
    expect(buildStandupDueLine('ws-a', 47 * MIN, null)).toBe('standup due: none posted in the 47 min since the run started (purplemux standup report -w ws-a)');
  });
});
