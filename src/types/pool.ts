export type TPoolJobKind = 'gate' | 'build' | 'mutation' | 'browser' | 'test-service';
export type TPoolKind = TPoolJobKind | 'tab';

export const POOL_JOB_KINDS: readonly TPoolJobKind[] = ['gate', 'build', 'mutation', 'browser', 'test-service'];
export const POOL_KINDS: readonly TPoolKind[] = [...POOL_JOB_KINDS, 'tab'];

/**
 * Who a reservation serves (vel-D4). `product`: application repair and candidate
 * validation, first. `harness`: harness and optional jobs, held to a bounded
 * share. `control-plane`: a coordinator tab on this host's reserve; never queued.
 */
export type TPoolClass = 'product' | 'harness' | 'control-plane';

export const POOL_CLASSES: readonly TPoolClass[] = ['product', 'harness', 'control-plane'];

export interface IPoolUse {
  threads: number;
  memBytes: number;
}

/** A host's one budget (vel-D4): the reserve comes off the top; every kind shares the rest. */
export interface IPoolBudgetView {
  threads: number;
  memBytes: number;
  reserveThreads: number;
  reserveMemBytes: number;
  workerThreads: number;
  workerMemBytes: number;
  /** min(load1, load5) plus unseen work above this refuses new work. */
  maxLoad: number;
  harnessSharePct: number;
  used: Record<TPoolClass, IPoolUse>;
  /** Worker budget not reserved by product or harness work. */
  free: IPoolUse;
}

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
 * How ssh reaches a remote host over the tailnet (vel-RETRO-R2). `not-tailnet`: the alias dials an address outside the
 * tailnet (a LAN alias such as `host-b-lan`); `unknown`: not measured, never read as `direct`.
 */
export type TPoolPathKind = 'direct' | 'relayed' | 'not-tailnet' | 'unknown';

export type TPoolPathAlert = 'tailnet-relayed' | 'tailnet-slow';

/** One measurement, as the pool reader keeps it. */
export interface IPoolPathRead {
  kind: TPoolPathKind;
  /** The alias measured: the one that answered the pool read, else the host's own. */
  alias: string;
  /** What ssh dials (`ssh -G` hostname); null when it could not be read. */
  address: string | null;
  ip: string | null;
  /** The peer name in the `pong from` line. */
  peer: string | null;
  /** The DERP region of a relayed path (`sin`), or `peer-relay`. */
  region: string | null;
  rttMs: number | null;
  measuredAt: number;
  reason: string | null;
  /** Relayed measurements in a row up to this one (0 unless relayed); a relayed path alerts at 2 (review r1 L3). */
  relayedReads: number;
}

/** The path as the pool view and the fleet view serve it. Placement reads none of it: the pool reports, never refuses. */
export interface IPoolPathView {
  kind: TPoolPathKind;
  /** `tailnet-relayed` (on 2 relayed reads in a row) wins over `tailnet-slow`; null when fine or not measured. */
  alert: TPoolPathAlert | null;
  alias: string;
  address: string | null;
  ip: string | null;
  peer: string | null;
  region: string | null;
  rttMs: number | null;
  /** Relayed measurements in a row; a relayed path with 1 is not yet an alert. */
  relayedReads: number;
  /** `pool.path.slow-ms`: an RTT at or above it is slow. */
  slowMs: number;
  measuredAt: string;
  reason: string | null;
}

/** A remote host's path as the fleet view carries it; `text` is the alert line, null while the path raises none. */
export interface IPoolHostPath {
  host: string;
  /** Null: the host was not measured yet. */
  path: IPoolPathView | null;
  text: string | null;
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
    /** The tailnet path, measured with the read (remote hosts only). */
    path?: IPoolPathRead;
  }
  | {
    host: string; local: boolean; state: 'unknown'; readAt: number | null; via: string | null; reason: string; retryAt: number;
    /** A host that does not answer ssh still has a path to report: a relayed path is a likely cause. */
    path?: IPoolPathRead;
  };

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
  /**
   * Per kind: `used` leases (plus agent tabs for `tab`); `cap` the envelopes of the kind the worker budget holds
   * alone (or `pool.slots.<host>.<kind>`); `free` how many more fit the shared budget now.
   */
  slots: Record<TPoolKind, IPoolSlotUse>;
  /** Agent tabs whose tmux runs on this host (from the layouts), the orchestrator tabs among them included. */
  agentTabs: number;
  /** Null for an unknown host: its budget is not known, never zero. */
  budget: IPoolBudgetView | null;
  /** The tailnet path (vel-RETRO-R2); null for this host, and for a remote host not measured yet. */
  path: IPoolPathView | null;
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

export interface IPoolQueueEntry {
  ticket: string;
  kind: TPoolKind;
  class: TPoolClass;
  /** 1-based, in admission order. */
  position: number;
  envelope: { threads: number; memGb: number };
  /** The hosts the ticket may run on; empty while none of them is placeable. */
  hosts: string[];
  holder: string;
  queuedAt: string;
  expiresAt: string | null;
}

/**
 * `pool.mode` (vel-D4 review r1): `shadow`, the default, admits work the budget, the measured memory or the
 * sustained load would refuse, and logs it; `enforce` refuses it. Every other check refuses in both modes.
 */
export type TPoolMode = 'shadow' | 'enforce';

