/** A tab's own rotate threshold (ADR-0036 §1): a token count, `off`, or absent for the fleet value. */
export type TRotateAt = number | 'off';

/**
 * Where a seat is in its rotation (ADR-0036 §2), also the seat item's ledger `state`:
 * `watching` until the threshold or a compaction makes a rotation due; `rotate-requested` once ROTATE was typed;
 * `handoff-ready` once the seat ended a turn with HANDOFF-READY and the check waits for it at its prompt;
 * `rotating` while `tab restart --clear` runs; `rotation-alarm` after a second failed check, until a check passes.
 */
export type TSeatPhase = 'watching' | 'rotate-requested' | 'handoff-ready' | 'rotating' | 'rotation-alarm';

/** A tab created with `--handoff`: the only tabs that rotate. */
export interface ISeatTab {
  workspaceId: string;
  tabId: string;
  tabName: string;
  /** Absolute path of the seat's handoff file. */
  handoffPath: string;
  rotateAt: TRotateAt | null;
}
