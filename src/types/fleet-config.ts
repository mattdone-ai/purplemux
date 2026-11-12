/** Who changed a fleet value: the admin token, or a workspace's orchestrator tab (ADR-0019). */
export interface IFleetConfigSetter {
  workspaceId: string | null;
  tabId: string | null;
  admin: boolean;
  /** Set for a write by the Portfolio Scrum Master's tab (ADR-0045). */
  role?: 'portfolio-scrum-master';
}

export interface IFleetConfigValue {
  value: string;
  version: number;
  setAt: number;
  setBy: IFleetConfigSetter;
}

export interface IFleetConfigChange {
  key: string;
  /** null: the key was unset before this change. */
  oldValue: string | null;
  /** null: this change unset the key. */
  newValue: string | null;
  version: number;
  at: number;
  by: IFleetConfigSetter;
  /** Why (ADR-0045): required of the Portfolio Scrum Master, optional for the admin token. */
  reason?: string;
}

export interface IFleetConfigState {
  values: Record<string, IFleetConfigValue>;
  /**
   * The last version of every key ever set, unset ones included, so a key set
   * again after an unset never repeats a version an `--expect-version` saw.
   */
  versions: Record<string, number>;
  /** The last FLEET_HISTORY_MAX changes, oldest first. */
  history: IFleetConfigChange[];
}

export type TFleetConfigErrorCode = 'config-invalid' | 'config-not-found' | 'config-version-conflict' | 'forbidden';
