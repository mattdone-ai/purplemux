import { parsePermissionOptions } from '@/lib/permission-prompt';
import { renderPaneResult } from '@/lib/pane-suggestions';
import type { IClientTabStatusEntry } from '@/types/status';
import type { TComposerReading } from '@/types/fleet-status';
import type { TPanelType } from '@/types/terminal';

// The checks an unattended sender runs before typing into an agent's
// composer (ADR-0008, ADR-0012). Extracted from Mission Control's dispatch so
// Mission Control and the tab inbox ask the same questions in the same order
// and name a refusal the same way.

const tail = (content: string, lines = 24): string => content.split('\n').slice(-lines).join('\n');

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
const withoutSuggestions = (panelType: TPanelType | undefined, content: string): string =>
  renderPaneResult(content, panelType, 'no-suggestions').content;

/**
 * The screen half of readiness: no interactive option list and an empty
 * composer. A trust prompt (`❯ No, exit`) or a first-run picker
 * (`❯ 2. Dark mode`) shows the marker on a non-empty line, so it is not ready.
 */
export const paneShowsEmptyComposer = (panelType: TPanelType | undefined, content: string): boolean => {
  const plain = withoutSuggestions(panelType, content);
  if (parsePermissionOptions(tail(plain)).options.length > 0) return false;
  return hasEmptyAgentComposer(panelType, plain);
};

/** How far up a fleet read looks for the composer line: a typed multi-line brief wraps far above 12 lines. */
const COMPOSER_SCAN_LINES = 60;

/**
 * The composer as the fleet status panel reports it (ADR-0023): `empty`,
 * `text` (something typed and not submitted), or `unreadable` (no composer
 * line, or an option list is open). Read only; the capture is the caller's.
 */
export const readComposer = (panelType: TPanelType | undefined, captured: string | null): TComposerReading => {
  if (!captured) return 'unreadable';
  const plain = withoutSuggestions(panelType, captured);
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
  if (!captured) return { ok: false, reason: 'composer-unreadable' };
  const content = withoutSuggestions(input.panelType, captured);
  if (parsePermissionOptions(tail(content)).options.length > 0) return { ok: false, reason: 'interactive-prompt-active' };
  if (!hasEmptyAgentComposer(input.panelType, content)) return { ok: false, reason: 'composer-not-empty' };
  return { ok: true };
};
