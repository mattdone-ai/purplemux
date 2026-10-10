import { observeRemoteProviderProcess, observeSessionStrict } from '@/lib/tmux';
import { observeProviderProcess, type TStrictRuntimeObservation } from '@/lib/process-utils';
import { getStatusManager } from '@/lib/status-manager';
import { getCodexModelStatus } from '@/lib/providers/codex/model-observation';
import type { ITab } from '@/types/terminal';

/** Must run under mapping and target lifecycle guards. Cached CLI state is not runtime evidence. */
export const observeOrchestrationRuntime = async (tab: ITab): Promise<TStrictRuntimeObservation> => {
  if (tab.orchestrationActivity?.launch || tab.codexLaunchRuntime?.pending || getStatusManager().isOrchestrationLaunchPending(tab.id)) return { state: 'unknown', reason: 'managed launch is pending' };
  return observeOrchestrationProcess(tab);
};

/** Strict process identity, also used to attribute lifecycle acknowledgments. */
export const observeOrchestrationProcess = async (tab: ITab): Promise<TStrictRuntimeObservation> => {
  const provider = tab.panelType === 'claude-code' ? 'claude' : tab.panelType === 'codex-cli' ? 'codex' : tab.panelType === 'grok-cli' ? 'grok' : null;
  if (!provider) return { state: 'unknown', reason: 'candidate is not an agent tab' };
  // A remote tab's process lives on its host: observed there, never through a local pid (ADR-0022).
  if (tab.host) return observeRemoteProviderProcess(tab.sessionName, provider);
  const session = await observeSessionStrict(tab.sessionName);
  if (session.state !== 'present') return session;
  const process = await observeProviderProcess(session.panePid, provider);
  if (process.state !== 'present') return process;
  return { state: 'present', identity: `${session.identity}:${process.identity}` };
};

export const candidateModelUsable = async (tab: ITab): Promise<boolean> => {
  if (tab.panelType !== 'codex-cli') return true;
  const model = await getCodexModelStatus(tab);
  return model.status !== 'unknown' && model.status !== 'mismatch';
};
