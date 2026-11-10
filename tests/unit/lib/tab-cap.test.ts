import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { ILayoutData, ITab } from '@/types/terminal';

// ADR-0027: the pure half of the WIP cap — the cap read and its source, the
// count, the admission, and who may pass the cap.

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: logged.info, warn: logged.warn, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const {
  DEFAULT_TAB_CAP, TAB_CAP_KEY, WipCapError, admitAgentCreate, checkOverCapField, countAgentTabs, isOverCapCaller,
  parseTabCap, readTabCap, tabCountView, wipAdmission, wipOf, workspaceTabCapKey,
} = await import('@/lib/tab-cap');

const tab = (id: string, panelType?: ITab['panelType'], host?: string): ITab =>
  ({ id, name: id, order: 0, sessionName: `s-${id}`, ...(panelType ? { panelType } : {}), ...(host ? { host } : {}) });
const layoutOf = (left: ITab[], right: ITab[] = []): ILayoutData => ({
  root: {
    type: 'split', orientation: 'vertical', ratio: 50,
    children: [{ type: 'pane', id: 'p1', activeTabId: null, tabs: left }, { type: 'pane', id: 'p2', activeTabId: null, tabs: right }],
  },
  activePaneId: 'p1',
  updatedAt: '2026-10-26T00:00:00.000Z',
} as ILayoutData);

const caller = (over: Partial<ICaller> = {}): ICaller => ({
  scope: { type: 'workspace', workspaceId: 'ws-a' }, workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o',
  verified: true, identity: 'launch', admin: false, ...over,
} as ICaller);

beforeEach(() => {
  logged.info.mockClear();
  logged.warn.mockClear();
  (globalThis as { __ptTabCapLogged?: Map<string, string> }).__ptTabCapLogged?.clear();
});

describe('parseTabCap', () => {
  it('unset is 8 from the default', () => {
    expect(parseTabCap(null)).toEqual({ cap: DEFAULT_TAB_CAP, capSource: 'default', reason: null });
    expect(DEFAULT_TAB_CAP).toBe(8);
    expect(TAB_CAP_KEY).toBe('tabs.cap-per-workspace');
  });

  it.each([['1', 1], ['200', 200], [' 12 ', 12], ['08', 8]])('%j is a fleet-config cap of %d', (raw, cap) => {
    expect(parseTabCap(raw)).toEqual({ cap, capSource: 'fleet-config', reason: null });
  });

  it.each([
    ['0', 'outside 1..200'], ['201', 'outside 1..200'], ['-3', 'not an integer'], ['2.5', 'not an integer'],
    ['eight', 'not an integer'], ['', 'not an integer'], ['1e2', 'not an integer'],
  ])('%j reads as 8 with the reason (%s)', (raw, reason) => {
    const parsed = parseTabCap(raw);
    expect(parsed).toMatchObject({ cap: 8, capSource: 'default-invalid' });
    expect(parsed.reason).toContain(reason);
  });
});

describe('readTabCap', () => {
  it('logs the source once per answer, the default as info and an invalid value as a warning with its reason', async () => {
    expect(await readTabCap(async () => null)).toEqual({ cap: 8, capSource: 'default' });
    await readTabCap(async () => null);
    expect(logged.info).toHaveBeenCalledTimes(1);
    expect(logged.info).toHaveBeenCalledWith('WIP cap 8 (source default)');
    expect(await readTabCap(async () => '999')).toEqual({ cap: 8, capSource: 'default-invalid' });
    expect(logged.warn).toHaveBeenCalledWith('WIP cap 8 (source default-invalid: tabs.cap-per-workspace is 999, outside 1..200)');
    expect(await readTabCap(async (key) => (key === TAB_CAP_KEY ? '5' : null))).toEqual({ cap: 5, capSource: 'fleet-config' });
    expect(logged.info).toHaveBeenLastCalledWith('WIP cap 5 (source fleet-config)');
  });

  it('a config read that fails is thrown, never read as no cap', async () => {
    await expect(readTabCap(async () => { throw new Error('fleet-config.json is malformed'); })).rejects.toThrow('malformed');
    await expect(readTabCap(async () => { throw new Error('fleet-config.json is malformed'); }, 'ws-ldhziO')).rejects.toThrow('malformed');
  });
});

