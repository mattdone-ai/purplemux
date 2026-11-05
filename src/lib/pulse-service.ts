import { reasonLabel } from '@/lib/constraint-labels';
import { FINDER_STALE_MS, readFinderResult } from '@/lib/constraint-tick';
import { createLogger } from '@/lib/logger';
import { PULSE_LOOKBACK_MS, derivePulse, needsYouText, pulsePriority, pulseWip } from '@/lib/pulse';
import type { IPulseWipInput, IPulseWipLedger, IPulseWipMcItem, IPulseWipTab } from '@/lib/pulse';
import { PulseFsUnavailableError, pulseFs } from '@/lib/pulse-fs';
import { readEpicInfo, resolvePulseScope } from '@/lib/pulse-scope';
import type { IPulseEpicInfo, IPulseEpicLease, IPulseScope, IPulseTargets, IPulseWorkspaceRef } from '@/lib/pulse-scope';
import { readCommits, readEpicCommits, readGates, readLanded, readReviews } from '@/lib/pulse-sources';
import type { ILedgerPulseSnapshot } from '@/lib/ledger-store';
import type { IFinderResult } from '@/types/constraint';
import type { IPulse, IPulseSourceRead } from '@/types/pulse';
import type { IClientTabStatusEntry } from '@/types/status';

// The pulse's reads (ADR-0034 §9): the workspace's scope first (which movement is its own), then
// each source on its own behind a 10 s deadline; a failed or timed-out read is that source unknown.
// The answer is cached per workspace for one finder tick; concurrent reads share one derive, and a
// derive still running at the deadline is no longer shared.

const log = createLogger('pulse');

export const PULSE_CACHE_MS = 60_000;
/** One source's read; past it the source is unknown "read timed out" (a hung sshfs read never holds the pulse). */
export const PULSE_READ_DEADLINE_MS = 10_000;
const AGENT_PANELS = new Set(['claude-code', 'codex-cli', 'grok-cli']);
const WORKING_STATES = new Set(['busy', 'needs-input']);

export interface IPulseDeps {
  workspaces: () => Promise<IPulseWorkspaceRef[]>;
  /** Every `epic:<slug>` lease and the workspace its holder is in. */
  epicLeases: () => Promise<IPulseEpicLease[]>;
  epicInfo: (slug: string, allDirectories: readonly string[]) => Promise<IPulseEpicInfo>;
  hasV2: (dir: string) => Promise<boolean>;
  ledger: (workspaceId: string, since: number) => Promise<ILedgerPulseSnapshot>;
  openItems: (workspaceId: string) => Promise<IPulseWipMcItem[]>;
  answerTimes: (workspaceId: string, since: number) => Promise<number[]>;
  /** Non-orchestrator agent tabs that are busy or need input; a needs-input tab's `since` is when it began waiting. */
  agentTabs: (workspaceId: string) => Promise<IPulseWipTab[]>;
  finder: (workspaceId: string, now: number) => Promise<IFinderResult>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const OWNER_MARKERS = /^(NEEDS-DECISION|BLOCKED):/;

/**
 * An orchestrator waiting for the owner (C2): a pane prompt (`needs-input`), or a turn that ended on a
 * `NEEDS-DECISION:` or `BLOCKED:` line that no later event replaced. Returns since when and the question.
 */
export const waitingForOwner = (entry: Pick<IClientTabStatusEntry, 'cliState' | 'lastEvent' | 'turnEnd' | 'lastAssistantMessage'>): { since: number | null; question: string } | null => {
  const lastLine = (text: string | null | undefined): string | null => text?.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 160) ?? null;
  if (entry.cliState === 'needs-input') return { since: entry.lastEvent?.at ?? null, question: lastLine(entry.lastAssistantMessage) ?? 'a prompt in its pane' };
  const end = entry.turnEnd;
  const current = end && (end.seq === undefined || end.seq === entry.lastEvent?.seq);
  const marker = current && end.kind === 'turn-marker' ? end.marker?.find((line) => OWNER_MARKERS.test(line)) : undefined;
  return marker ? { since: end!.at, question: marker.slice(0, 160) } : null;
};

