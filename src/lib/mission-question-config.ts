import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { createLogger } from '@/lib/logger';

// The question-format phase-in (ADR-0037 §2): at 1 a v1 question is accepted with its lint, at 2
// it is refused. The owner raises it (OD-10); unset, invalid or unreadable means 1.

export const QUESTION_MIN_VERSION_KEY = 'mission.question-format.min-version';

const log = createLogger('mission-question-config');

const g = globalThis as unknown as { __ptQuestionMinVersionLogged?: string };

const logOnce = (line: string): void => {
  if (g.__ptQuestionMinVersionLogged === line) return;
  g.__ptQuestionMinVersionLogged = line;
  log.warn(line);
};

export const parseQuestionMinVersion = (raw: string | null): { minVersion: 1 | 2; reason: string | null } => {
  if (raw === null) return { minVersion: 1, reason: null };
  const text = raw.trim();
  if (text === '1' || text === '2') return { minVersion: Number(text) as 1 | 2, reason: null };
  return { minVersion: 1, reason: `${QUESTION_MIN_VERSION_KEY} is ${JSON.stringify(raw)}, not 1 or 2; questions are checked at 1` };
};

export const readQuestionMinVersion = async (): Promise<1 | 2> => {
  try {
    const { minVersion, reason } = parseQuestionMinVersion(valueOf(await readFleetConfig(), QUESTION_MIN_VERSION_KEY)?.value ?? null);
    if (reason) logOnce(reason);
    return minVersion;
  } catch (err) {
    logOnce(`${QUESTION_MIN_VERSION_KEY} could not be read (${err instanceof Error ? err.message : String(err)}); questions are checked at 1`);
    return 1;
  }
};
