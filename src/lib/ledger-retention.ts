import { DAY_MS } from '@/lib/ledger';
import { getLedgerStore, type LedgerStore } from '@/lib/ledger-store';
import { createLogger } from '@/lib/logger';

const log = createLogger('ledger');

/** The first pass waits for boot to settle; then once a day. */
export const LEDGER_RETENTION_FIRST_RUN_MS = 10 * 60_000;

const g = globalThis as unknown as { __ptLedgerRetention?: { timer: NodeJS.Timeout | null } };

/**
 * The ledger's daily job (ADR-0033 §Retention): roll up the last whole days, then delete what is
 * past retention. One per process; a failed pass is logged and the next day tries again.
 */
export const startLedgerRetention = (
  opts: { store?: () => LedgerStore; firstRunAfterMs?: number } = {},
): void => {
  if (g.__ptLedgerRetention) return;
  const state: { timer: NodeJS.Timeout | null } = { timer: null };
  g.__ptLedgerRetention = state;
  const store = opts.store ?? getLedgerStore;
  const schedule = (delay: number) => {
    state.timer = setTimeout(async () => {
      try {
        log.info(await store().runRetention(Date.now()), 'ledger retention pass');
      } catch (error) {
        log.error({ err: error }, 'ledger retention pass failed');
      }
      if (g.__ptLedgerRetention === state) schedule(DAY_MS);
    }, delay);
    state.timer.unref?.();
  };
  schedule(opts.firstRunAfterMs ?? LEDGER_RETENTION_FIRST_RUN_MS);
};

export const stopLedgerRetention = (): void => {
  const state = g.__ptLedgerRetention;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  delete g.__ptLedgerRetention;
};
