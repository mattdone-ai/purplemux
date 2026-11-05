import type { NextApiRequest } from 'next';
import type { ICaller } from '@/lib/caller';
import { isAgentPanelType } from '@/lib/agent-panel-types';
import { collectAllTabs } from '@/lib/layout-tree';
import type { TTabAdmit } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import type { IFleetWip } from '@/types/fleet-status';
import type { ILayoutData } from '@/types/terminal';

// The WIP cap on agent tab creation (ADR-0027). The count and the add share the
// layout lock: `addTabToPane` runs the admission inside it, before any session
// exists, so two creates at `cap − 1` cannot both pass.

const log = createLogger('tab-cap');

export const TAB_CAP_KEY = 'tabs.cap-per-workspace';
export const DEFAULT_TAB_CAP = 8;
const TAB_CAP_MAX = 200;
export const OVER_CAP_REASON_MAX = 500;

export type TTabCapSource = 'workspace-config' | 'workspace-config-invalid' | 'fleet-config' | 'default' | 'default-invalid';

/** The per-workspace override of the fleet cap (v2 note n-xA8sc4Tr0X): `tabs.cap-per-workspace.<workspaceId>`. */
export const workspaceTabCapKey = (workspaceId: string): string => `${TAB_CAP_KEY}.${workspaceId}`;

export interface ITabCap {
  cap: number;
  capSource: TTabCapSource;
  /** Why a stored workspace value was not used (capSource workspace-config-invalid). */
  capReason?: string;
}

export interface ITabCountView extends IFleetWip {
  workspaceId: string;
  capSource: TTabCapSource;
  capReason?: string;
}

export const parseTabCap = (raw: string | null, key: string = TAB_CAP_KEY): ITabCap & { reason: string | null } => {
  if (raw === null) return { cap: DEFAULT_TAB_CAP, capSource: 'default', reason: null };
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return { cap: DEFAULT_TAB_CAP, capSource: 'default-invalid', reason: `${key} is ${JSON.stringify(raw)}, not an integer` };
  }
  const value = Number(text);
  if (value < 1 || value > TAB_CAP_MAX) {
    return { cap: DEFAULT_TAB_CAP, capSource: 'default-invalid', reason: `${key} is ${value}, outside 1..${TAB_CAP_MAX}` };
  }
  return { cap: value, capSource: 'fleet-config', reason: null };
};

const g = globalThis as unknown as { __ptTabCapLogged?: Map<string, string> };
if (!g.__ptTabCapLogged) g.__ptTabCapLogged = new Map();

const logOnce = (scope: string, line: string, warn: boolean): void => {
  if (g.__ptTabCapLogged!.get(scope) === line) return;
  g.__ptTabCapLogged!.set(scope, line);
  if (warn) log.warn(line);
  else log.info(line);
};

/**
 * The cap and where it came from (ADR-0019: a tool states its source). A
 * workspace's own key wins over the fleet key; an invalid workspace value
 * falls back to the fleet answer and is logged with its reason. Logged when
 * the answer changes, not on every read: the fleet view reads it each poll.
 * A config read that fails is thrown, never read as "no cap".
 */
export const readTabCap = async (config: (key: string) => Promise<string | null>, workspaceId?: string): Promise<ITabCap> => {
  if (workspaceId) {
    const key = workspaceTabCapKey(workspaceId);
    const raw = await config(key);
    if (raw !== null) {
      const own = parseTabCap(raw, key);
      if (own.capSource === 'fleet-config') {
        logOnce(workspaceId, `WIP cap ${own.cap} for ${workspaceId} (source workspace-config)`, false);
        return { cap: own.cap, capSource: 'workspace-config' };
      }
      // The stored value is wrong and the answer says so (review r2 F5): the cap is the fleet answer, the source is not.
      const fleet = parseTabCap(await config(TAB_CAP_KEY));
      const capReason = `${own.reason}; the ${fleet.capSource === 'fleet-config' ? 'fleet value' : 'default'} ${fleet.cap} applies`;
      logOnce(workspaceId, `WIP cap ${fleet.cap} for ${workspaceId} (source workspace-config-invalid: ${capReason})`, true);
      return { cap: fleet.cap, capSource: 'workspace-config-invalid', capReason };
    }
  }
  const { cap, capSource, reason } = parseTabCap(await config(TAB_CAP_KEY));
  logOnce('*', reason ? `WIP cap ${cap} (source ${capSource}: ${reason})` : `WIP cap ${cap} (source ${capSource})`, !!reason);
  return { cap, capSource };
};

