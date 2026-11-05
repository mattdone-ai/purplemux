import { LedgerStore } from '@/lib/ledger-store';
import type { TabEventsTable } from '@/lib/tab-events-store';
import type { TabTurnsTable } from '@/lib/tab-turns-store';

/** A fresh in-memory `tab_events` per manager, so no test reads another's events (ADR-0035). */
export const memoryTabEvents = (): (() => TabEventsTable) => {
  const store = new LedgerStore(':memory:');
  return () => store.tabEvents;
};

/** Both ledger tables the status manager writes, over one in-memory ledger: `tab_events` and story 15's `tab_turns`. */
export const memoryLedgerTables = (): [() => TabEventsTable, () => TabTurnsTable] => {
  const store = new LedgerStore(':memory:');
  return [() => store.tabEvents, () => store.tabTurns];
};
