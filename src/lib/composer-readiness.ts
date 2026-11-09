import { parsePermissionOptions } from '@/lib/permission-prompt';
import { renderPaneResult } from '@/lib/pane-suggestions';
import type { IClientTabStatusEntry } from '@/types/status';
import type { TComposerReading } from '@/types/fleet-status';
import type { TPanelType } from '@/types/terminal';
import type { TStartupPrompt } from '@/types/timeline';

// The checks an unattended sender runs before typing into an agent's
// composer (ADR-0008, ADR-0012). Extracted from Mission Control's dispatch so
// Mission Control and the tab inbox ask the same questions in the same order
// and name a refusal the same way.

/**
 * The last `lines` lines of a capture, after the blank rows under the content: a pane taller than what the
 * agent drew pads it with empty rows (measured: Claude Code 2.1.318 at 120x40 drew its composer with 26 blank
 * rows below it), and those rows would push the composer out of the window.
 */
const tail = (content: string, lines = 24): string => {
  const all = content.split('\n');
  let end = all.length;
  while (end > 0 && all[end - 1].replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').trim() === '') end -= 1;
  return all.slice(Math.max(0, end - lines), end).join('\n');
};

const composerMarker = (panelType: TPanelType | undefined): string | null => (panelType === 'codex-cli'
  ? '›'
  : panelType === 'claude-code'
    ? '❯'
    : panelType === 'grok-cli'
      ? '[›❯>]'
      : null);

export const hasEmptyAgentComposer = (panelType: TPanelType | undefined, content: string): boolean => {
  const marker = composerMarker(panelType);
  if (!marker) return false;
  const composerLines = tail(content, 12).split('\n');
  const composerPattern = new RegExp(`^[ \\t]*${marker}([ \\t\\u00a0].*)?$`);
  for (let index = composerLines.length - 1; index >= 0; index -= 1) {
    const match = composerLines[index].match(composerPattern);
    if (!match) continue;
    return (match[1] ?? '').trim() === '';
  }
  return false;
};

/**
 * A capture read as a person sees it: escapes stripped and the dim prompt
 * suggestion on the composer line removed (L7). Measured 2026-09-26: 8 of 12
 * idle Claude tabs showed one, and read plain it is a non-empty composer. A
 * capture taken without escapes passes through unchanged.
 */
export const paneAsSeen = (panelType: TPanelType | undefined, content: string): string =>
  renderPaneResult(content, panelType, 'no-suggestions').content;

/**
 * The screen half of readiness: no interactive option list and an empty
 * composer. A trust prompt (`❯ No, exit`) or a first-run picker
 * (`❯ 2. Dark mode`) shows the marker on a non-empty line, so it is not ready.
 */
export const paneShowsEmptyComposer = (panelType: TPanelType | undefined, content: string): boolean => {
  const plain = paneAsSeen(panelType, content);
  if (parsePermissionOptions(tail(plain)).options.length > 0) return false;
  return hasEmptyAgentComposer(panelType, plain);
};

/**
 * The Claude Code startup dialogs that stop a tab before any hook runs (D14). Texts measured on Claude Code
 * 2.1.318 (the pane fixtures in tests/fixtures/panes/: `claude-trust-prompt*.ansi`,
 * `claude-external-imports-*.ansi`); the older trust wording ("Do you trust the files in this folder?",
 * numbered options) is kept. A dialog counts only with its heading, then one of its own option lines after
 * it, each at line start, and no composer line (`❯` at line start) after the last option line: a real
 * dialog draws no composer, and a transcript that quotes the dialog always has the composer under it
 * (review r1 nit 4).
 */
const STARTUP_PROMPTS: ReadonlyArray<{ kind: TStartupPrompt; heading: RegExp; option: RegExp }> = [
  {
    kind: 'folder-trust',
    heading: /^[ \t]*(?:Accessing workspace:|Do you trust the files in this folder\?)/,
    option: /^[ \t]*(?:❯[ \t]*)?(?:\d+\.[ \t]*)?(?:Yes, I trust this folder|Yes, proceed|No, exit)\b/,
  },
  {
    kind: 'external-imports',
    heading: /^[ \t]*Allow external CLAUDE\.md file imports\?/,
    option: /^[ \t]*(?:❯[ \t]*)?(?:\d+\.[ \t]*)?(?:Yes, allow external imports|No, disable external imports)\b/,
  },
];

/** How far up the startup-dialog read looks: the trust dialog is 15 lines, plus a long wrapped path. */
const STARTUP_PROMPT_SCAN_LINES = 40;

/** The startup dialog a Claude pane shows, or null. Only Claude Code has these dialogs. */
export const paneStartupPrompt = (panelType: TPanelType | undefined, content: string): TStartupPrompt | null => {
  if (panelType !== 'claude-code') return null;
  const plain = tail(paneAsSeen(panelType, content), STARTUP_PROMPT_SCAN_LINES);
  // A dialog that was answered is erased; an empty composer below old text means the agent is past it.
  if (hasEmptyAgentComposer(panelType, plain)) return null;
  const lines = plain.split('\n');
  for (const prompt of STARTUP_PROMPTS) {
    const heading = lines.findIndex((line) => prompt.heading.test(line));
    if (heading < 0) continue;
    let lastOption = -1;
    for (let index = lines.length - 1; index > heading; index -= 1) {
      if (prompt.option.test(lines[index])) {
        lastOption = index;
        break;
      }
    }
    if (lastOption < 0) continue;
    if (lines.slice(lastOption + 1).some((line) => COMPOSER_LINE.test(line))) continue;
    return prompt.kind;
  }
  return null;
};

/** A composer line, empty or typed: the `❯` marker at line start. */
const COMPOSER_LINE = /^[ \t]*❯/;

/** How far up a fleet read looks for the composer line: a typed multi-line brief wraps far above 12 lines. */
const COMPOSER_SCAN_LINES = 60;

/**
 * The composer as the fleet status panel reports it (ADR-0023): `empty`,
 * `text` (something typed and not submitted), or `unreadable` (no composer
 * line, or an option list is open). Read only; the capture is the caller's.
 */
export const readComposer = (panelType: TPanelType | undefined, captured: string | null): TComposerReading => {
  if (!captured) return 'unreadable';
  const plain = paneAsSeen(panelType, captured);
  if (parsePermissionOptions(tail(plain)).options.length > 0) return 'unreadable';
  const marker = composerMarker(panelType);
  if (!marker) return 'unreadable';
  const composerPattern = new RegExp(`^[ \\t]*${marker}([ \\t\\u00a0].*)?$`);
  const lines = tail(plain, COMPOSER_SCAN_LINES).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(composerPattern);
    if (match) return (match[1] ?? '').trim() === '' ? 'empty' : 'text';
  }
  return 'unreadable';
};

