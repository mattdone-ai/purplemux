import { describe, expect, it } from 'vitest';
import { countInputLines, isTerminalTab, parseRawFlag, rawRefusalText, terminalInputRefusal } from '@/lib/terminal-command-line';

// Story 14, D30: a terminal tab takes one shell command line unless the caller passes raw.

describe('terminal-command-line', () => {
  it.each([
    ['ls -la', 1],
    ['ls -la\n', 1],
    ['ls -la\r\n\n', 1],
    ['a\nb', 2],
    ['a\r\nb\rc', 3],
    ['a\n\nb\n', 3],
  ])('countInputLines(%j) = %i', (content, lines) => {
    expect(countInputLines(content)).toBe(lines);
  });

  it('treats a tab without a panel type as a terminal tab, and no other type', () => {
    expect(isTerminalTab({})).toBe(true);
    expect(isTerminalTab({ panelType: 'terminal' })).toBe(true);
    for (const panelType of ['claude-code', 'codex-cli', 'grok-cli', 'agent-sessions', 'web-browser', 'diff'] as const) {
      expect(isTerminalTab({ panelType })).toBe(false);
    }
  });

  it('refuses multi-line text for a terminal tab only, and never with raw', () => {
    expect(terminalInputRefusal({ id: 't', panelType: 'terminal' }, 'a\nb', false)).toMatchObject({
      code: 'terminal-not-command-line', tabId: 't', panelType: 'terminal', lines: 2,
    });
    expect(terminalInputRefusal({ id: 't', panelType: 'terminal' }, 'a\nb', true)).toBeNull();
    expect(terminalInputRefusal({ id: 't', panelType: 'terminal' }, 'echo ok\n', false)).toBeNull();
    expect(terminalInputRefusal({ id: 't', panelType: 'claude-code' }, 'a\nb', false)).toBeNull();
  });

  it('parseRawFlag: absent is false, a boolean is itself, anything else is null', () => {
    expect(parseRawFlag(undefined)).toBe(false);
    expect(parseRawFlag(true)).toBe(true);
    expect(parseRawFlag(false)).toBe(false);
    expect(parseRawFlag('true')).toBeNull();
    expect(parseRawFlag(1)).toBeNull();
    expect(parseRawFlag(null)).toBeNull();
  });

  it('the refusal texts say what they saw and what they expected, and the terminal one names --raw', () => {
    expect(terminalInputRefusal({ id: 't', panelType: 'terminal' }, 'a\nb\nc', false)?.error).toBe(
      'tab t is a terminal tab, whose shell runs each line as a command: saw 3 lines; expected one shell command line. '
      + 'A multi-line command (a heredoc, a quoted multi-line string, a backslash continuation) needs --raw (raw: true); '
      + 'prose belongs in an agent tab.',
    );
    expect(rawRefusalText('yes')).toBe('raw: saw the string "yes"; expected true or false');
    expect(rawRefusalText(null)).toBe('raw: saw null; expected true or false');
    expect(rawRefusalText(1)).toBe('raw: saw number; expected true or false');
  });
});
