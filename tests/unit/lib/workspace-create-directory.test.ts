import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECTORY_MISSING_ERROR, NOT_A_DIRECTORY_ERROR, OUTSIDE_HOME_ERROR, isDirectoryError } from '@/lib/path-safety';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

vi.mock('@/lib/tmux', () => ({ listSessions: vi.fn(async () => []), killSession: vi.fn() }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/registry', () => ({ listProviders: () => [] }));
vi.mock('@/lib/grok-home', () => ({ removeWorkspaceGrokHome: vi.fn() }));
vi.mock('@/lib/workspace-home', () => ({ removeWorkspaceClaudeHome: vi.fn() }));
vi.mock('@/lib/workspace-token', () => ({ revokeWorkspaceToken: vi.fn() }));
vi.mock('@/lib/layout-store', () => ({
  createDefaultLayout: vi.fn(async (workspaceId: string) => ({ version: 1, workspaceId, root: null })),
  readLayoutFile: vi.fn(async () => null),
  writeLayoutFile: vi.fn(),
  resolveLayoutDir: () => path.join(mockHome.value, '.purplemux', 'layouts'),
  resolveLayoutFile: () => path.join(mockHome.value, '.purplemux', 'layouts', 'layout.json'),
  collectAllTabs: () => [],
  updateTabAgentSessionId: vi.fn(),
}));

const importStore = async () => {
  vi.resetModules();
  return import('@/lib/workspace-store');
};

const exists = async (target: string): Promise<boolean> =>
  fs.stat(target).then(() => true, () => false);

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ws-create-'));
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
});

