import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { getLivenessManager } from '@/lib/liveness-manager';
import type { IBackgroundJob } from '@/types/liveness';
import { TAB_NOT_FOUND_BODY } from '@/lib/cli-error';

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  if (req.method === 'GET') {
    if (!(await authorizeWorkspace(req, res, workspaceId))) return;
    if (!(await findTab(workspaceId, tabId))) return res.status(404).json(TAB_NOT_FOUND_BODY);
    const { backgroundJobs } = await getLivenessManager().statusForTab(tabId);
    return res.status(200).json({ tabId, workspaceId, backgroundJobs });
  }

  if (req.method === 'POST') {
    const scope = await authorizeWorkspaceInput(req, res, workspaceId);
    if (!scope) return;
    const target = await findTab(workspaceId, tabId);
    if (!target) return res.status(404).json(TAB_NOT_FOUND_BODY);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const pid = Number(body.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: 'pid must be a positive integer' });
    }
    const label = body.label === undefined ? undefined : String(body.label);
    if (label !== undefined && !LABEL_RE.test(label)) {
      return res.status(400).json({ error: 'label must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}' });
    }
    const stderrFile = body.stderrFile === undefined ? undefined : String(body.stderrFile);
    const exitCodeFile = body.exitCodeFile === undefined ? undefined : String(body.exitCodeFile);
    for (const [name, file] of [['stderrFile', stderrFile], ['exitCodeFile', exitCodeFile]] as const) {
      if (file !== undefined && !path.isAbsolute(file)) {
        return res.status(400).json({ error: `${name} must be an absolute path` });
      }
    }

    const notify = body.notify === undefined ? undefined : body.notify;
    if (notify !== undefined && notify !== 'self' && notify !== 'orchestrator') {
      return res.status(400).json({ error: 'notify must be self or orchestrator' });
    }

    // The pid was taken where the caller runs (D63): the verified caller tab's host, else the target tab's.
    const callerTabId = scope.type === 'workspace' && scope.tabVerified && scope.tabId && scope.tabId !== tabId ? scope.tabId : null;
    const caller = callerTabId ? await findTab(workspaceId, callerTabId) : null;
    if (callerTabId && !caller) {
      return res.status(409).json({
        error: `the calling tab ${callerTabId} no longer exists, so no host can be proven for pid ${pid}; register it from a live tab`,
        code: 'caller-tab-gone',
      });
    }
    const host = (caller ?? target).tab.host ?? null;

    const job: IBackgroundJob = {
      workspaceId,
      tabId,
      pid,
      host,
      ...(label !== undefined ? { label } : {}),
      ...(stderrFile !== undefined ? { stderrFile } : {}),
      ...(exitCodeFile !== undefined ? { exitCodeFile } : {}),
      ...(notify === 'self' ? { notify } : {}),
      registeredAt: Date.now(),
    };
    await getLivenessManager().registerJob(job);
    return res.status(200).json({ tabId, workspaceId, job });
  }

  if (req.method === 'DELETE') {
    if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;
    const pidRaw = typeof req.query.pid === 'string' ? Number(req.query.pid) : undefined;
    if (pidRaw !== undefined && (!Number.isInteger(pidRaw) || pidRaw <= 0)) {
      return res.status(400).json({ error: 'pid must be a positive integer' });
    }
    const removed = await getLivenessManager().unregisterJobs(workspaceId, tabId, pidRaw);
    return res.status(200).json({ tabId, workspaceId, removed });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
