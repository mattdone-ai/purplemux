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
 * - `agent`: a caller tab of type claude-code, codex-cli or grok-cli, named by its tab token or its
 *   session (ADR-0010). Default: no interrupt. It interrupts only with `interrupt: true` and a reason.
 * - `other`: a caller tab of any other type (a terminal tab, where a person types). Default: interrupt.
 * - `unidentified`: a caller that names no tab (a workspace token alone), a tab the layout does not
 *   hold, or a lookup that failed. Default: interrupt, so the human CLI path stays as it was.
 * - `interrupt: false` stays accepted for every caller.
 *
 * The classification is ADVISORY. It stops a rotated agent from interrupting by accident; it is not
 * access control: a process that holds the workspace token and sends no tab identity is
 * `unidentified` and gets the interrupt default. The audit is the record: EVERY steer that
 * interrupts (by default or on request) writes one `steer-interrupt` line with the caller kind and
 * the reason (`(none given)` when the default interrupted).
 *
 * An explicit `interrupt: true` always carries a reason, for every caller. A reason without
 * `interrupt: true` is refused, because nothing would read it.
 */

/** The reason an audit line records when the interrupt was the caller's default. */
export const STEER_NO_REASON = '(none given)';

export const STEER_REASON_MAX = 500;

export type TSteerCallerKind = 'agent' | 'other' | 'unidentified';

export interface ISteerCaller {
  kind: TSteerCallerKind;
  caller: ICaller | null;
  /** The caller tab's panel type when the caller names a tab of its workspace. */
  panelType: string | null;
}

export type TSteerInterruptDecision =
  | { ok: true; interrupt: boolean; explicit: boolean; reason: string | null }
  | { ok: false; error: string; code: 'invalid-request' | 'steer-reason-invalid' };

const describeValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return `${typeof value} ${String(value)}`;
};

const REASON_EXPECTED = `expected a text of 1..${STEER_REASON_MAX} characters (--interrupt --reason "<why the turn must stop>")`;

/** Decide the interrupt for one steer body. Pure: the route resolves the caller kind first. */
export const decideSteerInterrupt = (
  body: { interrupt?: unknown; reason?: unknown },
  kind: TSteerCallerKind,
): TSteerInterruptDecision => {
  const { interrupt, reason } = body;
  if (interrupt !== undefined && typeof interrupt !== 'boolean') {
    return { ok: false, error: `interrupt: saw ${describeValue(interrupt)}; expected true or false`, code: 'invalid-request' };
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return { ok: false, error: `reason: saw ${describeValue(reason)}; ${REASON_EXPECTED}`, code: 'steer-reason-invalid' };
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (interrupt === true) {
    if (!trimmed) {
      const saw = reason === undefined ? 'interrupt: true with no reason' : 'interrupt: true with a blank reason';
      return { ok: false, error: `reason: saw ${saw}; ${REASON_EXPECTED}`, code: 'steer-reason-invalid' };
    }
    if (trimmed.length > STEER_REASON_MAX) {
      return { ok: false, error: `reason: saw ${trimmed.length} characters; expected at most ${STEER_REASON_MAX}`, code: 'steer-reason-invalid' };
    }
    return { ok: true, interrupt: true, explicit: true, reason: trimmed };
  }
  if (reason !== undefined) {
    const saw = interrupt === false ? 'a reason with interrupt: false' : 'a reason without interrupt';
    return { ok: false, error: `reason: saw ${saw}; expected interrupt: true with the reason (--interrupt --reason), or no reason`, code: 'steer-reason-invalid' };
  }
  if (interrupt === false) return { ok: true, interrupt: false, explicit: true, reason: null };
  return { ok: true, interrupt: kind !== 'agent', explicit: false, reason: null };
};

/**
 * The caller kind. `agent` and `other` need a caller tab that the caller's own workspace layout
 * holds; everything else is `unidentified`, including a lookup that throws.
 */
export const resolveSteerCaller = async (req: NextApiRequest, res?: NextApiResponse): Promise<ISteerCaller> => {
  const caller = await resolveCaller(req, res).catch(() => null);
  if (!caller?.tabId || !caller.workspaceId) return { kind: 'unidentified', caller, panelType: null };
  const found = await findTab(caller.workspaceId, caller.tabId).catch(() => null);
  if (!found) return { kind: 'unidentified', caller, panelType: null };
  const panelType = found.tab.panelType ?? 'terminal';
  return { kind: isAgentPanelType(panelType) ? 'agent' : 'other', caller, panelType };
};
