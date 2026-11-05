import type { NextApiRequest, NextApiResponse } from 'next';
import { SESSION_COOKIE, extractCookie, verifySessionToken } from '@/lib/auth';
import { isMissionControlError, MissionControlError } from '@/lib/mission-control-errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('mission-control-http');

export const setMissionHeaders = (res: NextApiResponse): void => {
  res.setHeader('Cache-Control', 'no-store');
};

export const requireMissionHuman = async (req: NextApiRequest): Promise<string> => {
  const token = extractCookie(req.headers.cookie ?? '', SESSION_COOKIE);
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
    throw new MissionControlError(401, 'unauthorized', 'Authentication required');
  }
  return payload.sub;
};

export interface IHumanControlAuthority {
  kind: 'human-control';
  actor: string;
}

export const requireMissionHumanMutation = async (req: NextApiRequest): Promise<IHumanControlAuthority> => {
  const actor = await requireMissionHuman(req);
  requireMissionSameOrigin(req);
  return { kind: 'human-control', actor };
};

const requestOrigin = (req: NextApiRequest): string => {
  const forwardedProtocol = req.headers['x-forwarded-proto'];
  const encrypted = (req.socket as (typeof req.socket & { encrypted?: boolean }) | undefined)?.encrypted === true;
  const protocol = typeof forwardedProtocol === 'string' ? forwardedProtocol.split(',')[0].trim() : encrypted ? 'https' : 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : req.headers.host;
  return `${protocol}://${host}`;
};

export const requireMissionSameOrigin = (req: NextApiRequest): void => {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw new MissionControlError(403, 'forbidden', 'Cross-origin mutation rejected');
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    if (origin !== requestOrigin(req)) {
      throw new MissionControlError(403, 'forbidden', 'Origin does not match this server');
    }
    return;
  }
  if (fetchSite !== 'same-origin') {
    throw new MissionControlError(403, 'forbidden', 'Mutation requests must include this server Origin');
  }
};

export const sendMissionError = (res: NextApiResponse, error: unknown): void => {
  if (isMissionControlError(error)) {
    if (error.code === 'storage-unavailable') {
      log.error({ status: error.status, code: error.code }, 'Mission Control storage failure');
    }
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.current ? { current: error.current } : {}),
      ...(error.detail?.defects ? { defects: error.detail.defects } : {}),
      ...(error.detail?.changes ? { changes: error.detail.changes } : {}),
    });
    return;
  }
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : typeof error;
  const candidateCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const errorCode = typeof candidateCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidateCode)
    ? candidateCode
    : undefined;
  log.error({ errorName, ...(errorCode ? { errorCode } : {}) }, 'Unexpected Mission Control request failure');
  res.status(503).json({ error: 'Mission Control storage unavailable', code: 'storage-unavailable' });
};
