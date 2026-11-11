import { describe, expect, it } from 'vitest';
import { chainDownQuiet, chainHoldsPathError, holdFor, parseChainHolds, rangeParts } from '@/lib/chain-down-quiet';

// vel-WATCHDOG-F6-NOISE: a chain-down wait on a dead or replaced v2 range raises no alarm. The hold list grammar and
// its until window are the Scrum Master watcher's; this parser holds the same lines.

const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const IN_2D = '2026-11-13T09:00:00Z';
const tabs = new Set(['tab-visa', 'v2-w-visa', 'tab-orch', 'v2-orchestrator']);
const item = (extra: Partial<{ key: string; reason: string; holder: string | null; supersededBy: string }> = {}) => ({
  key: 'range:visa:abcdef012345', reason: 'chain-down' as const, holder: 'v2-w-visa', ...extra,
}) as Parameters<typeof chainDownQuiet>[0];

describe('rangeParts', () => {
  it.each([
    ['range:visa:abcdef012345', { lane: 'visa', id: 'abcdef012345' }],
    ['range:Visa:ABCDEF012345', { lane: 'visa', id: 'abcdef012345' }],
    ['gate:t:1', null],
    ['range:visa', null],
    ['range:a:b:c', null],
  ])('%s', (key, want) => {
    expect(rangeParts(key)).toEqual(want);
  });
});

describe('parseChainHolds: the hold list lines that hold', () => {
  it('holds a held and a deferred line, ignores comments and blank lines, strips a BOM and CRs', () => {
    const text = `﻿# ORCH holds\r\n\r\nvisa:abcdef01 held ${IN_2D} waits for a fix\r\nMC:12345678 DEFERRED ${IN_2D} x\n`;
    expect([...parseChainHolds(text, NOW)]).toEqual([
      ['visa:abcdef01', Date.UTC(2026, 10, 13, 9, 0, 0)],
      ['mc:12345678', Date.UTC(2026, 10, 13, 9, 0, 0)],
    ]);
  });

  it.each([
    ['fields', `visa:abcdef01 held ${IN_2D}`],
    ['key: no colon', `visaabcdef01 held ${IN_2D} why`],
    ['key: not hex', `visa:abcdef0z held ${IN_2D} why`],
    ['key: 9 digits', `visa:abcdef012 held ${IN_2D} why`],
    ['key: lane', `v!sa:abcdef01 held ${IN_2D} why`],
    ['retired', `visa:abcdef01 retired ${IN_2D} why`],
    ['state', `visa:abcdef01 parked ${IN_2D} why`],
    ['never', 'visa:abcdef01 held never why'],
    ['until: no Z', 'visa:abcdef01 held 2026-11-13T09:00:00 why'],
    ['until: no such date', 'visa:abcdef01 held 2026-11-31T09:00:00Z why'],
    ['control', `visa:abcdef01 held ${IN_2D} why\u0007`],
    ['past', 'visa:abcdef01 held 2026-11-11T09:00:00Z why'],
    ['far', 'visa:abcdef01 held 2026-11-25T09:00:01Z why'],
  ])('refuses a line (%s): it holds nothing', (_rule, line) => {
    expect(parseChainHolds(`${line}\n`, NOW).size).toBe(0);
  });

  it('holds an until exactly 14 days ahead', () => {
    expect(parseChainHolds('visa:abcdef01 held 2026-11-25T09:00:00Z why\n', NOW).size).toBe(1);
  });

  it('refuses both lines of a key on two lines, and keeps the other keys', () => {
    const text = `visa:abcdef01 held ${IN_2D} a\nvisa:ABCDEF01 deferred ${IN_2D} b\nmc:12345678 held ${IN_2D} c\n`;
    expect([...parseChainHolds(text, NOW).keys()]).toEqual(['mc:12345678']);
  });
});

describe('holdFor', () => {
  const holds = parseChainHolds(`visa:abcdef01 held ${IN_2D} x\n`, NOW);

  it('matches the lane and the first 8 characters of the range key', () => {
    expect(holdFor(holds, 'range:visa:abcdef012345', NOW)).toBe(Date.UTC(2026, 10, 13, 9, 0, 0));
    expect(holdFor(holds, 'range:mc:abcdef012345', NOW)).toBeNull();
    expect(holdFor(holds, 'range:visa:abcdef112345', NOW)).toBeNull();
    expect(holdFor(holds, 'range:visa:abcd', NOW)).toBeNull();
    expect(holdFor(holds, 'gate:visa:abcdef012345', NOW)).toBeNull();
  });

  it('holds nothing once the until passes', () => {
    expect(holdFor(holds, 'range:visa:abcdef012345', Date.UTC(2026, 10, 13, 9, 0, 0))).toBeNull();
  });
});

describe('chainDownQuiet', () => {
  const held = parseChainHolds(`visa:abcdef01 held ${IN_2D} x\n`, NOW);

  it('control: a live, unheld chain-down whose holder is a tab alarms', () => {
    expect(chainDownQuiet(item(), { holds: new Map(), tabs }, NOW)).toBeNull();
  });

  it('names the rule that quiets it', () => {
    expect(chainDownQuiet(item({ supersededBy: 'range:visa:999999999999' }), { holds: null, tabs: null }, NOW)).toBe('superseded');
    expect(chainDownQuiet(item(), { holds: held, tabs }, NOW)).toBe('held');
    expect(chainDownQuiet(item({ holder: 'v2-w-gone' }), { holds: null, tabs }, NOW)).toBe('holder-gone');
  });

  it('judges no holder gone without a layout read, and none for a null holder', () => {
    expect(chainDownQuiet(item({ holder: 'v2-w-gone' }), { holds: null, tabs: null }, NOW)).toBeNull();
    expect(chainDownQuiet(item({ holder: null }), { holds: null, tabs }, NOW)).toBeNull();
  });

  it('quiets only chain-down: another reason on a superseded, held range with a gone holder still alarms', () => {
    const other = item({ reason: 'not-armed', holder: 'v2-w-gone', supersededBy: 'range:visa:999999999999' });
    expect(chainDownQuiet(other, { holds: held, tabs }, NOW)).toBeNull();
  });
});

describe('chainHoldsPathError', () => {
  it.each(['/srv/v2/.v2/chain-holds.txt', '/a'])('accepts %s', (path) => {
    expect(chainHoldsPathError(path)).toBeNull();
  });

  it.each(['relative/chain-holds.txt', '', '/srv/../etc/passwd', '/srv/a\nb', `/${'a'.repeat(1024)}`])('refuses %j', (path) => {
    expect(chainHoldsPathError(path)).toContain('must be an absolute file path');
  });
});