/** The admission checks that shadow mode logs and admits instead of refusing. */
export type TPoolShadowedRefusal = 'no-budget' | 'no-memory' | 'overloaded';

/** One admission that enforce mode would have refused, with the figures `max-load` is tuned from. */
export interface IPoolWouldRefuse {
  host: string;
  kind: TPoolKind;
  class: TPoolClass;
  refusals: TPoolShadowedRefusal[];
  /** min(load1, load5) of the read. */
  minLoad: number;
  /** Threads of the leases and tab starts the read cannot show yet. */
  pendingThreads: number;
  envelope: IPoolEnvelopeView;
  maxLoad: number;
  memFreeBytes: number;
  workerUsed: IPoolUse;
  workerThreads: number;
  workerMemBytes: number;
  /** The agent tabs the ledger counts on the host, from the layouts. */
  agentTabs: { worker: number; controlPlane: number };
  detail: string;
}

/** The would-refuse counter since the server started (the fleet view and the pool view carry it). */
export interface IPoolWouldRefuseView {
  mode: TPoolMode;
  total: number;
  since: string;
  byHost: Record<string, { total: number; byRefusal: Partial<Record<TPoolShadowedRefusal, number>> }>;
  /** The last log line, so a reader sees the figures without the server log. */
  last: { at: string; line: string } | null;
}

export interface IPoolView {
  at: string;
  hosts: IPoolHostView[];
  totals: IPoolTotals;
  queue: IPoolQueueEntry[];
  wouldRefuse: IPoolWouldRefuseView;
  /** What this server honours (vel-POOL-ENF): a client relies on `ask-token` and `host-pin` only when listed here. */
  features: readonly TPoolFeature[];
}

export type TPoolFeature = 'ask-token' | 'host-pin';

/**
 * The hosts a request may run on (vel-POOL-ENF): their union. `local` is the server's own host; `gateHosts` are the
 * hosts whose `pool.gate-host.<host>` names one of them. A pin that allows no host is `no-pinned-host`.
 */
export interface IPoolPin {
  hosts: string[];
  local: boolean;
  gateHosts: string[];
}

/**
 * `no-budget`: the shared worker budget (threads or memory) is reserved; `harness-share`: harness work holds its
 * share; `no-memory`: measured free memory; `overloaded`: sustained load; `queued-ahead`: an earlier ticket waits
 * for the host; `too-large`: no allowed host's budget could ever hold the envelope (never queued); `no-pinned-host`:
 * the pin allows no pool host the request may use (a configuration refusal, never queued).
 */
export type TPoolRefusalReason =
  | 'no-known-host' | 'no-free-slot' | 'no-memory' | 'disk-full' | 'no-budget' | 'harness-share' | 'overloaded' | 'queued-ahead' | 'too-large'
  | 'no-pinned-host';

export interface IPoolPlacementRequest {
  kind: TPoolKind;
  /** Memory the work needs, in GiB (0 when the caller does not know). */
  memGb: number;
  /** kind tab only: the tab's panel type (claude-code when absent). */
  panelType?: string;
  /** kind tab only: a tab role (ADR-0040); any role places on this host. */
  role?: string;
  /** Threads the work keeps busy at its peak; the kind's envelope when absent. */
  threads?: number;
  /** `product` when absent; `control-plane` is a tab class only. */
  class?: TPoolClass;
  /** Only this host: a create whose --cwd is missing on the host the pool chose first. */
  localOnly?: boolean;
  /** Only these hosts (vel-POOL-ENF); any kind. */
  pin?: IPoolPin;
}

export interface IPoolEnvelopeView {
  threads: number;
  memGb: number;
}

export type TPoolPlacement =
  | { ok: true; host: string; local: boolean; reason: string; envelope: IPoolEnvelopeView | null; wouldRefuse?: IPoolWouldRefuse }
  | { ok: false; refusal: TPoolRefusalReason; reason: string; queueable: boolean };

export interface IPoolAcquireResult {
  host: string;
  local: boolean;
  slot: string;
  lease: string;
  expiresAt: string | null;
  reason: string;
  /** The gate-host container to pin for a remote gate (fleet config `pool.gate-host.<host>`), else null. */
  gateHost: string | null;
  class: TPoolClass;
  /** What the slot reserves; a launcher that supports limits passes it on (systemd-run, docker --cpus --memory). */
  envelope: IPoolEnvelopeView;
  /** Shadow mode admitted what enforce mode would refuse (logged and counted). */
  wouldRefuse?: IPoolWouldRefuse;
  /** Set when the caller asked for class control-plane and is not the workspace's enabled orchestrator tab. */
  downgrade?: string;
  /** The ask token the caller sent, echoed (vel-POOL-ENF); null when none was sent. */
  ask: string | null;
  /** The pin the server applied, normalized (vel-POOL-ENF); null when none was asked. */
  pin: IPoolPin | null;
}

/** A queued request (vel-D4): re-ask with `ticket` before `expiresAt` to keep the place. */
export interface IPoolQueuedResult {
  queued: true;
  ticket: string;
  kind: TPoolKind;
  class: TPoolClass;
  position: number;
  of: number;
  reason: string;
  refusal: TPoolRefusalReason;
  expiresAt: string | null;
  retryAfterSeconds: number;
  envelope: IPoolEnvelopeView;
  /** Set when the caller asked for class control-plane and is not the workspace's enabled orchestrator tab. */
  downgrade?: string;
}
