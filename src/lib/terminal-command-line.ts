import type { ITab } from '@/types/terminal';

/**
 * Text for a terminal tab must be one shell command line (harness-flow-loop-2 story 14, D30).
 *
 * A shell runs each line it reads as a command. On 2026-11-05 an orchestrator sent a prose brief
 * with `tab send` to a plain terminal tab: bash rejected every line, and the orchestrator reported
 * the watch as running for about an hour. `tab send` and `tab steer` into a `terminal` tab therefore
 * refuse text that holds a line break, unless the caller passes `raw: true` (`--raw`), for example
 * for a heredoc. Trailing line breaks are not counted: a file read with `-f` usually ends in one.
 * Single-line prose cannot be told from a command; this check catches the multi-line case only.
 */

export const TERMINAL_INPUT_CODE = 'terminal-not-command-line';

export interface ITerminalInputRefusal {
  error: string;
  code: typeof TERMINAL_INPUT_CODE;
  tabId: string;
  panelType: 'terminal';
  lines: number;
}

/** A tab without a panel type is a terminal tab (the layout default). */
export const isTerminalTab = (tab: Pick<ITab, 'panelType'>): boolean => (tab.panelType ?? 'terminal') === 'terminal';

/** The number of lines in the text, without its trailing line breaks. */
export const countInputLines = (content: string): number => content.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;

/** The refusal body, or null when the text may reach the tab. */
export const terminalInputRefusal = (
  tab: Pick<ITab, 'id' | 'panelType'>,
  content: string,
  raw: boolean,
): ITerminalInputRefusal | null => {
  if (raw || !isTerminalTab(tab)) return null;
  const lines = countInputLines(content);
  if (lines <= 1) return null;
  return {
    error: `tab ${tab.id} is a terminal tab: its shell runs each line as a command, and this text holds ${lines} lines. `
      + 'Send one shell command line, send prose to an agent tab, or pass --raw (raw: true) to type the text as is.',
    code: TERMINAL_INPUT_CODE,
    tabId: tab.id,
    panelType: 'terminal',
    lines,
  };
};

/** `raw` in a request body: absent is false; null means a value that is not a boolean (refuse it). */
export const parseRawFlag = (raw: unknown): boolean | null => (raw === undefined ? false : typeof raw === 'boolean' ? raw : null);