describe('createWorkspace directory handling', () => {
  it('creates a missing in-home directory, including parents, when mkdir is opted in', async () => {
    const { createWorkspace } = await importStore();
    const target = path.join(mockHome.value, 'code', 'fresh-epic');

    const workspace = await createWorkspace(target, undefined, undefined, { mkdir: true });

    expect(workspace.directories).toEqual([target]);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('accepts an existing directory the same way it always did', async () => {
    const { createWorkspace } = await importStore();
    const target = path.join(mockHome.value, 'existing');
    await fs.mkdir(target);

    await expect(createWorkspace(target)).resolves.toMatchObject({ directories: [target] });
  });

  it('refuses a missing directory without mkdir and leaves nothing behind', async () => {
    const { createWorkspace } = await importStore();
    const target = path.join(mockHome.value, 'never-created');

    await expect(createWorkspace(target)).rejects.toThrow(DIRECTORY_MISSING_ERROR);
    expect(await exists(target)).toBe(false);
  });

  it('refuses to create outside the home directory even with mkdir', async () => {
    const { createWorkspace } = await importStore();

    for (const target of ['/etc/pmux-should-not-exist', path.join(mockHome.value, '..', 'pmux-escape'), 'relative-dir']) {
      await expect(createWorkspace(target, undefined, undefined, { mkdir: true })).rejects.toThrow(OUTSIDE_HOME_ERROR);
      expect(await exists(target)).toBe(false);
    }
  });

  // Pins the deliberate limitation documented on canCreateDirectory: containment is
  // lexical, so a symlinked ancestor is followed. `~/projects -> /mnt/big/projects` is
  // an ordinary setup that a realpath rule would refuse.
  it('creates through a symlinked ancestor that points outside home', async () => {
    const { createWorkspace } = await importStore();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ws-outside-'));
    await fs.symlink(outside, path.join(mockHome.value, 'projects'));
    const target = path.join(mockHome.value, 'projects', 'newthing');

    await expect(createWorkspace(target, undefined, undefined, { mkdir: true })).resolves.toMatchObject({
      directories: [target],
    });
    expect((await fs.stat(path.join(outside, 'newthing'))).isDirectory()).toBe(true);
  });

  it('refuses an existing file without attempting a create', async () => {
    const { createWorkspace } = await importStore();
    const target = path.join(mockHome.value, 'notes.txt');
    await fs.writeFile(target, 'hello');

    await expect(createWorkspace(target, undefined, undefined, { mkdir: true })).rejects.toThrow(NOT_A_DIRECTORY_ERROR);
    expect((await fs.stat(target)).isFile()).toBe(true);
  });

  it('tags every directory refusal so the API answers 400 rather than 500', async () => {
    const { createWorkspace } = await importStore();

    const err = await createWorkspace(path.join(mockHome.value, 'missing')).catch((e: unknown) => e);
    expect(isDirectoryError(err)).toBe(true);
  });
});

describe('createWorkspace name uniqueness and extra directories (CLI create, ADR-0024)', () => {
  it('refuses a name another workspace holds, ignoring case and outer spaces, before any session starts', async () => {
    const { createWorkspace } = await importStore();
    const { createDefaultLayout } = await import('@/lib/layout-store');
    const first = await createWorkspace(mockHome.value, 'Acme-ledger v2', undefined, { uniqueName: true });
    vi.mocked(createDefaultLayout).mockClear();

    const err = await createWorkspace(mockHome.value, '  acme-ledger V2 ', undefined, { uniqueName: true }).catch((e: unknown) => e);

    const { isWorkspaceNameTakenError } = await importStore();
    expect(isWorkspaceNameTakenError(err)).toBe(true);
    expect((err as Error).message).toBe(`a workspace named "Acme-ledger v2" already exists (${first.id})`);
    expect(createDefaultLayout).not.toHaveBeenCalled();
    const stored = JSON.parse(await fs.readFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), 'utf-8'));
    expect(stored.workspaces.map((w: { name: string }) => w.name)).toEqual(['Acme-ledger v2']);
  });

  it('lets exactly one of two concurrent creates of the same name through', async () => {
    const { createWorkspace, isWorkspaceNameTakenError } = await importStore();
    const { createDefaultLayout } = await import('@/lib/layout-store');
    vi.mocked(createDefaultLayout).mockClear();

    const results = await Promise.allSettled([
      createWorkspace(mockHome.value, 'Race', undefined, { uniqueName: true }),
      createWorkspace(mockHome.value, 'race', undefined, { uniqueName: true }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(isWorkspaceNameTakenError(refused[0].reason)).toBe(true);
    expect(createDefaultLayout).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(await fs.readFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), 'utf-8'));
    expect(stored.workspaces).toHaveLength(1);
  });

  it('refuses a taken name before it creates a missing directory', async () => {
    const { createWorkspace } = await importStore();
    await createWorkspace(mockHome.value, 'Taken', undefined, { uniqueName: true });
    const target = path.join(mockHome.value, 'would-be-created');

    await expect(createWorkspace(target, 'taken', undefined, { uniqueName: true, mkdir: true })).rejects.toThrow('already exists');
    expect(await exists(target)).toBe(false);
  });

  it('keeps the UI behaviour: without uniqueName a repeated name is accepted', async () => {
    const { createWorkspace } = await importStore();
    await createWorkspace(mockHome.value, 'same');
    await expect(createWorkspace(mockHome.value, 'same')).resolves.toMatchObject({ name: 'same' });
  });

  it('stores the extra directories after the primary in the same write', async () => {
    const { createWorkspace } = await importStore();
    const other = path.join(mockHome.value, 'other');
    await fs.mkdir(other);

    const workspace = await createWorkspace(mockHome.value, 'multi', undefined, { uniqueName: true, extraDirectories: [other] });

    expect(workspace.directories).toEqual([mockHome.value, other]);
    const stored = JSON.parse(await fs.readFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), 'utf-8'));
    expect(stored.workspaces[0].directories).toEqual([mockHome.value, other]);
  });
});

describe('validateDirectory', () => {
  it('reports an existing directory', async () => {
    const { validateDirectory } = await importStore();
    const target = path.join(mockHome.value, 'code');
    await fs.mkdir(target);

    expect(await validateDirectory(target)).toEqual({
      valid: true,
      suggestedName: 'code',
      exists: true,
      isDirectory: true,
      canCreate: true,
    });
  });

  it('reports a missing in-home path as creatable', async () => {
    const { validateDirectory } = await importStore();

    expect(await validateDirectory(path.join(mockHome.value, 'fresh'))).toEqual({
      valid: false,
      error: DIRECTORY_MISSING_ERROR,
      exists: false,
      isDirectory: false,
      canCreate: true,
    });
  });

  it('reports a missing path outside home as not creatable', async () => {
    const { validateDirectory } = await importStore();

    expect(await validateDirectory('/etc/pmux-should-not-exist')).toEqual({
      valid: false,
      error: DIRECTORY_MISSING_ERROR,
      exists: false,
      isDirectory: false,
      canCreate: false,
    });
  });

  it('reports an existing file', async () => {
    const { validateDirectory } = await importStore();
    const target = path.join(mockHome.value, 'notes.txt');
    await fs.writeFile(target, 'hello');

    expect(await validateDirectory(target)).toEqual({
      valid: false,
      error: NOT_A_DIRECTORY_ERROR,
      exists: true,
      isDirectory: false,
      canCreate: false,
    });
  });
});
