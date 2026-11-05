import { describe, expect, it } from 'vitest';
import { KODIT_WINDOW_MS, koditDrop, koditNeedsRateLimit, koditRate, parseKoditLog } from '@/lib/curator-kodit';

// AC 7: the enrichment log as enrich-log.sh writes it, every 3 h.
const LOG = [
  '2026-10-31T09:17:02Z docs=306987/468828 summaries=1843986',
  'garbage line',
  '2026-11-01T09:17:02Z docs=324873/468828 summaries=1944686',
  '2026-11-03T09:17:03Z docs=368288/468828 summaries=2143027',
  '',
].join('\n');

const at = (iso: string) => Date.parse(iso);

describe('kodit enrichment rate (AC 7)', () => {
  it('parses the samples and skips anything else', () => {
    expect(parseKoditLog(LOG)).toEqual([
      { at: at('2026-10-31T09:17:02Z'), docs: 306987, summaries: 1843986 },
      { at: at('2026-11-01T09:17:02Z'), docs: 324873, summaries: 1944686 },
      { at: at('2026-11-03T09:17:03Z'), docs: 368288, summaries: 2143027 },
    ]);
  });

  it('rates docs and summaries per hour between the first and last sample in the window (the measured 3-day before)', () => {
    const to = at('2026-11-03T09:20:00Z');
    const rate = koditRate(parseKoditLog(LOG), to - KODIT_WINDOW_MS - 5 * 60_000, to);
    expect(rate.samples).toBe(3);
    expect(rate.docsPerHour).toBeCloseTo(851.4, 1);
    expect(rate.summariesPerHour).toBeCloseTo(4153.3, 1);
  });

  it('one sample or none is not a rate', () => {
    const samples = parseKoditLog(LOG);
    expect(koditRate(samples, at('2026-11-02T00:00:00Z'), at('2026-11-04T00:00:00Z'))).toMatchObject({ docsPerHour: null, samples: 1 });
    expect(koditRate([], 0, 1)).toMatchObject({ docsPerHour: null, summariesPerHour: null, samples: 0 });
  });

  it('a fall above 20% rate-limits the client; at or under 20%, or unmeasured, it does not', () => {
    const before = { from: 0, to: 1, docsPerHour: 1000, summariesPerHour: 1, samples: 2 };
    expect(koditDrop(before, { ...before, docsPerHour: 790 })).toBeCloseTo(0.21);
    expect(koditNeedsRateLimit(koditDrop(before, { ...before, docsPerHour: 790 }))).toBe(true);
    expect(koditNeedsRateLimit(koditDrop(before, { ...before, docsPerHour: 800 }))).toBe(false);
    expect(koditNeedsRateLimit(koditDrop(before, { ...before, docsPerHour: 1200 }))).toBe(false);
    expect(koditDrop(before, { ...before, docsPerHour: null })).toBeNull();
    expect(koditDrop({ ...before, docsPerHour: 0 }, before)).toBeNull();
    expect(koditNeedsRateLimit(null)).toBe(false);
  });
});