describe('the per-workspace cap (story 17 AC 8)', () => {
  const config = (values: Record<string, string>) => async (key: string) => (Object.hasOwn(values, key) ? values[key] : null);

  it('the key is the fleet key plus the workspace id, case kept', () => {
    expect(workspaceTabCapKey('ws-ldhziO')).toBe('tabs.cap-per-workspace.ws-ldhziO');
  });

  it.each([
    ['the workspace key wins over the fleet key', { 'tabs.cap-per-workspace': '8', 'tabs.cap-per-workspace.ws-ldhziO': '14' }, 'ws-ldhziO', { cap: 14, capSource: 'workspace-config' }],
    ['the workspace key wins over the default', { 'tabs.cap-per-workspace.ws-ldhziO': '14' }, 'ws-ldhziO', { cap: 14, capSource: 'workspace-config' }],
    ['another workspace keeps the fleet value', { 'tabs.cap-per-workspace': '6', 'tabs.cap-per-workspace.ws-ldhziO': '14' }, 'ws-other', { cap: 6, capSource: 'fleet-config' }],
    ['another workspace keeps the default', { 'tabs.cap-per-workspace.ws-ldhziO': '14' }, 'ws-other', { cap: 8, capSource: 'default' }],
    ['a key differing only in case is another workspace', { 'tabs.cap-per-workspace.ws-ldhziO': '14' }, 'ws-LDHZIO', { cap: 8, capSource: 'default' }],
    ['an invalid workspace value serves the fleet cap under its own source and reason (r2 F5)', { 'tabs.cap-per-workspace': '6', 'tabs.cap-per-workspace.ws-ldhziO': '0' }, 'ws-ldhziO',
      { cap: 6, capSource: 'workspace-config-invalid', capReason: 'tabs.cap-per-workspace.ws-ldhziO is 0, outside 1..200; the fleet value 6 applies' }],
    ['an invalid workspace value with no fleet value names the default', { 'tabs.cap-per-workspace.ws-ldhziO': 'x' }, 'ws-ldhziO',
      { cap: 8, capSource: 'workspace-config-invalid', capReason: 'tabs.cap-per-workspace.ws-ldhziO is "x", not an integer; the default 8 applies' }],
    ['no workspace asks only the fleet key', { 'tabs.cap-per-workspace.ws-ldhziO': '14' }, undefined, { cap: 8, capSource: 'default' }],
  ])('%s', async (_name, values, workspaceId, expected) => {
    expect(await readTabCap(config(values), workspaceId)).toEqual(expected);
  });

  it('an invalid workspace value is logged with its reason; each workspace logs its own answer once', async () => {
    await readTabCap(config({ 'tabs.cap-per-workspace.ws-a': 'lots' }), 'ws-a');
    expect(logged.warn).toHaveBeenCalledWith('WIP cap 8 for ws-a (source workspace-config-invalid: tabs.cap-per-workspace.ws-a is "lots", not an integer; the default 8 applies)');
    await readTabCap(config({ 'tabs.cap-per-workspace.ws-b': '14' }), 'ws-b');
    await readTabCap(config({ 'tabs.cap-per-workspace.ws-b': '14' }), 'ws-b');
    expect(logged.info.mock.calls.filter(([line]) => line === 'WIP cap 14 for ws-b (source workspace-config)')).toHaveLength(1);
  });

  it('tabCountView and the refusal body carry the reason of an invalid workspace value (r2 F5)', () => {
    const tabCap = { cap: 8, capSource: 'workspace-config-invalid' as const, capReason: 'tabs.cap-per-workspace.ws-a is 0, outside 1..200; the default 8 applies' };
    expect(tabCountView('ws-a', 3, tabCap)).toMatchObject({ capSource: 'workspace-config-invalid', capReason: tabCap.capReason });
    expect(new WipCapError('ws-a', 8, tabCap).body).toMatchObject({ capSource: 'workspace-config-invalid', capReason: tabCap.capReason });
    expect(tabCountView('ws-a', 3, { cap: 8, capSource: 'default' })).not.toHaveProperty('capReason');
  });

  it('tabCountView reports capSource workspace-config', () => {
    expect(tabCountView('ws-ldhziO', 9, { cap: 14, capSource: 'workspace-config' })).toEqual({
      workspaceId: 'ws-ldhziO', count: 9, cap: 14, capSource: 'workspace-config', overCap: false,
    });
  });

  it('admitAgentCreate reads the cap of the workspace it creates in', async () => {
    const readCap = vi.fn(async (ws: string) => (ws === 'ws-ldhziO' ? { cap: 14, capSource: 'workspace-config' as const } : { cap: 8, capSource: 'default' as const }));
    const result = await admitAgentCreate({} as NextApiRequest, 'ws-ldhziO', 'claude-code', undefined, {
      resolveCaller: vi.fn(async () => null), isWorkspaceOrchestrator: vi.fn(async () => false), readTabCap: readCap,
    });
    expect(readCap).toHaveBeenCalledWith('ws-ldhziO');
    const tabs = Array.from({ length: 13 }, (_, i) => tab(`t${i}`, 'claude-code'));
    expect(result.ok && result.admission?.admit(layoutOf(tabs))).toEqual({ ok: true });
  });
});

