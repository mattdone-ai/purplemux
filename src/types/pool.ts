export type TPoolKind = 'gate' | 'build' | 'tab';

export const POOL_KINDS: readonly TPoolKind[] = ['gate', 'build', 'tab'];

export interface IPoolDisk {
  path: string;
  /** null when the filesystem reports no blocks (unknown, never 0 %). */
  usedPct: number | null;
  freeBytes: number;
}

export interface IPoolGpu {
  index: number;
  name: string;
  utilPct: number | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
}

export interface IPoolUnitState {
  loadState: string;
  activeState: string;
  unitFileState: string;
  result: string;
}

/**
 * The sccache sweep (story 11) as systemd shows it. `not-installed`: the timer
 * unit is not found; `stopped`: installed but not active (stopped or disabled);
 * `failed`: the timer or its last service run failed.
 */
export type TPoolSweepStatus = 'active' | 'stopped' | 'failed' | 'not-installed';

export interface IPoolSweepState {
  state: TPoolSweepStatus;
  failed: boolean;
  timer: IPoolUnitState;
  service: IPoolUnitState | null;
}

export interface IPoolMetrics {
  threads: number;
  load1: number;
  load5: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  disks: IPoolDisk[];
  /** null: not read on this host (no nvidia-smi); [] would mean a read with no GPU. */
  gpus: IPoolGpu[] | null;
  /** null: not read (this host, or no systemctl answer); an absent timer is `state: 'not-installed'`. */
  sccacheSweep: IPoolSweepState | null;
}

/**
 * One host's last read. `unknown` carries no metrics: a failed read is never
 * read as zero load or zero memory, and nothing new is placed there.
 */
export type TPoolHostRead =
  | {
    host: string; local: boolean; state: 'known'; readAt: number; via: string | null; metrics: IPoolMetrics;
    /** Set when the host's own alias failed and only the fallback answered: shown, never placed on. */
    primaryFailure?: string;
  }
  | { host: string; local: boolean; state: 'unknown'; readAt: number | null; via: string | null; reason: string; retryAt: number };

export interface IPoolSlotUse {
  used: number;
  cap: number;
  free: number;
}

export interface IPoolHostView {
  host: string;
  local: boolean;
  state: 'known' | 'unknown';
  /** ISO time of the last successful read; null when the host was never read. */
  readAt: string | null;
  /** The ssh alias that answered the last read (the fallback alias when the first failed); null for this host. */
  via: string | null;
  reason: string | null;
  /** False for an unknown host and for one that answers only through its fallback alias. */
  placeable: boolean;
  metrics: IPoolMetrics | null;
  /** Load per thread over the 1-minute average; null when unknown. */
  loadPerThread: number | null;
  slots: Record<TPoolKind, IPoolSlotUse>;
  /** Agent tabs whose tmux runs on this host (from the layouts). */
  agentTabs: number;
}

export interface IPoolTotals {
  /** Over known hosts only: an unknown host adds nothing, never zero. */
  threads: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  /** `used` and `cap` over known hosts; `free` over placeable hosts only: a fallback-only host's slots take nothing. */
  slots: Record<TPoolKind, IPoolSlotUse>;
  knownHosts: number;
  unknownHosts: number;
}

export interface IPoolView {
  at: string;
  hosts: IPoolHostView[];
  totals: IPoolTotals;
}

export type TPoolRefusalReason = 'no-known-host' | 'no-free-slot' | 'no-memory' | 'disk-full';

export interface IPoolPlacementRequest {
  kind: TPoolKind;
  /** Memory the work needs, in GiB (0 when the caller does not know). */
  memGb: number;
  /** kind tab only: the tab's panel type (claude-code when absent). */
  panelType?: string;
  /** kind tab only: a tab role (ADR-0040); any role places on this host. */
  role?: string;
}

export type TPoolPlacement =
  | { ok: true; host: string; local: boolean; reason: string }
  | { ok: false; refusal: TPoolRefusalReason; reason: string };

export interface IPoolAcquireResult {
  host: string;
  local: boolean;
  slot: string;
  lease: string;
  expiresAt: string | null;
  reason: string;
  /** The gate-host container to pin for a remote gate (fleet config `pool.gate-host.<host>`), else null. */
  gateHost: string | null;
}
