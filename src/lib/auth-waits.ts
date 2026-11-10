import { LEDGER_SERVER_PRODUCER } from '@/lib/ledger';
import type { LedgerStore } from '@/lib/ledger-store';
import { authProfile } from '@/lib/watch-store';
import type { ILedgerEventInput } from '@/types/ledger';
import type { IWatch } from '@/types/watch';

// A signed-in auth watch ends the `deploy-auth` waits it stands for (ADR-0041, story 14 AC 6): the
// item the watch names, and every open item of the workspace whose clear input names the profile.

const PROFILE_CHAR = 'A-Za-z0-9._-';

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The clear input names the profile as a whole word: `aws sso login --profile acme-dev`. */
export const namesProfile = (clearInput: string | null, profile: string): boolean =>
  clearInput !== null && new RegExp(`(?:^|[^${PROFILE_CHAR}])${escape(profile)}(?:$|[^${PROFILE_CHAR}])`).test(clearInput);

/** The keys of the waits cleared, in one batch from the server producer. */
export const clearAuthWaits = (store: Pick<LedgerStore, 'items' | 'append'>, watch: IWatch, now: number): string[] => {
  if (watch.kind !== 'auth') return [];
  const profile = authProfile(watch.target);
  const { items } = store.items(watch.workspaceId, { open: true }, now);
  const waiting = items.filter((item) => item.waitReason === 'deploy-auth'
    && (item.itemKey === watch.ledgerItem || namesProfile(item.clearInput, profile)));
  if (!waiting.length) return [];
  const events: ILedgerEventInput[] = waiting.map((item) => ({
    event_id: `auth-watch:${watch.id}:${item.itemKey}`,
    at: now,
    item_type: item.itemType,
    item_key: item.itemKey,
    kind: 'clear',
    state: null,
    wait_reason: null,
    holder: null,
    clear_input: null,
    parent_key: null,
    attrs: { cleared_by: watch.id, sso_profile: profile },
  }));
  store.append(watch.workspaceId, LEDGER_SERVER_PRODUCER, events, now);
  return waiting.map((item) => item.itemKey);
};
