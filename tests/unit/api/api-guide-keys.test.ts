import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_ONLY_KEYS } from '@/lib/fleet-config-http';
import { FLEET_CONFIG_KEYS } from '@/lib/fleet-status-snapshot';
import { FLAG_ALERT_CONFIG_KEYS } from '@/lib/flag-alerts';
import { FLOW_CONFIG_KEYS } from '@/lib/flow-flags';
import { AUTO_ANSWER_KEY } from '@/lib/mission-control-auto-answer';
import { QUESTION_MIN_VERSION_KEY } from '@/lib/mission-question-config';
import { REMOTE_CALLBACK_ALLOW_HOSTS_KEY, REMOTE_CALLBACK_URL_KEY, REMOTE_HOSTS_KEY, REMOTE_TAILNET_SUFFIX_KEY } from '@/lib/remote-host';
import { TAB_CAP_KEY } from '@/lib/tab-cap';
import { IDLE_NUDGE_CONFIG_KEY, WAIT_BACKSTOP_CONFIG_KEY } from '@/lib/turn-end';
import { ROTATE_AT_CONFIG_KEY } from '@/lib/context-lifecycle';
import { CURATOR_KEYS } from '@/lib/curator-service';
import { STOP_PAYLOAD_CONFIG_KEY, TURN_END_SOURCE_CONFIG_KEY } from '@/lib/turn-end-row';
import { POOL_BUDGET_FIELDS, POOL_BUDGET_KEY_PREFIX, POOL_ENVELOPE_KEY_PREFIX, POOL_HARNESS_SHARE_KEY, POOL_MODE_KEY, POOL_TAB_PLACE_KEY_PREFIX } from '@/lib/pool';

vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => ({ type: 'admin' }) }));

// The fleet config keys the server reads, from the constants that read them. A story that adds a
// key adds its constant here and its entry to "Keys in use" (architecture §4.10).
const SERVER_KEYS = [
  IDLE_NUDGE_CONFIG_KEY,
  WAIT_BACKSTOP_CONFIG_KEY,
  ...Object.values(FLEET_CONFIG_KEYS),
  REMOTE_HOSTS_KEY,
  REMOTE_CALLBACK_URL_KEY,
  `${REMOTE_CALLBACK_URL_KEY}.<host>`,
  REMOTE_TAILNET_SUFFIX_KEY,
  REMOTE_CALLBACK_ALLOW_HOSTS_KEY,
  TAB_CAP_KEY,
  `${TAB_CAP_KEY}.<workspaceId>`,
  'pool.slots.<host>.<gate|build|mutation|browser|test-service|tab>',
  ...POOL_BUDGET_FIELDS.map((field) => `${POOL_BUDGET_KEY_PREFIX}<host>.${field}`),
  `${POOL_ENVELOPE_KEY_PREFIX}<kind>.threads`,
  `${POOL_ENVELOPE_KEY_PREFIX}<kind>.mem-gb`,
  POOL_HARNESS_SHARE_KEY,
  POOL_MODE_KEY,
  'pool.fallback.<alias>',
  'pool.gate-host.<host>',
  `${POOL_TAB_PLACE_KEY_PREFIX}<workspaceId>`,
  ...Object.values(FLOW_CONFIG_KEYS),
  AUTO_ANSWER_KEY,
  QUESTION_MIN_VERSION_KEY,
  ...Object.values(FLAG_ALERT_CONFIG_KEYS),
  ROTATE_AT_CONFIG_KEY,
  ...Object.values(CURATOR_KEYS),
  TURN_END_SOURCE_CONFIG_KEY,
  STOP_PAYLOAD_CONFIG_KEY,
];

const keysInUse = async (): Promise<string> => {
  const { default: handler } = await import('@/pages/api/cli/api-guide');
  let body = '';
  const res = {
    status() { return this; },
    json() { return this; },
    send(payload: unknown) { body = String(payload); return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
  return body.slice(body.indexOf('Keys in use:'), body.indexOf('GET /api/cli/fleet-config'));
};

const isKeyLine = (line: string): boolean => /^ {2}\S/.test(line);

/** One entry: its key lines (two-space indent) and the deeper-indented text under them. */
const entryOf = (section: string, key: string): string | null => {
  const lines = section.split('\n');
  const start = lines.findIndex((line) => isKeyLine(line) && line.trim().split(/\s+/).includes(key));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && isKeyLine(lines[end])) end++;
  while (end < lines.length && /^ {3,}\S/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
};

/** An entry wraps its text at any space, so the marker is matched across a line break. */
const marksAdminOnly = (entry: string | null): boolean => /Admin\s+token\s+only/.test(entry ?? '');

describe('api-guide "Keys in use"', () => {
  it('lists every fleet config key the server reads', async () => {
    const section = await keysInUse();
    const missing = SERVER_KEYS.filter((key) => entryOf(section, key) === null);
    expect(`missing=[${missing.join(', ')}]`).toBe('missing=[]');
  });

  it('marks every admin-only key as written by the admin token only', async () => {
    const section = await keysInUse();
    const unmarked = SERVER_KEYS.filter((key) => ADMIN_ONLY_KEYS.test(key) && !marksAdminOnly(entryOf(section, key)));
    expect(`unmarked=[${unmarked.join(', ')}]`).toBe('unmarked=[]');
  });

  it('reads the admin-only marker across a wrapped line', () => {
    const wrapped = '  attention.auto-answer.bookkeeping-minutes\n               off (an invalid value is logged). Admin token\n               only (exit 3 forbidden for a tab).';
    expect(entryOf(wrapped, 'attention.auto-answer.bookkeeping-minutes')).not.toBeNull();
    expect(marksAdminOnly(entryOf(wrapped, 'attention.auto-answer.bookkeeping-minutes'))).toBe(true);
    expect(marksAdminOnly('  x.y\n               written by an orchestrator')).toBe(false);
  });

  it('holds the keys the story 11 acceptance criteria name', () => {
    expect(SERVER_KEYS).toEqual(expect.arrayContaining([
      'fleet-status.stall-minutes',
      'fleet-status.waiting-long-minutes',
      'fleet-status.unanswered-minutes',
      'fleet-status.composer-minutes',
      'remote.hosts',
      'remote.callback-url',
      'remote.callback-allow-hosts',
      'tabs.cap-per-workspace',
    ]));
  });
});
