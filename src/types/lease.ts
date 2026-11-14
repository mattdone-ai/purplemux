import type { TCallerIdentity } from '@/types/identity';

export interface ILeaseHolder {
  workspaceId: string | null;
  tabId: string | null;
  tabName: string | null;
  verified: boolean;
  /** How the holder was named (story 36); absent on leases taken before it. */
  identity?: TCallerIdentity;
  /** The global token. Shown as `admin`, never as a human (ADR-0010). */
  admin: boolean;
}

export interface ILease {
  name: string;
  kind: string;
  resource: string;
  holder: ILeaseHolder;
  epic: string | null;
  note: string | null;
  acquiredAt: string;
  renewedAt: string;
  ttlSeconds: number | null;
  expiresAt: string | null;
  survivesTab: boolean;
}

export interface ILeaseState {
  leases: ILease[];
}

export type THolderState = 'live' | 'agent-gone' | 'closed' | 'admin';

export interface ILeaseView extends Omit<ILease, 'holder'> {
  holder: ILeaseHolder & { workspaceName: string | null };
  ageSeconds: number;
  expiresInSeconds: number | null;
  holderState: THolderState;
}

/** A human session that breaks a lease from Mission Control (ADR-0029 §8): its session subject. */
export interface ILeaseHumanBreaker {
  human: string;
}

/**
 * The Portfolio Scrum Master's verified tab breaking a lease (ADR-0047, owner order): its holder fields, its role, and
 * the selection that made it the Scrum Master, as the audit names them.
 */
export interface ILeaseScrumMasterBreaker extends ILeaseHolder {
  role: 'portfolio-scrum-master';
  selection: { actor: string; updatedAt: number; managerWorkspaceId: string; managerTabId: string };
}

export type TLeaseReleaseReason =
  | 'released'
  | 'broken'
  | 'release-epic'
  | 'expired'
  | 'holder-tab-closed'
  | 'holder-tab-gone'
  | 'holder-agent-gone';

export type TLeaseErrorCode =
  | 'lease-policy'
  | 'lease-held'
  | 'lease-held-by-other'
  | 'lease-not-found'
  | 'caller-unresolved'
  | 'forbidden';
