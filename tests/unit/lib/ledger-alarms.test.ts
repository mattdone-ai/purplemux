import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALARM_THRESHOLD_MINUTES, V2_DEFAULT_ROUTE, alarmFor, alarmSeverity, alarmText, formatAge, parseRouteTable,
  parseThresholdValue, resolveThresholds, routeFor, thresholdReason,
} from '@/lib/ledger-alarms';
import { FLEET_VALUE_MAX } from '@/lib/fleet-config-store';
import type { IBoardStuckItem } from '@/types/constraint';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const stuck = (extra: Partial<IBoardStuckItem> = {}): IBoardStuckItem => ({
  key: 'range:h1:abcdef012345', itemType: 'range', holder: 'v2-w-visa', reason: 'not-armed', since: T0 - 25 * MIN,
  clearInput: 'arm h1', critical: false, reasonLabel: 'not armed to land', ...extra,
});

const table = (raw: string) => {
  const { table: parsed, error } = parseRouteTable(raw);
  expect(error).toBeNull();
  return parsed;
};

describe('the v2 default route table (ADR-HFL-03 decision 1)', () => {
  const v2 = table(V2_DEFAULT_ROUTE);

  it('fits one fleet config value', () => {
    expect(V2_DEFAULT_ROUTE.length).toBeLessThanOrEqual(FLEET_VALUE_MAX);
  });

  it('is the 238-character table of consult 13', () => {
    expect(V2_DEFAULT_ROUTE).toBe('$holder=not-armed,own-lane-order,review-findings,rework,agent-idle;v2-kit=land-queue,lock-wait,under-lock-gate,'
      + 'pre-flight-gate,gate-slot,host-load,chain-down;$holder+$orchestrator=red-main;$board=owner;$orchestrator=group-partner,deploy-*');
    expect(V2_DEFAULT_ROUTE).toHaveLength(238);
  });

  it.each(['not-armed', 'review-findings', 'rework', 'agent-idle'])('routes %s to its holder', (reason) => {
    expect(routeFor(v2, reason)).toEqual([{ kind: 'holder' }]);
  });

  it.each(['land-queue/lock-busy', 'land-queue/head-blocked', 'lock-wait', 'under-lock-gate', 'pre-flight-gate', 'gate-slot', 'host-load', 'chain-down'])(
    'routes %s to v2-kit', (reason) => {
      expect(routeFor(v2, reason)).toEqual([{ kind: 'tab', name: 'v2-kit' }]);
    },
  );

  it('routes red-main to the lander and the orchestrator, owner to the board, deploy waits to the orchestrator', () => {
    expect(routeFor(v2, 'red-main')).toEqual([{ kind: 'holder' }, { kind: 'orchestrator' }]);
    expect(routeFor(v2, 'owner')).toEqual([{ kind: 'board' }]);
    for (const reason of ['deploy-queue', 'deploy-run', 'deploy-auth']) expect(routeFor(v2, reason)).toEqual([{ kind: 'orchestrator' }]);
  });

  it('falls back to the orchestrator for a reason or anomaly it does not name', () => {
    expect(v2.entries.some((entry) => entry.pattern === 'guard-hold' || entry.pattern === 're-gates')).toBe(false);
    expect(routeFor(v2, 're-gates')).toEqual([{ kind: 'orchestrator' }]);
    expect(routeFor(v2, 'guard-hold')).toEqual([{ kind: 'orchestrator' }]);
  });

  it('routes own-lane-order to its holder, the lane seat (consult 13)', () => {
    expect(routeFor(v2, 'own-lane-order')).toEqual([{ kind: 'holder' }]);
  });

  it('gives group-partner its own entry to the orchestrator (consult 13)', () => {
    expect(v2.entries.find((entry) => entry.pattern === 'group-partner')).toEqual({ pattern: 'group-partner', targets: [{ kind: 'orchestrator' }] });
    expect(routeFor(v2, 'group-partner')).toEqual([{ kind: 'orchestrator' }]);
  });
});

describe('parseRouteTable', () => {
  it('reads unset and empty as no table', () => {
    expect(parseRouteTable(null)).toEqual({ table: { entries: [] }, error: null });
    expect(parseRouteTable('  ')).toEqual({ table: { entries: [] }, error: null });
  });

  it.each([
    ['no equals sign', 'v2-kit', 'is not <target>=<reason>'],
    ['two equals signs', 'v2-kit=not-armed=rework', 'is not <target>=<reason>'],
    ['an unknown special target', '$lander=red-main', 'unknown target $lander'],
    ['a bad tab name', 'v2 kit=red-main', 'is not a tab name'],
    ['an unknown reason', 'v2-kit=not-a-reason', 'is not a wait reason'],
    ['an unknown reason, naming the allowed set', 'v2-kit=not-a-reason', 'one of review-queue, review-findings,'],
    ['a prefix of nothing', 'v2-kit=zz-*', 'is not a wait reason'],
    ['a reason routed twice', 'v2-kit=rework;$holder=rework', 'rework is routed twice'],
    ['$board beside another target', '$board+v2-kit=owner', '$board stands alone'],
    ['an empty pattern', 'v2-kit=rework,', 'is not a wait reason'],
  ])('refuses the whole value for %s', (_name, raw, message) => {
    const parsed = parseRouteTable(raw);
    expect(parsed.table.entries).toEqual([]);
    expect(parsed.error).toContain(message);
  });

  it('prefers an exact reason over its producer reason, and that over the longest prefix', () => {
    const t = table('a=land-*;b=land-queue;c=land-queue/lock-busy;d=lan*');
    expect(routeFor(t, 'land-queue/lock-busy')).toEqual([{ kind: 'tab', name: 'c' }]);
    expect(routeFor(t, 'land-queue/head-blocked')).toEqual([{ kind: 'tab', name: 'b' }]);
    expect(routeFor(t, 'land-other' as string)).toEqual([{ kind: 'tab', name: 'a' }]);
  });

  it('routes anomaly ids by the same table', () => {
    expect(routeFor(table('$holder=context-per-call;v2-kit=producer-silence'), 'context-per-call')).toEqual([{ kind: 'holder' }]);
  });
});

