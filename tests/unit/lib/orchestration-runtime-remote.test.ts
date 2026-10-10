import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';

// ADR-0022 slice (b): a remote tab's agent process is proven on its host, never through a local
// pid, so launch and turn evidence (ADR-0021) can retire for a remote worker.

const fx = vi.hoisted(() => ({
  remote: vi.fn(async () => ({ state: 'present' as const, identity: 'remote:ai-server:s:%0:10:11:12:claude' })),
  strict: vi.fn(async () => ({ state: 'present' as const, panePid: 10, identity: 's:%0:10' })),
  local: vi.fn(async () => ({ state: 'present' as const, identity: '11:12:claude' })),
}));

vi.mock('@/lib/tmux', () => ({ observeRemoteProviderProcess: fx.remote, observeSessionStrict: fx.strict }));
vi.mock('@/lib/process-utils', () => ({ observeProviderProcess: fx.local }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ isOrchestrationLaunchPending: () => false }) }));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: vi.fn() }));

const tab = (extra: Partial<ITab> = {}): ITab => ({ id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-a-pane-p-tab-r', panelType: 'claude-code', ...extra });

describe('agent process proof of a remote tab (ADR-0022)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a remote tab is observed on its host, never by a local pid', async () => {
    const { observeOrchestrationProcess } = await import('@/lib/orchestration-runtime');
    expect(await observeOrchestrationProcess(tab({ host: 'ai-server' }))).toEqual({ state: 'present', identity: 'remote:ai-server:s:%0:10:11:12:claude' });
    expect(fx.remote).toHaveBeenCalledWith('pt-ws-a-pane-p-tab-r', 'claude');
    expect(fx.strict).not.toHaveBeenCalled();
    expect(fx.local).not.toHaveBeenCalled();
  });

  it('a local tab keeps the local proof', async () => {
    const { observeOrchestrationProcess } = await import('@/lib/orchestration-runtime');
    expect(await observeOrchestrationProcess(tab())).toEqual({ state: 'present', identity: 's:%0:10:11:12:claude' });
    expect(fx.remote).not.toHaveBeenCalled();
  });
});
