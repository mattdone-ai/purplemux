import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('status');

/**
 * The automatic resumes a turn-error episode is owed but that live only in memory (PMUX-REMOTE-RESILIENCE review
 * r1): a tab held by a provider outage, an auth failure waiting for its provider, a rate limit waiting out its
 * backoff. A queued resume survives a restart in the inbox; these would not, and the tab would wait for a resume
 * that never comes. The file is the whole set, replaced by one rename after each change; the next server escalates
 * every entry its tab still has, once, and starts empty.
 */
export type THoldReason = 'outage' | 'auth-wait' | 'backoff';

export interface ITurnErrorHold {
  workspaceId: string;
  class: 'api-error' | 'auth-failure' | 'rate-limit';
  code: string;
  text: string;
  reason: THoldReason;
  /** The target was already told about this episode. */
  escalated: boolean;
}

export const turnErrorHoldsFile = (): string => path.join(os.homedir(), '.purplemux', 'turn-error-holds.json');

export class TurnErrorHoldStore {
  private writing: Promise<void> = Promise.resolve();
  private pending: Record<string, ITurnErrorHold> | null = null;

  constructor(private readonly file: () => string = turnErrorHoldsFile) {}

  /** Replace the file with `holds`. Writes run one at a time; a burst writes the latest set once more at most. */
  save(holds: Record<string, ITurnErrorHold>): Promise<void> {
    const first = this.pending === null;
    this.pending = holds;
    if (!first) return this.writing;
    this.writing = this.writing.then(async () => {
      const next = this.pending ?? {};
      this.pending = null;
      const target = this.file();
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(tmp, target);
    }).catch((err) => {
      log.warn(`turn-error holds not saved: ${err instanceof Error ? err.message : err}`);
    });
    return this.writing;
  }

  /** What the previous server left; absent or unreadable is none. */
  async load(): Promise<Record<string, ITurnErrorHold>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.file(), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log.warn(`turn-error holds unreadable: ${err instanceof Error ? err.message : err}`);
      return {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const holds: Record<string, ITurnErrorHold> = {};
    for (const [tabId, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as Partial<ITurnErrorHold> | null;
      if (!v || typeof v.workspaceId !== 'string' || typeof v.code !== 'string' || typeof v.text !== 'string') continue;
      if (v.class !== 'api-error' && v.class !== 'auth-failure' && v.class !== 'rate-limit') continue;
      if (v.reason !== 'outage' && v.reason !== 'auth-wait' && v.reason !== 'backoff') continue;
      holds[tabId] = { workspaceId: v.workspaceId, class: v.class, code: v.code, text: v.text, reason: v.reason, escalated: v.escalated === true };
    }
    return holds;
  }

  flushed(): Promise<void> {
    return this.writing;
  }
}
