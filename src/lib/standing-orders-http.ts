import type { NextApiResponse } from 'next';
import { isCodedError } from '@/lib/coded-error';
import { createLogger } from '@/lib/logger';
import { getStatusManager } from '@/lib/status-manager';
import type { StandingOrderError, TStandingOrderErrorCode } from '@/lib/standing-orders';
import type { IStandingOrderDeps } from '@/lib/standing-orders-service';
import { getWorkspaces } from '@/lib/workspace-store';

const log = createLogger('standing-orders');

const STATUS: Record<TStandingOrderErrorCode, number> = {
  'so-invalid': 400,
  'so-too-large': 400,
  forbidden: 403,
  'so-not-found': 404,
  'so-unreadable': 409,
  'so-struck': 409,
};

/** Every refusal carries `code`, which the CLI maps to its exit (ADR-0016). */
export const sendStandingOrderError = (res: NextApiResponse, err: unknown): void => {
  if (isCodedError<StandingOrderError>(err, 'StandingOrderError', STATUS)) {
    res.status(STATUS[err.code]).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`standing order route failed: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'standing order operation failed', code: 'so-internal' });
};

export const standingOrderDeps = (): IStandingOrderDeps => ({
  now: () => Date.now(),
  workspaceIds: async () => (await getWorkspaces()).workspaces.map((ws) => ws.id),
  refreshPrompt: async (workspaceId) => {
    const { writeClaudePromptFile } = await import('@/lib/claude-prompt');
    await writeClaudePromptFile({ id: workspaceId });
  },
  liveAgentTabs: (workspaceId) => getStatusManager().liveAgentTabs(workspaceId),
  route: (event) => getStatusManager().routeTabEvent(event),
});