export const withDeadline = async <T>(read: () => Promise<T>, ms: number = PULSE_READ_DEADLINE_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`read timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const attempt = async <T>(read: () => Promise<T>, what: string, workspaceId: string): Promise<{ value: T } | { error: string; mount?: true }> => {
  try {
    return { value: await withDeadline(read) };
  } catch (err) {
    log.warn({ workspaceId }, `pulse: ${what} unreadable (${errorText(err)})`);
    return err instanceof PulseFsUnavailableError ? { error: err.message, mount: true } : { error: errorText(err) };
  }
};

const unread = (id: IPulseSourceRead['id'], reason: string): IPulseSourceRead => ({ id, events: null, reason, from: [] });

const LEDGER_FROM = ['~/.purplemux/ledger.sqlite events: open, clear, close on range, slice, gate, review, landing, deploy'];

const ledgerRead = (snapshot: ILedgerPulseSnapshot | null): IPulseSourceRead => {
  if (!snapshot) return unread('ledger', 'ledger unreadable');
  if (!snapshot.eventSince) return { ...unread('ledger', 'the ledger holds no work-item event for this workspace in 7 days'), from: LEDGER_FROM };
  return { id: 'ledger', events: snapshot.movement.map((at) => ({ at })), reason: null, from: LEDGER_FROM };
};

const wipLedger = (snapshot: ILedgerPulseSnapshot | null): IPulseWipLedger => {
  if (!snapshot) return { state: 'unreadable', openItems: 0, oldest: null };
  if (!snapshot.eventSince) return { state: 'no-events', openItems: 0, oldest: null };
  const { oldest } = snapshot;
  return {
    state: 'measured',
    openItems: snapshot.openWork,
    oldest: oldest ? {
      kind: 'ledger-item', id: oldest.itemKey, since: oldest.since,
      label: oldest.waitReason ? `${oldest.itemKey}: ${reasonLabel(oldest.waitReason)}` : `${oldest.itemKey}: open, no wait recorded`,
    } : null,
  };
};

interface IScopeInputs {
  at: number;
  workspaces: IPulseWorkspaceRef[];
  leases: IPulseEpicLease[];
  epics: Map<string, IPulseEpicInfo>;
  v2: Set<string>;
}

const gScope = globalThis as unknown as { __ptPulseScopeInputs?: { value: IScopeInputs | null } };
if (!gScope.__ptPulseScopeInputs) gScope.__ptPulseScopeInputs = { value: null };

/** What every workspace's scope rests on, read once per cache period, not once per workspace. */
const scopeInputs = async (deps: IPulseDeps, now: number, cached: boolean): Promise<IScopeInputs> => {
  const held = gScope.__ptPulseScopeInputs!;
  if (cached && held.value && now - held.value.at < PULSE_CACHE_MS) return held.value;
  const [workspaces, leases] = await Promise.all([deps.workspaces(), deps.epicLeases()]);
  const allDirectories = [...new Set(workspaces.flatMap((workspace) => workspace.directories))];
  const epics = new Map((await Promise.all([...new Set(leases.map((lease) => lease.slug))]
    .map((slug) => deps.epicInfo(slug, allDirectories)))).map((epic) => [epic.slug, epic]));
  const v2 = new Set((await Promise.all(allDirectories.map(async (dir) => ((await deps.hasV2(dir)) ? dir : null))))
    .filter((dir): dir is string => dir !== null));
  const value = { at: now, workspaces, leases, epics, v2 };
  if (cached) held.value = value;
  return value;
};

/** The workspace's scope: its epic leases' records and repositories, or its own directories (round 2, F1). */
export const readScope = async (workspaceId: string, deps: IPulseDeps, now: number = Date.now(), cached = false): Promise<IPulseScope> => {
  const { workspaces, leases, epics, v2 } = await scopeInputs(deps, now, cached);
  return resolvePulseScope(workspaceId, workspaces, leases, epics, v2);
};

type TFileReader = (targets: IPulseTargets, since: number, scope: IPulseScope | null) => Promise<IPulseSourceRead | IPulseSourceRead[]>;

const FILE_READERS: Array<[IPulseSourceRead['id'], TFileReader]> = [
  // An epic workspace's commits are attributed against the other leased epics on the same repositories (round 3, F1).
  ['commits', (targets, since, scope) => (scope?.basis === 'epic' && targets === scope.own
    ? readEpicCommits(targets.repos, scope.rivals, since) : readCommits(targets.repos, since))],
  ['gates', (targets, since) => readGates(targets, since)],
  ['reviews', (targets, since) => readReviews(targets, since)],
  ['landed', (targets, since) => readLanded(targets, since)],
];

/** Fresh reads of every source for one workspace. */
export const computePulse = async (
  workspaceId: string, now: number, deps?: IPulseDeps, options: { shareScope?: boolean } = {},
): Promise<IPulse> => {
  const since = now - PULSE_LOOKBACK_MS;
  // The real deps share one scope read across workspaces per cache period; injected ones (tests) read fresh unless asked.
  const cachedScope = options.shareScope ?? deps === undefined;
  deps ??= realDeps();
  const resolved = deps;
  const scoped = await attempt(() => readScope(workspaceId, resolved, now, cachedScope), 'scope', workspaceId);
  const scope = 'value' in scoped ? scoped.value : null;
  const fileRead = async (id: IPulseSourceRead['id'], read: TFileReader, targets: IPulseTargets, sharedWith?: string[]): Promise<IPulseSourceRead[]> => {
    const result = await attempt(() => read(targets, since, scope), sharedWith ? `${id} (shared)` : id, workspaceId);
    // A mount that cannot serve the read names itself: "<mount> not answering since <time>" or "<mount> busy: ...".
    const failed = 'value' in result ? null : result.mount ? result.error : `${id} unreadable: ${result.error}`;
    const values = 'value' in result ? [result.value].flat() : [unread(id, failed!)];
    return sharedWith ? values.map((value) => ({ ...value, sharedWith })) : values;
  };
  const own = scope
    ? FILE_READERS.map(([id, read]) => fileRead(id, read, scope.own))
    : FILE_READERS.map(async ([id]) => [unread(id, `scope unreadable: ${'error' in scoped ? scoped.error : 'unknown'}`)]);
  const shared = (scope?.shared ?? []).flatMap((entry) => FILE_READERS.map(([id, read]) => fileRead(id, read, entry.targets, entry.with)));
  const [ledger, mcItems, answers, tabs, finder, fileReads, sharedReads] = await Promise.all([
    attempt(() => deps.ledger(workspaceId, since), 'ledger', workspaceId),
    attempt(() => deps.openItems(workspaceId), 'Mission Control items', workspaceId),
    attempt(() => deps.answerTimes(workspaceId, since), 'Mission Control answers', workspaceId),
    attempt(() => deps.agentTabs(workspaceId), 'tab status', workspaceId),
    attempt(() => deps.finder(workspaceId, now), 'constraint finder', workspaceId),
    Promise.all(own).then((reads) => reads.flat()),
    Promise.all(shared).then((reads) => reads.flat()),
  ]);
  const snapshot = 'value' in ledger ? ledger.value : null;
  const items = 'value' in mcItems ? mcItems.value : null;
  const wipInput: IPulseWipInput = { ledger: wipLedger(snapshot), agentTabs: 'value' in tabs ? tabs.value : null, mcItems: items };
  const { wip, oldestStuck } = pulseWip(wipInput);
  const needsYou = items === null ? null : items.length;
  const answersRead: IPulseSourceRead = 'value' in answers
    ? { id: 'answers', events: answers.value.map((at) => ({ at })), reason: null, from: ['~/.purplemux/mission-control.sqlite answers'] }
    : unread('answers', 'Mission Control unreadable');
  return derivePulse({
    workspaceId, now, wip, oldestStuck,
    scope: scope ? { basis: scope.basis, epics: scope.epics } : { basis: 'directories', epics: [] },
    // A shared source that cannot be read adds nothing worth showing; a counted one always shows its state.
    reads: [ledgerRead(snapshot), ...fileReads.filter((read) => !read.sharedWith), answersRead,
      ...fileReads.filter((read) => read.sharedWith), ...sharedReads.filter((read) => read.events !== null)],
    priority: 'value' in finder
      ? pulsePriority(finder.value, needsYou)
      : { basis: 'unknown', needsYou, text: `constraint unknown (finder unreadable) · ${needsYouText(needsYou)}` },
    staleSince: 'value' in finder && now - finder.value.generatedAt > FINDER_STALE_MS ? finder.value.generatedAt : null,
  });
};

const realDeps = (): IPulseDeps => ({
  workspaces: async () => (await (await import('@/lib/workspace-store')).getWorkspaces()).workspaces
    .map((workspace) => ({ id: workspace.id, name: workspace.name, directories: workspace.directories ?? [] })),
  epicLeases: async () => (await (await import('@/lib/lease-store')).readLeaseState()).leases
    .filter((lease) => lease.kind === 'epic' && lease.holder.workspaceId)
    .map((lease) => ({ slug: lease.resource, workspaceId: lease.holder.workspaceId! })),
  epicInfo: readEpicInfo,
  hasV2: async (dir) => pulseFs.stat(`${dir}/.v2`).then((stat) => stat.isDirectory(), () => false),
  ledger: async (workspaceId, since) => (await import('@/lib/ledger-store')).getLedgerStore().pulseSnapshot(workspaceId, since),
  openItems: async (workspaceId) => (await import('@/lib/mission-control-store')).getMissionControlStore().openItemTitles(workspaceId),
  answerTimes: async (workspaceId, since) => (await import('@/lib/mission-control-store')).getMissionControlStore().answerTimes(workspaceId, since),
  agentTabs: async (workspaceId) => {
    const workspace = await (await import('@/lib/workspace-store')).getWorkspaceById(workspaceId);
    const orchestrator = workspace?.orchestration?.orchestratorTabId ?? null;
    const statuses = (await import('@/lib/status-manager')).getStatusManager().getAllForClient();
    return Object.entries(statuses).flatMap(([tabId, entry]): IPulseWipTab[] => {
      if (entry.workspaceId !== workspaceId || entry.panelType === undefined || !AGENT_PANELS.has(entry.panelType)) return [];
      const name = entry.tabName || tabId;
      // The orchestrator turns on every nudge, so a busy orchestrator is not work; one waiting for the owner is (C2).
      if (tabId === orchestrator) {
        const waiting = waitingForOwner(entry);
        return waiting ? [{ tabId, name, state: 'needs-input', since: waiting.since, role: 'orchestrator', question: waiting.question }] : [];
      }
      if (!WORKING_STATES.has(entry.cliState)) return [];
      return [entry.cliState === 'needs-input'
        // The event that set needs-input is the tab's latest while it waits (docs/STATUS.md: `notification`).
        ? { tabId, name, state: 'needs-input', since: entry.lastEvent?.at ?? null }
        : { tabId, name, state: 'busy', since: entry.busySince ?? null }];
    });
  },
  finder: readFinderResult,
});

interface IPulseCacheEntry {
  pulse: IPulse;
}

const g = globalThis as unknown as { __ptPulseCache?: Map<string, IPulseCacheEntry>; __ptPulseInflight?: Map<string, Promise<IPulse>> };
if (!g.__ptPulseCache) g.__ptPulseCache = new Map();
if (!g.__ptPulseInflight) g.__ptPulseInflight = new Map();

/** The pulse for one workspace: the cached answer while it is under 60 s old, else a fresh one. */
export const readPulse = async (workspaceId: string, now: number, deps?: IPulseDeps): Promise<IPulse> => {
  const cached = g.__ptPulseCache!.get(workspaceId);
  if (cached && now - cached.pulse.generatedAt < PULSE_CACHE_MS) return cached.pulse;
  const inflight = g.__ptPulseInflight!;
  const running = inflight.get(workspaceId);
  if (running) return running;
  const derive = computePulse(workspaceId, now, deps).then((pulse) => {
    g.__ptPulseCache!.set(workspaceId, { pulse });
    return pulse;
  });
  inflight.set(workspaceId, derive);
  const forget = () => {
    if (inflight.get(workspaceId) === derive) inflight.delete(workspaceId);
  };
  // Every read is bounded, but a derive still running at the deadline is not handed to the next reader.
  const timer = setTimeout(forget, PULSE_READ_DEADLINE_MS);
  timer.unref?.();
  return derive.finally(() => {
    clearTimeout(timer);
    forget();
  });
};

/** Tests only. */
export const resetPulseForTests = (): void => {
  g.__ptPulseCache!.clear();
  g.__ptPulseInflight!.clear();
};
