import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type { ICaller } from '@/lib/caller';

// Story 14: the steer interrupt rule (pure) and the caller kind (agent tab or other).

const mocks = vi.hoisted(() => ({
  resolveCaller: vi.fn(async (): Promise<ICaller | null> => null),
  findTab: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('@/lib/caller', () => ({ resolveCaller: mocks.resolveCaller }));
vi.mock('@/lib/cli-utils', () => ({ findTab: mocks.findTab }));

import { STEER_REASON_MAX, decideSteerInterrupt, resolveSteerCaller } from '@/lib/steer-policy';

const req = {} as NextApiRequest;
const caller = (tabId: string | null): ICaller => ({
  scope: { type: 'workspace', workspaceId: 'ws' }, workspaceId: 'ws', tabId, tabName: null, verified: false, identity: tabId ? 'session' : 'none', admin: false,
});

describe('decideSteerInterrupt', () => {
  it('defaults by caller kind: agent false, other true', () => {
    expect(decideSteerInterrupt({}, 'agent')).toEqual({ ok: true, interrupt: false, explicit: false, reason: null });
    expect(decideSteerInterrupt({}, 'other')).toEqual({ ok: true, interrupt: true, explicit: false, reason: null });
  });

  it('accepts interrupt: false from either kind', () => {
    for (const kind of ['agent', 'other'] as const) {
      expect(decideSteerInterrupt({ interrupt: false }, kind)).toEqual({ ok: true, interrupt: false, explicit: true, reason: null });
    }
  });

  it('interrupt: true takes a trimmed reason of 1..500 characters from either kind', () => {
    for (const kind of ['agent', 'other'] as const) {
      expect(decideSteerInterrupt({ interrupt: true, reason: ' why ' }, kind)).toEqual({ ok: true, interrupt: true, explicit: true, reason: 'why' });
      expect(decideSteerInterrupt({ interrupt: true, reason: 'r'.repeat(STEER_REASON_MAX) }, kind)).toMatchObject({ ok: true });
      expect(decideSteerInterrupt({ interrupt: true, reason: 'r'.repeat(STEER_REASON_MAX + 1) }, kind)).toMatchObject({ ok: false, code: 'steer-reason-invalid' });
      expect(decideSteerInterrupt({ interrupt: true }, kind)).toMatchObject({ ok: false, code: 'steer-reason-invalid' });
    }
  });

  it('refuses a reason without interrupt: true and values of the wrong type', () => {
    expect(decideSteerInterrupt({ reason: 'x' }, 'other')).toMatchObject({ ok: false, code: 'steer-reason-invalid' });
    expect(decideSteerInterrupt({ interrupt: 'true' }, 'agent')).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(decideSteerInterrupt({ interrupt: true, reason: ['x'] }, 'agent')).toMatchObject({ ok: false, code: 'steer-reason-invalid' });
  });
});

describe('resolveSteerCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['claude-code', 'codex-cli', 'grok-cli'])('a %s caller tab is an agent', async (panelType) => {
    mocks.resolveCaller.mockResolvedValue(caller('t1'));
    mocks.findTab.mockResolvedValue({ workspaceId: 'ws', paneId: 'p', tab: { id: 't1', panelType } });
    expect(await resolveSteerCaller(req)).toMatchObject({ kind: 'agent', panelType });
    expect(mocks.findTab).toHaveBeenCalledWith('ws', 't1');
  });

  it.each(['terminal', 'agent-sessions', 'web-browser', 'diff', undefined])('a %s caller tab is other', async (panelType) => {
    mocks.resolveCaller.mockResolvedValue(caller('t1'));
    mocks.findTab.mockResolvedValue({ workspaceId: 'ws', paneId: 'p', tab: { id: 't1', ...(panelType ? { panelType } : {}) } });
    expect(await resolveSteerCaller(req)).toMatchObject({ kind: 'other', panelType: panelType ?? 'terminal' });
  });

  it('no caller, a caller without a tab, a tab the layout lacks, and a failed lookup are other', async () => {
    mocks.resolveCaller.mockResolvedValueOnce(null);
    expect(await resolveSteerCaller(req)).toEqual({ kind: 'other', caller: null, panelType: null });
    mocks.resolveCaller.mockResolvedValueOnce(caller(null));
    expect(await resolveSteerCaller(req)).toMatchObject({ kind: 'other', panelType: null });
    expect(mocks.findTab).not.toHaveBeenCalled();
    mocks.resolveCaller.mockResolvedValueOnce(caller('gone'));
    mocks.findTab.mockResolvedValueOnce(null);
    expect(await resolveSteerCaller(req)).toMatchObject({ kind: 'other', panelType: null });
    mocks.resolveCaller.mockRejectedValueOnce(new Error('layout unreadable'));
    expect(await resolveSteerCaller(req)).toEqual({ kind: 'other', caller: null, panelType: null });
    mocks.resolveCaller.mockResolvedValueOnce(caller('t1'));
    mocks.findTab.mockRejectedValueOnce(new Error('layout unreadable'));
    expect(await resolveSteerCaller(req)).toMatchObject({ kind: 'other', panelType: null });
  });
});