describe('the count and the admission', () => {
  const tabs = [tab('a', 'claude-code'), tab('b', 'codex-cli'), tab('c', 'grok-cli', 'host-b'), tab('d', 'terminal'),
    tab('e', 'web-browser'), tab('f', 'diff'), tab('g', 'agent-sessions'), tab('h')];

  it('counts agent tabs in every pane, local and remote, and nothing else', () => {
    expect(countAgentTabs(layoutOf(tabs.slice(0, 4), tabs.slice(4)))).toBe(3);
    expect(countAgentTabs(layoutOf([]))).toBe(0);
  });

  it('wipOf and tabCountView: over the cap only when the count exceeds it', () => {
    expect(wipOf(8, 8)).toEqual({ count: 8, cap: 8, overCap: false });
    expect(wipOf(9, 8)).toEqual({ count: 9, cap: 8, overCap: true });
    expect(tabCountView('ws-a', 3, { cap: 2, capSource: 'fleet-config' }))
      .toEqual({ workspaceId: 'ws-a', count: 3, cap: 2, capSource: 'fleet-config', overCap: true });
  });

  it('refuses at the cap with WipCapError and its body; nothing is counted as admitted', () => {
    const admission = wipAdmission('ws-a', { cap: 3, capSource: 'fleet-config' }, false);
    const result = admission.admit(layoutOf(tabs));
    expect(result.ok).toBe(false);
    const refusal = (result as { ok: false; refusal: Error }).refusal;
    expect(refusal).toBeInstanceOf(WipCapError);
    expect((refusal as InstanceType<typeof WipCapError>).body).toEqual({
      code: 'wip-cap', error: 'ws-a holds 3 of 3 agent tabs', workspaceId: 'ws-a', count: 3, cap: 3, capSource: 'fleet-config',
    });
    expect(admission.wip()).toBeNull();
    expect(admission.passedCap()).toBe(false);
  });

  it('admits below the cap, and over it only with overCap; wip() is the count with the new tab', () => {
    const below = wipAdmission('ws-a', { cap: 4, capSource: 'default' }, false);
    expect(below.admit(layoutOf(tabs))).toEqual({ ok: true });
    expect(below.wip()).toEqual({ count: 4, cap: 4, overCap: false });
    expect(below.passedCap()).toBe(false);
    const over = wipAdmission('ws-a', { cap: 3, capSource: 'default' }, true);
    expect(over.admit(layoutOf(tabs))).toEqual({ ok: true });
    expect(over.wip()).toEqual({ count: 4, cap: 3, overCap: true });
    expect(over.passedCap()).toBe(true);
    expect(wipAdmission('ws-a', { cap: 3, capSource: 'default' }, false).wip()).toBeNull();
  });
});

