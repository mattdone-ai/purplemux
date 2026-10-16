import type { ICaller } from '@/lib/caller';
import type { ICoordinationSnapshot, INoteRow, TFleetSection, TSection } from '@/types/coordination';

// The coordination panel's read (story 20): leases, open notes, watches, active
// grants, held inbox deliveries, orchestrator coverage and host pressure, each
// section independent.

const section = async <T>(read: () => Promise<T[]>): Promise<TSection<T>> => {
  try {
    return { ok: true, items: await read() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** The admin view for the server's own read of every workspace's watches (the route is human-only). */
const PANEL_CALLER = {
  scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true,
} as ICaller;

export const readCoordinationSnapshot = async (now = Date.now()): Promise<ICoordinationSnapshot> => {
  const [{ listLeases }, { viewsOf }, notes, { getWatchManager }, grantStore, { readInboxState }, { readHostMetrics }, { hostSignalsView }, { getOrchestratorPresenceMonitor }, { readFleetView }] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/lease-http'),
    import('@/lib/notes-store'),
    import('@/lib/watch-manager'),
    import('@/lib/grant-store'),
    import('@/lib/inbox-store'),
    import('@/lib/host-metrics'),
    import('@/lib/host-signals'),
    import('@/lib/orchestrator-presence'),
    import('@/lib/fleet-status-snapshot'),
  ]);
  const orchestratorSnapshot = getOrchestratorPresenceMonitor().snapshot();
  const [leases, openNotes, watches, grants, inboxHeld, host, fleet] = await Promise.all([
    section(async () => viewsOf(await listLeases(undefined, now))),
    section(async (): Promise<INoteRow[]> => {
      const [{ notes: all }, inbox] = await Promise.all([notes.readNotesState(), readInboxState()]);
      const notices = new Map(inbox.items.map((item) => [item.id, item]));
      return all
        .filter((n) => notes.OPEN_STATES.has(n.state))
        .map((n) => ({
          ...notes.viewOf(n, n.inboxItemId ? notices.get(n.inboxItemId) ?? null : null),
          ageSeconds: Math.max(0, Math.floor((now - n.createdAt) / 1000)),
        }));
    }),
    section(async () => (await getWatchManager()).list(PANEL_CALLER, null)),
    section(async () => {
      const refusal = grantStore.grantsRefusal();
      if (refusal) throw new Error(refusal);
      return grantStore.grantsSnapshot().grants.filter((g) => grantStore.isActive(g, now));
    }),
    section(async () => (await readInboxState()).items.filter((i) => i.state === 'held')),
    readHostMetrics().catch((err) => ({ available: false as const, reason: err instanceof Error ? err.message : String(err) })),
    readFleetView(now).then(
      (view): TFleetSection => ({ ok: true, view }),
      (err): TFleetSection => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    ),
  ]);
  const orchestrators = orchestratorSnapshot.state === 'ready'
    ? { ok: true as const, items: orchestratorSnapshot.issues }
    : { ok: false as const, error: orchestratorSnapshot.state === 'error'
      ? orchestratorSnapshot.error
      : 'Orchestrator coverage has not been evaluated yet' };
  return { at: now, leases, notes: openNotes, watches, grants, inboxHeld, orchestrators, host, signals: hostSignalsView(now), fleet };
};
