import { lastTurnMarker } from '@/lib/wake-class';
import type { TInboxKind } from '@/types/inbox';

// F6 change 3 (quiet coordinators; design check ruling, 2026-11-10): a coordinator — the enabled orchestrator tab
// of its workspace — gets at most one window-governed wake every 10 minutes. The window replaces two older rules for
// coordinators only: an urgent event typed at once, and the 20-event digest bypass. Workers keep both.
//
// What counts: only a window-governed paste opens a new window — a digest, or an inbox item of a windowed kind (note,
// watch, deploy) — read from the ledger, plus an in-memory claim taken inside the dispatch lock after a typed paste.
// A paste of a skipping kind, a `tab send` and the owner's own typing never read or reset it (ruling, change 1).
//
// F10 step 3 (the `messages` table and stop-drain delivery) replaces the inbox half, and F10 steps 4-5 replace the
// router half; this module is kept to the one rule both of them read.

export const COORDINATOR_WINDOW_MS = 10 * 60_000;
/**
 * The inbox republishes its heads every tick (2 s). Heads older than this are not read (review nit 3): an inbox that
 * stopped ticking must not hold a coordinator's digest behind an item it no longer dispatches.
 */
export const INBOX_HEADS_TTL_MS = 10_000;

/** The `lastRefusal` prefix of an inbox item deferred by the window: no refusal budget is spent on it. */
export const WINDOW_DEFERRAL = 'coordinator-window:';

/** Inbox kinds that skip the window: the owner's answer and a turn a usage limit interrupted (ruling, Q1). */
export const WINDOW_EXEMPT_INBOX_KINDS: ReadonlySet<TInboxKind> = new Set<TInboxKind>(['mission', 'resume']);

/** Inbox kinds whose delivery to a coordinator went through the window, and so starts the next one. */
export const WINDOWED_INBOX_KINDS: readonly TInboxKind[] = ['note', 'watch', 'deploy'];

/**
 * The kinds that skip the window (ruling, Q1): a turn-marker whose last line is `BLOCKED:` or `NEEDS-DECISION:`,
 * `rotate` (ADR-0036 needs its own readiness check), `standing-order`, `mission` and `resume`. A kind skips only if its
 * daily count does not grow with the fleet and it comes from the owner or from the seat's own lifecycle. Everything
 * else waits up to 10 minutes, a red-main block alarm and the owner's GO note included.
 */
export const isWindowExempt = (kind: string, markerLines?: readonly string[]): boolean => {
  if (kind === 'turn-marker') {
    const marker = lastTurnMarker(markerLines);
    return marker === 'BLOCKED' || marker === 'NEEDS-DECISION';
  }
  return kind === 'rotate' || kind === 'standing-order' || kind === 'mission' || kind === 'resume';
};

export interface ICoordinatorWindowDeps {
  now: () => number;
  /** The tab is its workspace's enabled orchestrator. */
  isCoordinator: (workspaceId: string, tabId: string) => Promise<boolean>;
  /** The latest window-governed delivery to the tab in the ledger (a digest, or a windowed inbox kind); null when none. */
  lastGoverned: (workspaceId: string, tabId: string) => number | null;
  /** When the tab's oldest held digest row was recorded; null when none is held. */
  oldestDigestAt: (workspaceId: string, tabId: string) => number | null;
}

const key = (workspaceId: string, tabId: string): string => `${workspaceId}/${tabId}`;

export class CoordinatorWindow {
  private readonly claims = new Map<string, number>();
  /** Per tab: when its oldest windowed inbox item that waits only on the window was created (set by the inbox tick). */
  private inboxHeads = new Map<string, number>();
  private inboxHeadsAt = -Infinity;

  constructor(private readonly deps: ICoordinatorWindowDeps) {}

  governs(workspaceId: string, tabId: string): Promise<boolean> {
    return this.deps.isCoordinator(workspaceId, tabId);
  }

  /** When the window opens for the tab: 10 min after the last governed paste. An unreadable ledger reads the claim only. */
  openAt(workspaceId: string, tabId: string): number {
    let ledger: number | null = null;
    try {
      ledger = this.deps.lastGoverned(workspaceId, tabId);
    } catch {
      ledger = null;
    }
    const last = Math.max(this.claims.get(key(workspaceId, tabId)) ?? -Infinity, ledger ?? -Infinity);
    return last + COORDINATOR_WINDOW_MS;
  }

  isOpen(workspaceId: string, tabId: string): boolean {
    return this.deps.now() >= this.openAt(workspaceId, tabId);
  }

  /** A governed paste typed: the next window counts from now. Called inside the tab's dispatch lock. */
  claim(workspaceId: string, tabId: string): void {
    this.claims.set(key(workspaceId, tabId), this.deps.now());
  }

  /** The inbox tick's view of each tab's oldest item that waits only on the window (ruling, change 3: fairness). */
  setInboxHeads(heads: ReadonlyMap<string, number>): void {
    this.inboxHeads = new Map(heads);
    this.inboxHeadsAt = this.deps.now();
  }

  /** The digest goes first unless an inbox item for the tab has waited longer than its oldest held row. */
  digestTurn(workspaceId: string, tabId: string): boolean {
    if (this.deps.now() - this.inboxHeadsAt > INBOX_HEADS_TTL_MS) return true;
    const inbox = this.inboxHeads.get(key(workspaceId, tabId));
    if (inbox === undefined) return true;
    const digest = this.oldestDigest(workspaceId, tabId);
    return digest === null || digest <= inbox;
  }

  /** The inbox item goes first unless a held digest row has waited at least as long. */
  inboxTurn(workspaceId: string, tabId: string, createdAt: number): boolean {
    const digest = this.oldestDigest(workspaceId, tabId);
    return digest === null || createdAt < digest;
  }

  private oldestDigest(workspaceId: string, tabId: string): number | null {
    try {
      return this.deps.oldestDigestAt(workspaceId, tabId);
    } catch {
      return null;
    }
  }
}

const g = globalThis as unknown as { __ptCoordinatorWindow?: CoordinatorWindow };

/**
 * The server's one window, made by the StatusManager with its ledger and workspace reads: the router and the inbox
 * share its claims, so the two never both take one window. Null before the server wires it (a test, a CLI import).
 */
export const configureCoordinatorWindow = (deps: ICoordinatorWindowDeps): CoordinatorWindow => {
  g.__ptCoordinatorWindow = new CoordinatorWindow(deps);
  return g.__ptCoordinatorWindow;
};

export const getCoordinatorWindow = (): CoordinatorWindow | null => g.__ptCoordinatorWindow ?? null;
