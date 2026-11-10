import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { checkComposerReady, paneShowsEmptyComposer, paneStartupPrompt } from '@/lib/composer-readiness';
import type { TCliState } from '@/types/timeline';

const EMPTY = 'done\n────────\n❯ \n────────\n';

const check = (cliState: TCliState | null, extra: { waitingAtPrompt?: boolean; permission?: boolean; pane?: string | null } = {}) => {
  const capture = vi.fn(async () => (extra.pane === undefined ? EMPTY : extra.pane));
  const result = checkComposerReady({
    panelType: 'claude-code',
    status: cliState === null ? undefined : { cliState, permissionRequest: extra.permission ? ({ id: 'p' } as never) : null },
    capture,
    waitingAtPrompt: extra.waitingAtPrompt,
  });
  return { result, capture };
};

describe('checkComposerReady (ADR-0008, ADR-0012)', () => {
  it.each(['idle', 'ready-for-review'] as TCliState[])('accepts %s with an empty composer', async (state) => {
    expect(await check(state).result).toEqual({ ok: true });
  });

  it('accepts busy only when waiting at the prompt (ruling A′)', async () => {
    expect(await check('busy', { waitingAtPrompt: true }).result).toEqual({ ok: true });
    expect(await check('busy').result).toEqual({ ok: false, reason: 'composer-not-ready:busy' });
  });

  it.each(['needs-input', 'inactive', 'unknown'] as TCliState[])('refuses %s even with the waiting flag', async (state) => {
    expect(await check(state, { waitingAtPrompt: true }).result).toEqual({ ok: false, reason: `composer-not-ready:${state}` });
  });

  it('checks status before reading the pane', async () => {
    const missing = check(null);
    expect(await missing.result).toEqual({ ok: false, reason: 'status-unavailable' });
    expect(missing.capture).not.toHaveBeenCalled();
    const prompt = check('idle', { permission: true });
    expect(await prompt.result).toEqual({ ok: false, reason: 'native-prompt-active' });
    expect(prompt.capture).not.toHaveBeenCalled();
  });

  it('refuses an unreadable pane, an option list and a typed composer', async () => {
    expect(await check('idle', { pane: null }).result).toEqual({ ok: false, reason: 'composer-unreadable' });
    expect(await check('idle', { pane: 'Proceed?\n❯ 1. Yes\n  2. No\n' }).result).toEqual({ ok: false, reason: 'interactive-prompt-active' });
    expect(await check('idle', { pane: 'x\n❯ typed\n' }).result).toEqual({ ok: false, reason: 'composer-not-empty' });
  });

  it('turns a capture that throws into composer-unreadable', async () => {
    const result = await checkComposerReady({
      panelType: 'claude-code',
      status: { cliState: 'idle', permissionRequest: null },
      capture: async () => { throw new Error('tmux gone'); },
    });
    expect(result).toEqual({ ok: false, reason: 'composer-unreadable' });
  });
});

