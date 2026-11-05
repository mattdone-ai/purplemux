import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITab, TPanelType } from '@/types/terminal';
import type { ICaller } from '@/lib/caller';

// Story 14: the steer route's interrupt default per caller, the reason rule and its audit line, and
// the terminal-tab line check (D30). The real steerSession runs over a mocked tmux, so "interrupted"
// means an Escape reached the target session.

const WS = 'ws-steer';
const TARGET = 'tab-worker';

const tabs = vi.hoisted(() => new Map<string, ITab>());
const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(async () => true),
  sendEscape: vi.fn(async () => {}),
}));
const delivery = vi.hoisted(() => ({ deliverPrompt: vi.fn(async () => {}) }));
const audit = vi.hoisted(() => ({ appendCoordinationAudit: vi.fn(async (_entry: Record<string, unknown>) => true) }));
const callers = vi.hoisted(() => ({ resolveCaller: vi.fn(async (): Promise<ICaller | null> => null) }));
const policy = vi.hoisted(() => vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })));

vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspaceInput: vi.fn(async () => ({ type: 'workspace', workspaceId: WS })),
  findTab: vi.fn(async (workspaceId: string, tabId: string) => {
    const tab = tabs.get(tabId);
    return tab && workspaceId === WS ? { workspaceId, paneId: 'pane-1', tab } : null;
  }),
}));
vi.mock('@/lib/caller', () => callers);
vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/agent-prompt-delivery', () => delivery);
vi.mock('@/lib/coordination-audit', () => audit);
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (_ws: string, _tab: ITab, work: (check: () => Promise<unknown>) => Promise<unknown>) => work(policy),
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const tab = (id: string, panelType: TPanelType | undefined, name = id): ITab => ({
  id, name, order: 0, sessionName: `pt-${WS}-pane-1-${id}`, ...(panelType ? { panelType } : {}),
}) as ITab;

const tabCaller = (tabId: string, identity: ICaller['identity'] = 'launch'): ICaller => ({
  scope: { type: 'workspace', workspaceId: WS, tabId, ...(identity === 'launch' ? { tabVerified: true as const } : {}) },
  workspaceId: WS, tabId, tabName: tabs.get(tabId)?.name ?? null, verified: identity === 'launch', identity, admin: false,
});

const workspaceTokenCaller = (): ICaller => ({
  scope: { type: 'workspace', workspaceId: WS }, workspaceId: WS, tabId: null, tabName: null, verified: false, identity: 'none', admin: false,
});

interface IResult { status: number; body: Record<string, unknown> }

const call = async (body: unknown, tabId = TARGET): Promise<IResult> => {
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/steer');
  const out: IResult = { status: 0, body: {} };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(payload: Record<string, unknown>) { out.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { tabId, workspaceId: WS }, body, headers: {} } as unknown as NextApiRequest, res);
  return out;
};

