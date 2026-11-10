import { KODIT_DROP_LIMIT } from '@/lib/curator';
import type { ICuratorKoditWindow, TCuratorKoditCheck } from '@/types/curator';

// kodit's enrichment rate (ADR-0038 §7), from `~/stacks/mcp-server/enrich-history.log` on the host that runs kodit: one
// line every 3 h from `enrich-log.sh`, `<ISO time> docs=<indexed>/<total> summaries=<count>`.

/** The ssh host that holds the kodit log, from `PMUX_KODIT_LOG_HOST`; null (unset or blank) means no kodit check. */
export const koditLogHost = (env: Readonly<Record<string, string | undefined>> = process.env): string | null => env.PMUX_KODIT_LOG_HOST?.trim() || null;

export const KODIT_NOT_CONFIGURED = 'PMUX_KODIT_LOG_HOST is not set in the server environment, so the kodit check (ADR-0038 §7) does not run';

/** The check's configuration as the status reports it: the host, or why there is none. There is no default host. */
export const koditCheckConfig = (env: Readonly<Record<string, string | undefined>> = process.env): TCuratorKoditCheck => {
  const host = koditLogHost(env);
  return host === null ? { state: 'not-configured', reason: KODIT_NOT_CONFIGURED } : { state: 'configured', host };
};

export const KODIT_LOG_PATH = '~/stacks/mcp-server/enrich-history.log';
export const KODIT_WINDOW_MS = 72 * 60 * 60_000;

export interface IKoditSample {
  at: number;
  docs: number;
  summaries: number;
}

const LINE = /^(\S+Z) docs=(\d+)\/\d+ summaries=(\d+)\s*$/;

export const parseKoditLog = (text: string): IKoditSample[] =>
  text.split('\n').flatMap((line) => {
    const match = LINE.exec(line.trim());
    if (!match) return [];
    const at = Date.parse(match[1]);
    return Number.isFinite(at) ? [{ at, docs: Number(match[2]), summaries: Number(match[3]) }] : [];
  });

/** Docs and summaries enriched per hour between the first and last sample inside [from, to]. */
export const koditRate = (samples: readonly IKoditSample[], from: number, to: number): ICuratorKoditWindow => {
  const inside = samples.filter((s) => s.at >= from && s.at <= to).sort((a, b) => a.at - b.at);
  const first = inside[0];
  const last = inside.at(-1);
  if (!first || !last || last.at === first.at) return { from, to, docsPerHour: null, summariesPerHour: null, samples: inside.length };
  const hours = (last.at - first.at) / 3_600_000;
  return {
    from, to, samples: inside.length,
    docsPerHour: (last.docs - first.docs) / hours,
    summariesPerHour: (last.summaries - first.summaries) / hours,
  };
};

/** The fall in docs per hour from before to after, as a fraction (negative: it rose); null when either is unmeasured. */
export const koditDrop = (before: ICuratorKoditWindow, after: ICuratorKoditWindow): number | null => {
  if (before.docsPerHour === null || after.docsPerHour === null || before.docsPerHour <= 0) return null;
  return (before.docsPerHour - after.docsPerHour) / before.docsPerHour;
};

/** Above a 20% fall the client is held to one call per 10 s; a measured fall at or under it lifts nothing it did not set. */
export const koditNeedsRateLimit = (drop: number | null): boolean => drop !== null && drop > KODIT_DROP_LIMIT;