// Real captures (`capture-pane -p -e`), 2026-09-26: tests/fixtures/panes.
const pane = (name: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');

describe('suggestion-aware readiness (story 17, L7)', () => {
  it('accepts an idle tab whose composer shows only a dim suggestion (8 of 12 idle claude tabs measured)', async () => {
    expect(await check('idle', { pane: pane('claude-dim-suggestion.ansi') }).result).toEqual({ ok: true });
    expect(await check('ready-for-review', { pane: pane('claude-dim-suggestion-footer.ansi') }).result).toEqual({ ok: true });
  });

  it('still refuses text typed on the composer, escapes or not', async () => {
    expect(await check('idle', { pane: 'x\n\x1b[39m❯\u00a0typed by the owner\x1b[0m\n' }).result).toEqual({ ok: false, reason: 'composer-not-empty' });
  });

  it('accepts the cursor cell drawn over the suggestion (ws-5TO0NJ tab-v76BaE: 30 false refusals, 2026-10-08)', async () => {
    expect(await check('idle', { pane: pane('claude-cursor-on-suggestion.ansi') }).result).toEqual({ ok: true });
  });

  it.each([
    ['the cursor inside a draft', `x\n\x1b[39m❯\u00a0fix th\x1b[7me\x1b[0m build\n`],
    ['the cursor after a draft', `x\n\x1b[39m❯\u00a0typed\x1b[7m \x1b[0m\n`],
    ['the cursor on a draft\'s first character', `x\n\x1b[39m❯\u00a0\x1b[7mk\x1b[0meep going\n`],
    ['a draft that a dim completion follows', `x\n\x1b[39m❯\u00a0k\x1b[7me\x1b[0;2mep going\x1b[0m\n`],
  ])('still refuses a human draft: %s', async (_label, captured) => {
    expect(await check('idle', { pane: captured }).result).toEqual({ ok: false, reason: 'composer-not-empty' });
  });

  it.each([
    ['an empty composer', 'claude-empty-composer.ansi', true],
    ['a dim suggestion', 'claude-dim-suggestion.ansi', true],
    ['a fresh Claude, 80x24 detached (dim placeholder)', 'claude-fresh-80x24.ansi', true],
    ['a fresh Claude, 200x60', 'claude-fresh-200x60.ansi', true],
    ['a trust prompt (❯ No, exit)', 'claude-trust-prompt.ansi', false],
    ['a trust prompt above 23 blank rows (2.1.318, 120x40)', 'claude-trust-prompt-120x40.ansi', false],
    ['the external-imports dialog', 'claude-external-imports-prompt.ansi', false],
    ['a composer above 26 blank rows (2.1.318, 120x40: the rows no longer push it out of the window)', 'claude-external-imports-accepted.ansi', true],
    ['the first-run theme picker (❯ 2. Dark mode)', 'claude-onboarding-theme.ansi', false],
  ])('paneShowsEmptyComposer: %s → %s', (_label, name, ready) => {
    expect(paneShowsEmptyComposer('claude-code', pane(name))).toBe(ready);
  });

  it('reads a fresh Claude as not ready without escapes: why every composer capture keeps them', () => {
    const plain = pane('claude-fresh-80x24.ansi').replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '');
    expect(paneShowsEmptyComposer('claude-code', plain)).toBe(false);
  });

  it('paneShowsEmptyComposer knows no composer for a terminal', () => {
    expect(paneShowsEmptyComposer('terminal', pane('claude-empty-composer.ansi'))).toBe(false);
  });
});

// ppc-48 (architect ruling, option C): a Codex native subagent's PermissionRequest is dropped, so the
// tab may read ready-for-review with no permission request while its pane shows the approval dialog.
// An automated send must still refuse to type into it. Real Codex 0.158 captures (on-request,
// read-only sandbox, 2026-09-29), at 80 columns and wrapped at 50.
describe("a Codex approval dialog the tab does not know about (ppc-48, option C)", () => {
  it.each(['codex-0158-approval-80x24.txt', 'codex-0158-approval-50x24.txt'])('%s refuses the send', async (name) => {
    const pane = fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');

    const result = await checkComposerReady({
      panelType: 'codex-cli',
      status: { cliState: 'ready-for-review', permissionRequest: null },
      capture: async () => pane,
    });

    expect(result).toEqual({ ok: false, reason: 'interactive-prompt-active' });
  });
});