describe('POST /api/cli/tabs/[tabId]/steer (story 14)', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabs.clear();
    tabs.set(TARGET, tab(TARGET, 'claude-code', 'orchestrator'));
    tabs.set('tab-sm', tab('tab-sm', 'claude-code', 'scrum-master'));
    tabs.set('tab-codex', tab('tab-codex', 'codex-cli'));
    tabs.set('tab-grok', tab('tab-grok', 'grok-cli'));
    tabs.set('tab-shell', tab('tab-shell', 'terminal'));
    tabs.set('tab-legacy', tab('tab-legacy', undefined));
    tmux.hasSession.mockResolvedValue(true);
    tmux.sendEscape.mockResolvedValue(undefined);
    policy.mockResolvedValue({ ok: true });
    callers.resolveCaller.mockResolvedValue(null);
  });

  describe('AC1: an agent caller does not interrupt by default', () => {
    it.each([
      ['claude-code', 'tab-sm', 'launch'],
      ['codex-cli', 'tab-codex', 'launch'],
      ['grok-cli', 'tab-grok', 'launch'],
      ['claude-code (hook identity)', 'tab-sm', 'hook'],
      ['claude-code (session identity)', 'tab-sm', 'session'],
    ] as const)('%s: types the text and sends no Escape', async (_label, callerTab, identity) => {
      callers.resolveCaller.mockResolvedValue(tabCaller(callerTab, identity));
      const result = await call({ content: 'stop editing ADR-0041' });
      expect(result).toEqual({ status: 200, body: { status: 'steered', interrupted: false } });
      expect(tmux.sendEscape).not.toHaveBeenCalled();
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(`pt-${WS}-pane-1-${TARGET}`, 'stop editing ADR-0041');
      expect(audit.appendCoordinationAudit).not.toHaveBeenCalled();
    });

    it('interrupt: false stays accepted from an agent caller', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      expect((await call({ content: 'x', interrupt: false })).body).toEqual({ status: 'steered', interrupted: false });
      expect(tmux.sendEscape).not.toHaveBeenCalled();
    });
  });

  describe('AC2: an agent interrupts only with a reason, and the interrupt is audited', () => {
    it('interrupt: true with a reason sends Escape, then the text, and writes one steer-interrupt line', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      const result = await call({ content: 'the owner said stop', interrupt: true, reason: '  owner ruled the slice out of scope  ' });
      expect(result).toEqual({ status: 200, body: { status: 'steered', interrupted: true } });
      expect(tmux.sendEscape).toHaveBeenCalledWith(`pt-${WS}-pane-1-${TARGET}`);
      expect(audit.appendCoordinationAudit).toHaveBeenCalledTimes(1);
      expect(audit.appendCoordinationAudit).toHaveBeenCalledWith({
        event: 'steer-interrupt',
        workspaceId: WS,
        tabId: TARGET,
        targetName: 'orchestrator',
        caller: { kind: 'agent', workspaceId: WS, tabId: 'tab-sm', tabName: 'scrum-master', panelType: 'claude-code', identity: 'launch', verified: true },
        explicit: true,
        reason: 'owner ruled the slice out of scope',
        interrupted: true,
        ok: true,
      });
    });

    it('records a failed Escape: the text still lands, the line says it did not interrupt', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      tmux.sendEscape.mockRejectedValue(new Error('tmux gone'));
      const result = await call({ content: 'x', interrupt: true, reason: 'wrong branch' });
      expect(result.body).toEqual({ status: 'steered', interrupted: false });
      expect(audit.appendCoordinationAudit).toHaveBeenCalledWith(expect.objectContaining({
        event: 'steer-interrupt', interrupted: false, ok: true, failure: 'interrupt failed',
      }));
    });

    it('records a policy refusal after the Escape (the text was not typed)', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      policy.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'agent-model-mismatch' });
      const result = await call({ content: 'x', interrupt: true, reason: 'wrong branch' });
      expect(result.status).toBe(409);
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
      expect(audit.appendCoordinationAudit).toHaveBeenCalledWith(expect.objectContaining({
        event: 'steer-interrupt', interrupted: true, ok: false, failure: 'policy-refused',
      }));
    });

    it.each([
      ['no reason', { interrupt: true }, 'reason: saw interrupt: true with no reason; expected a text of 1..500 characters'],
      ['a blank reason', { interrupt: true, reason: '   ' }, 'reason: saw interrupt: true with a blank reason; expected a text of 1..500'],
      ['a reason over 500 characters', { interrupt: true, reason: 'r'.repeat(501) }, 'reason: saw 501 characters; expected at most 500'],
      ['a reason that is not a string', { interrupt: true, reason: 7 }, 'reason: saw number 7; expected a text of 1..500'],
      ['a reason without interrupt: true', { reason: 'why' }, 'reason: saw a reason without interrupt; expected interrupt: true with the reason'],
      ['a reason with interrupt: false', { interrupt: false, reason: 'why' }, 'reason: saw a reason with interrupt: false; expected interrupt: true'],
    ])('refuses %s with 400 steer-reason-invalid, says what it saw and expected, and touches nothing', async (_label, fields, text) => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      const result = await call({ content: 'x', ...fields });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: expect.stringContaining(text), code: 'steer-reason-invalid' });
      expect(tmux.sendEscape).not.toHaveBeenCalled();
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
      expect(audit.appendCoordinationAudit).not.toHaveBeenCalled();
    });

    it('refuses an interrupt value that is not a boolean (400 invalid-request)', async () => {
      const result = await call({ content: 'x', interrupt: 'yes' });
      expect(result).toEqual({ status: 400, body: { error: 'interrupt: saw the string "yes"; expected true or false', code: 'invalid-request' } });
    });
  });

  describe('AC3: every other caller keeps interrupt as the default, and every interrupt is audited (r2)', () => {
    it.each<[string, () => ICaller | null, 'unidentified' | 'other', string | null]>([
      ['a caller that names no tab (resolveCaller null)', () => null, 'unidentified', null],
      ['a workspace token without a tab', workspaceTokenCaller, 'unidentified', null],
      ['a tab id the layout does not hold', () => tabCaller('tab-gone'), 'unidentified', null],
      ['a terminal tab', () => tabCaller('tab-shell'), 'other', 'terminal'],
      ['a tab without a panel type', () => tabCaller('tab-legacy', 'session'), 'other', 'terminal'],
    ])('%s: sends Escape first and writes one steer-interrupt line with reason "(none given)"', async (_label, make, kind, panelType) => {
      callers.resolveCaller.mockResolvedValue(make());
      const result = await call({ content: 'correct course' });
      expect(result).toEqual({ status: 200, body: { status: 'steered', interrupted: true } });
      expect(tmux.sendEscape).toHaveBeenCalledTimes(1);
      expect(audit.appendCoordinationAudit).toHaveBeenCalledTimes(1);
      expect(audit.appendCoordinationAudit).toHaveBeenCalledWith(expect.objectContaining({
        event: 'steer-interrupt',
        tabId: TARGET,
        caller: expect.objectContaining({ kind, panelType }),
        explicit: false,
        reason: '(none given)',
        interrupted: true,
        ok: true,
      }));
    });

    it('a caller lookup that throws is unidentified: it interrupts and is audited', async () => {
      callers.resolveCaller.mockRejectedValue(new Error('layout unreadable'));
      expect((await call({ content: 'x' })).body).toEqual({ status: 'steered', interrupted: true });
      expect(audit.appendCoordinationAudit).toHaveBeenCalledWith(expect.objectContaining({
        caller: expect.objectContaining({ kind: 'unidentified', tabId: null, identity: 'none' }), reason: '(none given)',
      }));
    });

    it('interrupt: false stays accepted from any other caller, and writes no line (nothing was interrupted)', async () => {
      for (const make of [() => tabCaller('tab-shell'), workspaceTokenCaller]) {
        callers.resolveCaller.mockResolvedValue(make());
        expect((await call({ content: 'x', interrupt: false })).body).toEqual({ status: 'steered', interrupted: false });
      }
      expect(tmux.sendEscape).not.toHaveBeenCalled();
      expect(audit.appendCoordinationAudit).not.toHaveBeenCalled();
    });

    it('an explicit interrupt from any other caller also needs a reason and is audited', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-shell'));
      expect((await call({ content: 'x', interrupt: true })).body).toMatchObject({ code: 'steer-reason-invalid' });
      await call({ content: 'x', interrupt: true, reason: 'the owner typed it' });
      expect(audit.appendCoordinationAudit).toHaveBeenCalledWith(expect.objectContaining({
        event: 'steer-interrupt', caller: expect.objectContaining({ kind: 'other', panelType: 'terminal' }), explicit: true, reason: 'the owner typed it',
      }));
    });
  });

  describe('D30: a terminal target takes one shell command line', () => {
    it('refuses multi-line text into a terminal tab with the tab type, and sends nothing', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      const result = await call({ content: 'Read the brief.\nThen watch the load.' }, 'tab-shell');
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: 'terminal-not-command-line', tabId: 'tab-shell', panelType: 'terminal', lines: 2 });
      expect(String(result.body.error)).toContain('is a terminal tab, whose shell runs each line as a command: saw 2 lines; expected one shell command line');
      expect(String(result.body.error)).toContain('A multi-line command (a heredoc, a quoted multi-line string, a backslash continuation) needs --raw');
      expect(tmux.sendEscape).not.toHaveBeenCalled();
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    });

    it('types multi-line text into a terminal tab with raw: true', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      const result = await call({ content: 'a\nb', raw: true }, 'tab-shell');
      expect(result.status).toBe(200);
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(`pt-${WS}-pane-1-tab-shell`, 'a\nb');
    });

    it('types one command line into a terminal tab', async () => {
      callers.resolveCaller.mockResolvedValue(tabCaller('tab-sm'));
      expect((await call({ content: 'tail -n 50 /tmp/load.log' }, 'tab-shell')).status).toBe(200);
    });

    it('refuses a raw value that is not a boolean', async () => {
      expect(await call({ content: 'x', raw: 1 })).toEqual({ status: 400, body: { error: 'raw: saw number; expected true or false', code: 'invalid-request' } });
    });
  });

  it('keeps 404 tab-not-found for an unknown target', async () => {
    expect((await call({ content: 'x' }, 'tab-none')).status).toBe(404);
  });
});