describe('overCap', () => {
  it('checkOverCapField: absent is no override; a reason of 1..500 characters is one; anything else is invalid-request', () => {
    expect(checkOverCapField(undefined)).toEqual({ ok: true, reason: null });
    expect(checkOverCapField({ reason: 'r' })).toEqual({ ok: true, reason: 'r' });
    expect(checkOverCapField({ reason: 'x'.repeat(500) })).toMatchObject({ ok: true });
    for (const bad of [null, 'r', ['r'], {}, { reason: '' }, { reason: '  ' }, { reason: 7 }, { reason: 'x'.repeat(501) }]) {
      expect(checkOverCapField(bad), JSON.stringify(bad)).toMatchObject({ ok: false, status: 400, body: { code: 'invalid-request' } });
    }
  });

  it('isOverCapCaller: only a verified tab that is its own workspace\'s enabled orchestrator', async () => {
    const orchestrator = vi.fn(async (ws: string, tabId: string) => ws === 'ws-a' && tabId === 'tab-o');
    expect(await isOverCapCaller(caller(), 'ws-a', orchestrator)).toBe(true);
    expect(await isOverCapCaller(caller({ tabId: 'tab-w' }), 'ws-a', orchestrator)).toBe(false);
    expect(await isOverCapCaller(caller({ verified: false, identity: 'hook' }), 'ws-a', orchestrator)).toBe(false);
    expect(await isOverCapCaller(caller({ tabId: null }), 'ws-a', orchestrator)).toBe(false);
    expect(await isOverCapCaller(caller({ workspaceId: 'ws-b' }), 'ws-a', orchestrator)).toBe(false);
    expect(await isOverCapCaller(caller({ admin: true, workspaceId: null, tabId: null }), 'ws-a', orchestrator)).toBe(false);
    expect(await isOverCapCaller(null, 'ws-a', orchestrator)).toBe(false);
  });
});

describe('admitAgentCreate', () => {
  const req = {} as NextApiRequest;
  const deps = (over: Partial<Parameters<typeof admitAgentCreate>[4]> = {}) => ({
    resolveCaller: vi.fn(async () => caller()),
    isWorkspaceOrchestrator: vi.fn(async () => true),
    readTabCap: vi.fn(async () => ({ cap: 8, capSource: 'default' as const })),
    ...over,
  });

  it('a non-agent tab reads no cap and gets no admission', async () => {
    const d = deps({ readTabCap: vi.fn(async () => { throw new Error('never read'); }) });
    expect(await admitAgentCreate(req, 'ws-a', 'terminal', undefined, d)).toEqual({ ok: true, admission: null, overCapReason: null, caller: null });
    expect(d.readTabCap).not.toHaveBeenCalled();
    expect(d.resolveCaller).not.toHaveBeenCalled();
  });

  it('an unreadable cap refuses an agent create with 503 config-store-unreadable', async () => {
    const d = deps({ readTabCap: vi.fn(async () => { throw new Error('fleet-config.json is malformed'); }) });
    const result = await admitAgentCreate(req, 'ws-a', 'grok-cli', undefined, d);
    expect(result).toMatchObject({ ok: false, status: 503, body: { code: 'config-store-unreadable', error: expect.stringContaining('fleet-config.json is malformed') } });
  });

  it('overCap from a non-orchestrator is 403 forbidden before the cap is read', async () => {
    const d = deps({ isWorkspaceOrchestrator: vi.fn(async () => false) });
    const result = await admitAgentCreate(req, 'ws-a', 'claude-code', { reason: 'r' }, d);
    expect(result).toMatchObject({ ok: false, status: 403, body: { code: 'forbidden' } });
    expect(d.readTabCap).not.toHaveBeenCalled();
  });

  it('overCap from the orchestrator carries the reason and the caller to the create', async () => {
    const result = await admitAgentCreate(req, 'ws-a', 'claude-code', { reason: 'r' }, deps());
    expect(result).toMatchObject({ ok: true, overCapReason: 'r', caller: { tabId: 'tab-o' } });
    expect(result.ok && result.admission).toBeTruthy();
  });
});