export const countAgentTabs = (layout: ILayoutData): number =>
  collectAllTabs(layout.root).filter((tab) => isAgentPanelType(tab.panelType)).length;

export const wipOf = (count: number, cap: number): IFleetWip => ({ count, cap, overCap: count > cap });

export const tabCountView = (workspaceId: string, count: number, tabCap: ITabCap): ITabCountView => ({
  workspaceId, count, cap: tabCap.cap, capSource: tabCap.capSource, overCap: count > tabCap.cap,
  ...(tabCap.capReason ? { capReason: tabCap.capReason } : {}),
});

export class WipCapError extends Error {
  readonly code = 'wip-cap';

  constructor(readonly workspaceId: string, readonly count: number, readonly tabCap: ITabCap) {
    super(`${workspaceId} holds ${count} of ${tabCap.cap} agent tabs`);
    this.name = 'WipCapError';
  }

  get body(): Record<string, unknown> {
    return {
      code: this.code,
      error: this.message,
      workspaceId: this.workspaceId,
      count: this.count,
      cap: this.tabCap.cap,
      capSource: this.tabCap.capSource,
      ...(this.tabCap.capReason ? { capReason: this.tabCap.capReason } : {}),
    };
  }
}

/**
 * One create's admission. `admit` runs under the layout lock; afterwards
 * `wip()` is the count with the new tab, and `passedCap()` says the create went
 * through only because the orchestrator passed the cap.
 */
export const wipAdmission = (workspaceId: string, tabCap: ITabCap, overCap: boolean) => {
  let before: number | null = null;
  const admit: TTabAdmit = (layout) => {
    const count = countAgentTabs(layout);
    if (count >= tabCap.cap && !overCap) return { ok: false, refusal: new WipCapError(workspaceId, count, tabCap) };
    before = count;
    return { ok: true };
  };
  return {
    admit,
    wip: (): IFleetWip | null => (before === null ? null : wipOf(before + 1, tabCap.cap)),
    passedCap: (): boolean => before !== null && before >= tabCap.cap,
  };
};

export type TOverCapCheck =
  | { ok: true; reason: string | null }
  | { ok: false; status: number; body: Record<string, unknown> };

/** The shape of the body field `overCap: {reason}` (1..500 characters). */
export const checkOverCapField = (raw: unknown): TOverCapCheck => {
  if (raw === undefined) return { ok: true, reason: null };
  const reason = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { reason?: unknown }).reason : undefined;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > OVER_CAP_REASON_MAX) {
    return {
      ok: false,
      status: 400,
      body: { code: 'invalid-request', error: `overCap needs { reason }: 1..${OVER_CAP_REASON_MAX} characters (ADR-0027)` },
    };
  }
  return { ok: true, reason };
};

/**
 * Only a verified tab that is its workspace's enabled orchestrator passes the
 * cap (ADR-0027, ruling R1). The admin token cannot create a tab (ADR-0021), so
 * it has no path here either.
 */
export const isOverCapCaller = async (
  caller: ICaller | null,
  workspaceId: string,
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>,
): Promise<boolean> => {
  if (!caller || caller.admin || !caller.verified || caller.workspaceId !== workspaceId || !caller.tabId) return false;
  return isWorkspaceOrchestrator(workspaceId, caller.tabId);
};

