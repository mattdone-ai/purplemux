import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCliScope } from '@/lib/workspace-token';
import { checkHandoff, parseUtcStamp } from '@/lib/handoff-check';

// `purplemux handoff check <path>` (ADR-0036 §4): the CLI reads the file and sends its text here, so the command
// and the rotation run the one checker. Any CLI scope may ask: the answer is about the text it sent.

const UTC_FORMS = 'YYYY-MM-DDTHH:MM[:SS[.ffffff]] ending in Z or +00:00';

type TTime = { ok: true; ms: number | null } | { ok: false; error: string };

const readTime = (value: unknown, field: string): TTime => {
  if (value === undefined || value === null) return { ok: true, ms: null };
  const micros = typeof value === 'string' ? parseUtcStamp(value) : null;
  if (micros === null) return { ok: false, error: `${field} must be a UTC time (${UTC_FORMS}), got ${JSON.stringify(value)}` };
  return { ok: true, ms: Math.floor(micros / 1000) };
};

const handler = (req: NextApiRequest, res: NextApiResponse) => {
  if (!resolveCliScope(req, { response: res })) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  if (typeof body.text !== 'string') return res.status(400).json({ error: 'text must be the handoff file as a string', code: 'invalid-request' });
  const now = readTime(body.now, 'now');
  if (!now.ok) return res.status(400).json({ error: now.error, code: 'invalid-request' });
  const requested = readTime(body.rotateRequestedAt, 'rotateRequestedAt');
  if (!requested.ok) return res.status(400).json({ error: requested.error, code: 'invalid-request' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(checkHandoff(body.text, now.ms ?? Date.now(), requested.ms));
};

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default handler;
