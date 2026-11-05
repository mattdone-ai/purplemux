import { describe, expect, it } from 'vitest';
import { readClaudeUsage } from '@/lib/stats/claude-usage-line';

const entry = (overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: '2026-10-25T23:59:59.000Z', sessionId: 's-1', uuid: 'u-1',
  message: { id: 'msg-1', model: 'claude-opus-4-6', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5,
    cache_creation_input_tokens: 9, ...usage }, ...message },
  ...overrides,
});

describe('readClaudeUsage', () => {
  it('reads tokens, model, session and the UTC day and time of the line', () => {
    expect(readClaudeUsage(entry())).toEqual({
      messageId: 'msg-1', model: 'claude-opus-4-6', sessionId: 's-1', sidechain: false, day: '2026-10-25', at: Date.parse('2026-10-25T23:59:59.000Z'),
      input: 3, output: 4, cacheRead: 5, cacheCreation: 9, cacheCreation5m: 9, cacheCreation1h: 0,
    });
  });

  it('reads no time from a timestamp that does not parse, and still counts the line on its day', () => {
    expect(readClaudeUsage(entry({ timestamp: '2026-10-25 garbled' }))).toMatchObject({ day: '2026-10-25', at: null });
  });

  it('splits cache creation by its stated 5m and 1h parts, else 5m is the rest of the 1h part', () => {
    expect(readClaudeUsage(entry({}, {}, { cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 7 } })))
      .toMatchObject({ cacheCreation: 9, cacheCreation5m: 2, cacheCreation1h: 7 });
    expect(readClaudeUsage(entry({}, {}, { cache_creation: { ephemeral_1h_input_tokens: 4 } })))
      .toMatchObject({ cacheCreation5m: 5, cacheCreation1h: 4 });
  });

  it('falls back to the line uuid, then to no id', () => {
    expect(readClaudeUsage(entry({}, { id: undefined }))?.messageId).toBe('u-1');
    expect(readClaudeUsage(entry({ uuid: undefined }, { id: undefined }))?.messageId).toBe('');
  });

  it('marks a subagent line as sidechain', () => {
    expect(readClaudeUsage(entry({ isSidechain: true }))?.sidechain).toBe(true);
  });

  it.each([
    ['a user line', entry({ type: 'user' })],
    ['no timestamp', entry({ timestamp: '' })],
    ['no message', entry({ message: undefined })],
    ['no model', entry({}, { model: '' })],
    ['a placeholder model', entry({}, { model: '<synthetic>' })],
    ['no usage', entry({}, { usage: undefined })],
  ])('reads nothing from %s', (_name, line) => {
    expect(readClaudeUsage(line as Record<string, unknown>)).toBeNull();
  });
});
