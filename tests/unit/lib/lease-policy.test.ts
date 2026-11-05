import { describe, expect, it } from 'vitest';
import {
  LEASE_KINDS,
  LeasePolicyError,
  OTHER_KIND,
  parseLeaseName,
  resolveEpic,
  resolveNote,
  resolveTtl,
} from '@/lib/lease-policy';
import type { ILeaseHolder } from '@/types/lease';

const tab: ILeaseHolder = { workspaceId: 'ws-1', tabId: 'tab-a', tabName: 'A', verified: true, admin: false };
const admin: ILeaseHolder = { workspaceId: null, tabId: null, tabName: null, verified: false, admin: true };
const M = 60;
const H = 3600;
const D = 86400;

describe('lease kind policy table (architecture.md "Lease kinds")', () => {
  it('pins every kind exactly', () => {
    const table = Object.fromEntries(Object.entries(LEASE_KINDS).map(([k, p]) => [k, [p.defaultTtlSeconds, p.maxTtlSeconds, p.survivesTab, p.requiresEpic, p.orchestratorOnly]]));
    expect(table).toEqual({
      merge: [45 * M, 3 * H, false, false, false],
      'dev-deploy': [45 * M, 3 * H, false, false, false],
      'dev-write': [60 * M, 8 * H, false, false, false],
      deploy: [30 * M, 2 * H, false, false, true],
      epic: [null, 7 * D, false, false, false],
      pool: [60 * M, D, false, false, false],
      num: [14 * D, 30 * D, true, true, false],
    });
    expect([OTHER_KIND.defaultTtlSeconds, OTHER_KIND.maxTtlSeconds, OTHER_KIND.survivesTab]).toEqual([30 * M, D, false]);
  });
});

describe('parseLeaseName', () => {
  it('lower-cases so two spellings are one lease', () => {
    expect(parseLeaseName('merge:NomuPay/treasury-api')).toEqual({ name: 'merge:nomupay/treasury-api', kind: 'merge', resource: 'nomupay/treasury-api' });
  });

  it.each([
    ['', 'does not match'],
    ['merge', 'does not match'],
    ['m:x/y', 'does not match'],
    ['1merge:x/y', 'does not match'],
    ['merge:x y', 'does not match'],
    ['merge:nomupay', 'must be <owner>/<repo>'],
    ['dev-deploy:a/b/c', 'must be <owner>/<repo>'],
    ['num:nomupay/treasury-api:adr', 'must be <owner>/<repo>:<adr|migration>:<nnnn>'],
    ['num:nomupay/treasury-api:rfc:0001', 'must be <owner>/<repo>:<adr|migration>:<nnnn>'],
    ['epic:a/b', 'must be an epic slug'],
    [`epic:${'a'.repeat(101)}`, 'must be an epic slug'],
    ['pool:ai-lan/review-1', 'must be <host>/<gate|build|tab>-<n>'],
    ['pool:ai-lan/gate-1000', 'must be <host>/<gate|build|tab>-<n>'],
  ])('refuses %j with a named rule', (raw, message) => {
    expect(() => parseLeaseName(raw)).toThrow(LeasePolicyError);
    expect(() => parseLeaseName(raw)).toThrow(message);
  });

  it('accepts every kind in its resource form', () => {
    for (const name of ['merge:nomupay/treasury-api', 'dev-deploy:nomupay/treasury-ui', 'dev-write:dev', 'deploy:purplemux',
      'epic:purplemux-portfolio-coordination', 'num:nomupay/treasury-api:adr:0373', 'num:nomupay/treasury-event-consumer:migration:415', 'pool:ai-lan/gate-1', 'pool:mdserver1/tab-12', 'smoke:anything/goes#1']) {
      expect(parseLeaseName(name).name).toBe(name);
    }
  });

  it('refuses a non-string', () => {
    expect(() => parseLeaseName(undefined)).toThrow('name is required');
  });
});

describe('resolveTtl', () => {
  it('takes the kind default when none is given', () => {
    expect(resolveTtl('merge', undefined, tab)).toBe(45 * M);
    expect(resolveTtl('num', undefined, tab)).toBe(14 * D);
    expect(resolveTtl('smoke', undefined, tab)).toBe(30 * M);
    expect(resolveTtl('epic', undefined, tab)).toBeNull();
  });

  it('refuses a TTL over the kind maximum, naming the rule', () => {
    expect(() => resolveTtl('merge', 5 * H, tab)).toThrow('merge leases allow at most 3h, got 5h');
    expect(() => resolveTtl('smoke', 25 * H, tab)).toThrow('allow at most 1d');
  });

  it('allows no expiry only for a kind without a default, and only for a tab holder', () => {
    expect(resolveTtl('epic', null, tab)).toBeNull();
    expect(() => resolveTtl('merge', null, tab)).toThrow('merge leases must expire');
    expect(() => resolveTtl('epic', null, admin)).toThrow('an admin holder must give a TTL');
    expect(() => resolveTtl('epic', undefined, admin)).toThrow('an admin holder must give a TTL');
    expect(() => resolveTtl('epic', undefined, { ...tab, tabId: null })).toThrow('a tabless holder must give a TTL');
    expect(resolveTtl('epic', 3600, admin)).toBe(3600);
  });

  it('refuses a TTL that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => resolveTtl('merge', bad, tab)).toThrow('positive whole number');
  });
});

describe('resolveEpic / resolveNote', () => {
  it('requires an epic for num, naming the rule', () => {
    expect(() => resolveEpic('num', undefined)).toThrow('num leases require an epic');
    expect(() => resolveEpic('num', '')).toThrow('num leases require an epic');
    expect(resolveEpic('num', 'P4')).toBe('p4');
    expect(resolveEpic('merge', undefined)).toBeNull();
    expect(() => resolveEpic('merge', 'bad slug')).toThrow('does not match');
  });

  it('flattens control characters and bounds the note', () => {
    expect(resolveNote('a\nb\u0007c')).toBe('a b c');
    expect(resolveNote('')).toBeNull();
    expect(() => resolveNote('x'.repeat(501))).toThrow('at most 500');
  });
});
