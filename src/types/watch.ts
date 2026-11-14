import type { TCallerIdentity } from '@/types/identity';

export type TWatchKind = 'pr' | 'ref' | 'lease' | 'auth';
export type TWatchUntil = 'merged' | 'closed' | 'head-moved' | 'checks-settled' | 'moved' | 'free' | 'signed-in';
/**
 * A server-classified failure; the raw text is shown by `watch list`, never typed. `sso-config`: an auth watch's AWS
 * config or SSO cache is unreadable. `rate-limited`: GitHub's rate limit (PMUX-WATCH-403); it is recorded on the
 * watch but counts as no failure: the watch waits for GitHub's reset.
 */
export type TWatchFailure = 'http-404' | 'http-403' | 'rate-limited' | 'timeout' | 'auth' | 'gh-missing' | 'sso-config' | 'other';

export interface IWatch {
  /** `w-<nanoid>`. */
  id: string;
  workspaceId: string;
  tabId: string;
  kind: TWatchKind;
  /** `owner/repo#n`, `owner/repo@ref`, a lease name, or `aws-sso:<profile>` (ADR-0041), grammar-checked. */
  target: string;
  until: TWatchUntil;
  /** The head sha (pr) or ref sha (ref) when the watch was made; null for a lease watch. */
  baseline: string | null;
  /**
   * True for a GitHub watch made while GitHub was rate-limited (PMUX-WATCH-403): `baseline` is null, and the first
   * read after the reset takes it. A head-moved or moved watch counts its move from that read.
   */
  baselinePending?: boolean;
  intervalS: number;
  createdAt: number;
  expiresAt: number;
  lastCheckedAt: number | null;
  /** Consecutive failures. */
  failures: number;
  /** True once the failing notice went out; reset by a success. */
  failingNotified: boolean;
  lastError: { code: TWatchFailure; message: string; at: number } | null;
  /** Caller text, ≤ 80 characters: shown by `watch list`, never typed. */
  label: string | null;
  /** True when the owner was resolved by its launch tab token; false for the session-header fallback (ADR-0010). */
  verified: boolean;
  /** How the owner was named (story 36); absent on watches created before it. */
  identity?: TCallerIdentity;
  /**
   * The notice of a condition that held (or of expiry) whose enqueue failed: the next pass retries the
   * enqueue alone, never the GitHub read.
   */
  pendingNotice?: Record<string, unknown> | null;
  /** An auth watch's ledger item (ADR-0041): its `deploy-auth` wait is cleared when the watch fires. */
  ledgerItem?: string | null;
}

export interface IWatchesState {
  watches: IWatch[];
}

export interface IWatchView extends IWatch {
  ageSeconds: number;
  expiresInSeconds: number;
  /** live, closed or unknown (its workspace layout could not be read). */
  owner: 'live' | 'closed' | 'unknown';
}

export type TWatchErrorCode = 'watch-invalid' | 'watch-cap' | 'watch-not-found' | 'gh-unavailable' | 'forbidden' | 'caller-unresolved';
