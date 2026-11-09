import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { managedHookSkipNote, managedPreToolUseHookFiles } from './managed-hooks';

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
    expect(managedPreToolUseHookFiles(path.join(dir, 'absent'), 'linux')).toEqual([]);
    expect(managedPreToolUseHookFiles(dir, 'linux')).toEqual([]);
  });

  it('names managed-settings.json when it wires a PreToolUse hook', async () => {
    const file = await write('managed-settings.json', preToolUse('Bash'));
    expect(managedPreToolUseHookFiles(dir, 'linux')).toEqual([file]);
  });

  it('names each drop-in in managed-settings.d that wires one, in name order, and ignores non-json files', async () => {
    const b = await write('managed-settings.d/20-b.json', preToolUse('Read'));
    const a = await write('managed-settings.d/10-a.json', preToolUse('Bash'));
    await write('managed-settings.d/30-c.json.bak', preToolUse('Bash'));
    expect(managedPreToolUseHookFiles(dir, 'linux')).toEqual([a, b]);
  });

  it('ignores files with no PreToolUse hook: other events, an empty hook list, other keys, invalid JSON', async () => {
    await write('managed-settings.json', { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] } });
    await write('managed-settings.d/a.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } });
    await write('managed-settings.d/b.json', { permissions: { deny: ['Bash'] } });
    await write('managed-settings.d/c.json', '{ not json');
    await write('managed-settings.d/d.json', 'null');
    expect(managedPreToolUseHookFiles(dir, 'linux')).toEqual([]);
  });

  it('reads only on Linux', async () => {
    await write('managed-settings.json', preToolUse('Bash'));
    expect(managedPreToolUseHookFiles(dir, 'darwin')).toEqual([]);
  });

  it('the skip note names the files and the reason, and no host', () => {
    expect(managedHookSkipNote(['/etc/claude-code/managed-settings.json'])).toBe(
      'managed hooks on this host refuse first; the permission layer is proven on hosts without them (/etc/claude-code/managed-settings.json)');
  });
});