// D14 (story 05): the Claude Code startup dialogs no hook reports. Real captures: `claude-trust-prompt.ansi`
// (2026-09-26) and, from Claude Code 2.1.318 on 2026-11-05 (120x40, a scratch CLAUDE_CONFIG_DIR),
// `claude-trust-prompt-120x40.ansi`, `claude-external-imports-prompt.ansi` and the same pane after the
// prompt was accepted, `claude-external-imports-accepted.ansi`. The three 2026-11-04 incidents
// (ws-zOfVyu D14, hfl-37, hfl-38) showed these same dialogs; no capture of them was kept.
describe('paneStartupPrompt (story 05, D14)', () => {
  it.each([
    ['the folder-trust dialog (2026-09-26)', 'claude-trust-prompt.ansi', 'folder-trust'],
    ['the folder-trust dialog (2.1.318, 120x40)', 'claude-trust-prompt-120x40.ansi', 'folder-trust'],
    ['the external-imports dialog, No selected (hfl-38 shape)', 'claude-external-imports-prompt.ansi', 'external-imports'],
    ['the composer after the imports dialog was accepted', 'claude-external-imports-accepted.ansi', null],
    ['an empty composer', 'claude-empty-composer.ansi', null],
    ['the first-run theme picker', 'claude-onboarding-theme.ansi', null],
    ['a fresh Claude, 80x24', 'claude-fresh-80x24.ansi', null],
  ])('%s → %s', (_label, name, kind) => {
    expect(paneStartupPrompt('claude-code', pane(name))).toBe(kind);
  });

  it('reads the older numbered trust wording', () => {
    const older = ' Do you trust the files in this folder?\n\n /home/user/portfolio\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit\n';
    expect(paneStartupPrompt('claude-code', older)).toBe('folder-trust');
  });

  it('never reads the dialog wording in a conversation above an empty composer', () => {
    const quoted = '⏺ The tab stopped at:\nAccessing workspace:\nYes, I trust this folder\n\n────────\n❯ \n────────\n';
    expect(paneStartupPrompt('claude-code', quoted)).toBeNull();
  });

  // Review r1 nit 4: a transcript that quotes both dialog lines, unprefixed, with a TYPED composer under them.
  it('never reads a quoted dialog above a typed composer as the dialog', () => {
    const quoted = ' Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder\n\n────────\n❯ why did the tab stop here\n────────\n';
    expect(paneStartupPrompt('claude-code', quoted)).toBeNull();
    const imports = '  Allow external CLAUDE.md file imports?\n  ❯ No, disable external imports\n────────\n❯ typed\n────────\n';
    expect(paneStartupPrompt('claude-code', imports)).toBeNull();
  });

  it('needs the option line after the heading: an option quoted above a heading is not the dialog', () => {
    expect(paneStartupPrompt('claude-code', '   Yes, I trust this folder\n\n Accessing workspace:\n /x\n')).toBeNull();
  });

  it('reads the dialog with the selection moved to Yes (the selected option is the last line)', () => {
    expect(paneStartupPrompt('claude-code', ' Accessing workspace:\n /x\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n')).toBe('folder-trust');
  });

  it('needs the heading and an option line: the heading alone is not the dialog', () => {
    expect(paneStartupPrompt('claude-code', ' Allow external CLAUDE.md file imports?\n')).toBeNull();
    expect(paneStartupPrompt('claude-code', '  ❯ No, disable external imports\n')).toBeNull();
  });

  // Synthetic (no capture was kept): the 2026-11-05 host-b incident, a UserPromptSubmit hook that failed and
  // restored the prompt with "Original prompt:". It is not a startup dialog and must not read as one.
  it('does not read a hook-blocked prompt as a startup dialog', () => {
    const blocked = '⏺ UserPromptSubmit operation blocked by hook:\n  hook exited 127\n\n  Original prompt: Read the brief\n\n────────\n❯ Read the brief\n────────\n';
    expect(paneStartupPrompt('claude-code', blocked)).toBeNull();
  });

  it('knows no startup dialog outside Claude Code', () => {
    expect(paneStartupPrompt('codex-cli', pane('claude-trust-prompt.ansi'))).toBeNull();
    expect(paneStartupPrompt('terminal', pane('claude-external-imports-prompt.ansi'))).toBeNull();
    expect(paneStartupPrompt(undefined, pane('claude-trust-prompt.ansi'))).toBeNull();
  });

  it('a composer check refuses a startup-prompt tab before it reads the pane', async () => {
    const { result, capture } = check('startup-prompt', { pane: pane('claude-trust-prompt.ansi') });
    expect(await result).toEqual({ ok: false, reason: 'composer-not-ready:startup-prompt' });
    expect(capture).not.toHaveBeenCalled();
  });
});
