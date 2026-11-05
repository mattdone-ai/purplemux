import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller, type ICaller } from '@/lib/caller';
import { findTab } from '@/lib/cli-utils';
import { isAgentPanelType } from '@/lib/agent-panel-types';

/**
 * Who may interrupt a turn with `tab steer`, and by default (harness-flow-loop-2 story 14).
 *
 * An Escape abandons the target's turn. The old Scrum Master passed `--no-interrupt` on 540 of 540
 * steers; its rotated successor left it off 16 times, and seven interrupts of the orchestrator in one
 * QA window produced a phantom owner hold. A convention that a rotation can drop is not a safe
 * default, so the safe value becomes the default for the callers that rotate:
 *
 * - An agent tab (a caller tab of type claude-code, codex-cli or grok-cli, named by its tab token or
 *   its session, ADR-0010) does not interrupt unless it asks with `interrupt: true` and a reason.
 * - Every other caller (a terminal tab, a workspace token that names no tab) keeps the old default:
 *   interrupt. The admin token and the owner's cookie never reach the route (ADR-0021: mutations
 *   are confined to the caller workspace), so the rule for them is this "other" arm.
 * - `interrupt: false` stays accepted for every caller.
 *
 * An explicit `interrupt: true` always carries a reason, for every caller: the audit row
 * (`steer-interrupt`) then says why a turn was abandoned. A reason without `interrupt: true` is
 * refused, because nothing would read it.
 */

export const STEER_REASON_MAX = 500;

export type TSteerCallerKind = 'agent' | 'other';

export interface ISteerCaller {
  kind: TSteerCallerKind;
  caller: ICaller | null;
  /** The caller tab's panel type when the caller names a tab of its workspace. */
  panelType: string | null;
}

export type TSteerInterruptDecision =
  | { ok: true; interrupt: boolean; explicit: boolean; reason: string | null }
  | { ok: false; error: string; code: 'invalid-request' | 'steer-reason-invalid' };

/** Decide the interrupt for one steer body. Pure: the route resolves the caller kind first. */
export const decideSteerInterrupt = (
  body: { interrupt?: unknown; reason?: unknown },
  kind: TSteerCallerKind,
): TSteerInterruptDecision => {
  const { interrupt, reason } = body;
  if (interrupt !== undefined && typeof interrupt !== 'boolean') {
    return { ok: false, error: 'interrupt must be a boolean', code: 'invalid-request' };
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return { ok: false, error: 'reason must be a string', code: 'steer-reason-invalid' };
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (interrupt === true) {
    if (!trimmed) {
      return { ok: false, error: 'interrupt: true needs a reason (--interrupt --reason "<why the turn must stop>")', code: 'steer-reason-invalid' };
    }
    if (trimmed.length > STEER_REASON_MAX) {
      return { ok: false, error: `reason must be at most ${STEER_REASON_MAX} characters (got ${trimmed.length})`, code: 'steer-reason-invalid' };
    }
    return { ok: true, interrupt: true, explicit: true, reason: trimmed };
  }
  if (reason !== undefined) {
    return { ok: false, error: 'reason is read only with interrupt: true (--interrupt --reason)', code: 'steer-reason-invalid' };
  }
  if (interrupt === false) return { ok: true, interrupt: false, explicit: true, reason: null };
  return { ok: true, interrupt: kind !== 'agent', explicit: false, reason: null };
};

/** An agent caller is a tab of an agent panel type in the caller's own workspace. */
export const resolveSteerCaller = async (req: NextApiRequest, res?: NextApiResponse): Promise<ISteerCaller> => {
  const caller = await resolveCaller(req, res).catch(() => null);
  if (!caller?.tabId || !caller.workspaceId) return { kind: 'other', caller, panelType: null };
  const found = await findTab(caller.workspaceId, caller.tabId).catch(() => null);
  const panelType = found ? found.tab.panelType ?? 'terminal' : null;
  return { kind: isAgentPanelType(panelType) ? 'agent' : 'other', caller, panelType };
};