describe('thresholds', () => {
  it('carries the ADR defaults', () => {
    expect(DEFAULT_ALARM_THRESHOLD_MINUTES).toEqual({
      'red-main': 0, 'chain-down': 10, 'not-armed': 20, 'group-partner': 30, 'agent-idle': 30, 'land-queue': 60, 'own-lane-order': 60, owner: 120,
    });
  });

  it('parses minutes and off, and refuses anything else', () => {
    expect(parseThresholdValue(' 45 ')).toEqual({ minutes: 45 });
    expect(parseThresholdValue('0')).toEqual({ minutes: 0 });
    expect(parseThresholdValue('off')).toEqual({ minutes: null });
    for (const bad of ['-1', '10081', 'ten', '1e3', '']) expect(parseThresholdValue(bad)).toHaveProperty('error');
  });

  it('overrides a default, adds a reason, and keeps the default beside an unreadable value', () => {
    const { thresholds, errors } = resolveThresholds(new Map([['not-armed', '45'], ['rework', '90'], ['chain-down', 'soon'], ['owner', 'off']]));
    expect(thresholds.get('not-armed')).toBe(45);
    expect(thresholds.get('rework')).toBe(90);
    expect(thresholds.get('chain-down')).toBe(10);
    expect(thresholds.get('owner')).toBeNull();
    expect(errors).toEqual(['ledger.threshold.chain-down must be off or minutes in 0..10080, got "soon"; the default stands']);
  });

  it('keys a derived land-queue reason on land-queue', () => {
    expect(thresholdReason('land-queue/lock-busy')).toBe('land-queue');
    expect(thresholdReason('not-armed')).toBe('not-armed');
  });
});

describe('alarmFor', () => {
  const { thresholds } = resolveThresholds(new Map());

  it('raises an open wait at its threshold, not before', () => {
    expect(alarmFor(stuck({ since: T0 - 20 * MIN + 1 }), thresholds, T0)).toBeNull();
    expect(alarmFor(stuck({ since: T0 - 20 * MIN }), thresholds, T0)).toMatchObject({ itemKey: 'range:h1:abcdef012345', thresholdMinutes: 20, severity: 'warn' });
  });

  it('raises nothing for a reason with no threshold, or one switched off', () => {
    expect(alarmFor(stuck({ reason: 'review-queue', since: T0 - 600 * MIN }), thresholds, T0)).toBeNull();
    expect(alarmFor(stuck({ reason: 'unknown', since: T0 - 600 * MIN }), thresholds, T0)).toBeNull();
    const off = resolveThresholds(new Map([['not-armed', 'off']])).thresholds;
    expect(alarmFor(stuck(), off, T0)).toBeNull();
  });

  it('raises red-main at once and a land-queue split on land-queue', () => {
    expect(alarmFor(stuck({ reason: 'red-main', since: T0 }), thresholds, T0)?.severity).toBe('block');
    expect(alarmFor(stuck({ reason: 'land-queue/lock-busy', since: T0 - 61 * MIN }), thresholds, T0)?.thresholdMinutes).toBe(60);
  });

  it('makes a chain-down urgent only on the critical path', () => {
    expect(alarmSeverity({ reason: 'chain-down', critical: true })).toBe('block');
    expect(alarmSeverity({ reason: 'chain-down', critical: false })).toBe('warn');
    expect(alarmSeverity({ reason: 'not-armed', critical: true })).toBe('warn');
  });
});

describe('alarmText', () => {
  const alarm = alarmFor(stuck(), resolveThresholds(new Map()).thresholds, T0)!;

  it('names the item, reason, age and clear input', () => {
    expect(alarmText(alarm, T0, true)).toBe('range:h1:abcdef012345 not-armed for 25 min (threshold 20 min); clear: arm h1');
  });

  it('names the holder to a seat that is not the holder, and a missing clear input as such', () => {
    expect(alarmText({ ...alarm, clearInput: null, holder: null }, T0, false))
      .toBe('range:h1:abcdef012345 not-armed for 25 min (threshold 20 min); clear: not named; holder none named');
  });

  it('reads long ages in hours', () => {
    expect(formatAge(119 * MIN)).toBe('119 min');
    expect(formatAge(150 * MIN)).toBe('2.5 h');
  });
});