export const OVER_CAP_FORBIDDEN = {
  code: 'forbidden',
  error: "only the workspace's verified, enabled orchestrator tab may pass the WIP cap (--over-cap, ADR-0027)",
};

/** The cap from the fleet-config store; an unreadable store throws (fail closed). */
export const readStoredTabCap = async (workspaceId?: string): Promise<ITabCap> => {
  const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
  const state = await readFleetConfig();
  return readTabCap(async (key) => valueOf(state, key)?.value ?? null, workspaceId);
};

/** Outside the layout lock: an answer for a reader, never an admission. A workspace with no layout yet holds no tab. */
export const readTabCount = async (workspaceId: string): Promise<ITabCountView> => {
  const { readWorkspaceLayout } = await import('@/lib/workspace-layout-read');
  const [tabCap, layout] = await Promise.all([readStoredTabCap(workspaceId), readWorkspaceLayout(workspaceId)]);
  return tabCountView(workspaceId, layout ? countAgentTabs(layout) : 0, tabCap);
};

export interface IAgentCreateDeps {
  resolveCaller: (req: NextApiRequest) => Promise<ICaller | null>;
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>;
  readTabCap: (workspaceId: string) => Promise<ITabCap>;
}

const defaultDeps: IAgentCreateDeps = {
  resolveCaller: async (req) => (await import('@/lib/caller')).resolveCaller(req),
  isWorkspaceOrchestrator: async (workspaceId, tabId) =>
    (await import('@/lib/lease-http')).leaseAuthority.isWorkspaceOrchestrator(workspaceId, tabId),
  readTabCap: readStoredTabCap,
};

export type TAgentCreateAdmission =
  | { ok: true; admission: ReturnType<typeof wipAdmission> | null; overCapReason: string | null; caller: ICaller | null }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Everything `POST /api/cli/tabs` decides before the create: the `overCap`
 * field and its authority, then, for an agent tab, the cap. The count itself
 * waits for the layout lock (`admission.admit`).
 */
export const admitAgentCreate = async (
  req: NextApiRequest,
  workspaceId: string,
  panelType: string,
  overCapRaw: unknown,
  deps: IAgentCreateDeps = defaultDeps,
): Promise<TAgentCreateAdmission> => {
  const field = checkOverCapField(overCapRaw);
  if (!field.ok) return field;
  let caller: ICaller | null = null;
  if (field.reason !== null) {
    caller = await deps.resolveCaller(req);
    if (!(await isOverCapCaller(caller, workspaceId, deps.isWorkspaceOrchestrator))) {
      return { ok: false, status: 403, body: OVER_CAP_FORBIDDEN };
    }
  }
  if (!isAgentPanelType(panelType)) return { ok: true, admission: null, overCapReason: field.reason, caller };
  let tabCap: ITabCap;
  try {
    tabCap = await deps.readTabCap(workspaceId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 503,
      body: { code: 'config-store-unreadable', error: `fleet config could not be read for ${TAB_CAP_KEY} or ${workspaceTabCapKey(workspaceId)}; agent tabs are refused until it can (${detail})` },
    };
  }
  return { ok: true, admission: wipAdmission(workspaceId, tabCap, field.reason !== null), overCapReason: field.reason, caller };
};

export const auditOverCap = (
  entry: { workspaceId: string; tabId: string; wip: IFleetWip; reason: string; caller: ICaller },
): Promise<boolean> =>
  import('@/lib/coordination-audit').then(({ appendCoordinationAudit }) => appendCoordinationAudit({
    event: 'tab-over-cap',
    workspaceId: entry.workspaceId,
    tabId: entry.tabId,
    count: entry.wip.count,
    cap: entry.wip.cap,
    reason: entry.reason,
    by: {
      workspaceId: entry.caller.workspaceId,
      tabId: entry.caller.tabId,
      verified: entry.caller.verified,
      identity: entry.caller.identity,
    },
  }));