export type TComposerReadiness = { ok: true } | { ok: false; reason: string };

export type TComposerScreenRefusal = 'composer-unreadable' | 'interactive-prompt-active' | 'composer-not-empty';

export type TComposerScreen = { ok: true } | { ok: false; reason: TComposerScreenRefusal };

/**
 * The screen half of {@link checkComposerReady}: a capture taken with escapes, read with the dim suggestion
 * removed. No capture, an open option list, or text on the composer line is not ready.
 */
export const readComposerScreen = (panelType: TPanelType | undefined, captured: string | null): TComposerScreen => {
  if (!captured) return { ok: false, reason: 'composer-unreadable' };
  const content = paneAsSeen(panelType, captured);
  if (parsePermissionOptions(tail(content)).options.length > 0) return { ok: false, reason: 'interactive-prompt-active' };
  if (!hasEmptyAgentComposer(panelType, content)) return { ok: false, reason: 'composer-not-empty' };
  return { ok: true };
};

export interface IComposerReadinessInput {
  panelType: TPanelType | undefined;
  status: Pick<IClientTabStatusEntry, 'cliState' | 'permissionRequest'> | undefined;
  /** The pane, captured only after the status checks pass; with escapes, so a dim suggestion reads as empty. */
  capture: () => Promise<string | null>;
  /**
   * A `busy` tab that is only waiting on its own background work, at an empty
   * composer (ADR-0018 ruling A′). Callers that may deliver to it pass it.
   */
  waitingAtPrompt?: boolean;
}

/**
 * The status checks first (no pane read), then the screen: no native
 * permission prompt, a state that holds a composer, no interactive option
 * list, and an empty composer. Every refusal is a reason a later look may
 * clear, so the caller decides how to back off.
 */
export const checkComposerReady = async (input: IComposerReadinessInput): Promise<TComposerReadiness> => {
  const { status } = input;
  if (!status) return { ok: false, reason: 'status-unavailable' };
  if (status.permissionRequest) return { ok: false, reason: 'native-prompt-active' };
  const stateReady = status.cliState === 'idle' || status.cliState === 'ready-for-review'
    || (status.cliState === 'busy' && input.waitingAtPrompt === true);
  if (!stateReady) return { ok: false, reason: `composer-not-ready:${status.cliState}` };

  const captured = await input.capture().catch(() => null);
  return readComposerScreen(input.panelType, captured);
};
