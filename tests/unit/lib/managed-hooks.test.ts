import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { managedHookSkipNote, managedPreToolUseHookFiles, matcherSelects } from './managed-hooks';

let dir = '';
const write = async (relative: string, content: unknown) => {
  const file = path.join(dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};
const preToolUse = (matcher: string) => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'true' }] }] } });

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-managed-hooks-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('managedPreToolUseHookFiles: the evaluator tests skip where a managed PreToolUse hook refuses first', () => {
  it('finds none when the managed settings directory is absent or empty', async () => {
    expect(managedPreToolUseHookFiles('Bash', path.join(dir, 'absent'), 'linux')).toEqual([]);
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([]);
  });

  it('names managed-settings.json when it wires a PreToolUse hook', async () => {
    const file = await write('managed-settings.json', preToolUse('Bash'));
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([file]);
  });

  it('names each drop-in in managed-settings.d that wires one, in name order, and ignores non-json files', async () => {
    const b = await write('managed-settings.d/20-b.json', preToolUse('Read|Bash'));
    const a = await write('managed-settings.d/10-a.json', preToolUse('Bash'));
    await write('managed-settings.d/30-c.json.bak', preToolUse('Bash'));
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([a, b]);
  });

  // vel-MC-ACT-FU (#63 review): the matcher decides. A managed hook on Read alone runs before no Bash call, so the
  // Bash tests still prove the permission layer there; a hook whose matcher takes Bash skips them.
  it('a PreToolUse hook whose matcher does not take Bash skips no Bash test', async () => {
    await write('managed-settings.json', preToolUse('Read'));
    await write('managed-settings.d/a.json', preToolUse('Edit|Write|MultiEdit|Read|Grep|Glob'));
    await write('managed-settings.d/b.json', preToolUse('Notebook.*'));
    await write('managed-settings.d/c.json', preToolUse('BashOutput'));
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([]);
    expect(managedPreToolUseHookFiles('Read', dir, 'linux')).toHaveLength(2);
  });

  it('a PreToolUse hook whose matcher takes Bash skips the Bash tests: exact, a list, a regex, *, empty or absent', async () => {
    const files = [
      await write('managed-settings.d/1.json', preToolUse('Bash')),
      await write('managed-settings.d/2.json', preToolUse('Read|Bash')),
      await write('managed-settings.d/3.json', preToolUse('Ba.*')),
      await write('managed-settings.d/4.json', preToolUse('*')),
      await write('managed-settings.d/5.json', preToolUse('')),
      await write('managed-settings.d/6.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
    ];
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual(files);
  });

  it('one entry that takes Bash is enough, beside entries that do not', async () => {
    const file = await write('managed-settings.json', { hooks: { PreToolUse: [
      { matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] },
    ] } });
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([file]);
  });

  it('matcherSelects reads the documented matcher forms', () => {
    expect(matcherSelects('Bash', 'Bash')).toBe(true);
    expect(matcherSelects('Edit|Write', 'Bash')).toBe(false);
    expect(matcherSelects('BashOutput', 'Bash')).toBe(false);
    expect(matcherSelects('mcp__.*', 'Bash')).toBe(false);
    expect(matcherSelects('mcp__.*', 'mcp__chrome-devtools__navigate_page')).toBe(true);
    expect(matcherSelects(42, 'Bash')).toBe(false);
    expect(matcherSelects(undefined, 'Bash')).toBe(true);
  });

  // #65 review: a matcher that is not a valid expression cannot be read, so it counts as selecting the tool. The test
  // skips with its reason; it never runs under a hook that might refuse first and fail for the wrong cause.
  it('an invalid regex matcher counts as selecting the tool (fail safe)', async () => {
    expect(matcherSelects('(unclosed', 'Bash')).toBe(true);
    expect(matcherSelects('[', 'Read')).toBe(true);
    const file = await write('managed-settings.json', preToolUse('(unclosed'));
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([file]);
  });

  it('ignores files with no PreToolUse hook: other events, an empty hook list, other keys, invalid JSON', async () => {
    await write('managed-settings.json', { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] } });
    await write('managed-settings.d/a.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } });
    await write('managed-settings.d/b.json', { permissions: { deny: ['Bash'] } });
    await write('managed-settings.d/c.json', '{ not json');
    await write('managed-settings.d/d.json', 'null');
    expect(managedPreToolUseHookFiles('Bash', dir, 'linux')).toEqual([]);
  });

  it('reads only on Linux', async () => {
    await write('managed-settings.json', preToolUse('Bash'));
    expect(managedPreToolUseHookFiles('Bash', dir, 'darwin')).toEqual([]);
  });

  it('the skip note names the files and the reason, and no host', () => {
    expect(managedHookSkipNote(['/etc/claude-code/managed-settings.json'])).toBe(
      'managed Bash hooks on this host refuse first; the permission layer is proven on hosts without them (/etc/claude-code/managed-settings.json)');
  });
});
