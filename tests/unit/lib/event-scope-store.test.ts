import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IEventScope } from '@/types/worker-event';

// The event scope file (ADR-0043 §1): absent is empty, malformed is refused, writes are atomic 0600.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const { eventScopesFile, mutateEventScopes, readEventScopes } = await import('@/lib/event-scope-store');

const SCOPE: IEventScope = {
  workspaceId: 'ws-1', tabId: 'tab-w1', epic: 'alpha', story: null, dependsOn: ['beta'], attempt: 1,
  declaredBy: { workspaceId: 'ws-1', tabId: 'tab-o1' }, declaredAt: 1,
};

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-scopes-'));
});

afterEach(async () => {
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('event scope store', () => {
  it('reads an absent file as no scopes', async () => {
    await expect(readEventScopes()).resolves.toEqual({ scopes: [] });
  });

  it('writes the file 0600 and reads it back', async () => {
    await expect(mutateEventScopes((state) => ({ state: { scopes: [...state.scopes, SCOPE] }, value: 'done' }))).resolves.toBe('done');
    await expect(readEventScopes()).resolves.toEqual({ scopes: [SCOPE] });
    expect((await fs.stat(eventScopesFile())).mode & 0o777).toBe(0o600);
  });

  it('writes nothing when the state is unchanged', async () => {
    await mutateEventScopes((state) => ({ state, value: null }));
    await expect(fs.stat(eventScopesFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['not JSON', '{'],
    ['no scopes array', '{"scopes": 3}'],
    ['a malformed scope', JSON.stringify({ scopes: [{ ...SCOPE, attempt: 'one' }] })],
  ])('refuses a file with %s, so the next write does not erase it', async (_name, raw) => {
    await fs.mkdir(path.dirname(eventScopesFile()), { recursive: true });
    await fs.writeFile(eventScopesFile(), raw);
    await expect(readEventScopes()).rejects.toThrow();
    await expect(mutateEventScopes((state) => ({ state: { scopes: [...state.scopes, SCOPE] }, value: null }))).rejects.toThrow();
    await expect(fs.readFile(eventScopesFile(), 'utf8')).resolves.toBe(raw);
  });

  it('serialises concurrent mutations under one lock', async () => {
    const add = (tabId: string) => mutateEventScopes(async (state) => {
      await new Promise((r) => setTimeout(r, 5));
      return { state: { scopes: [...state.scopes, { ...SCOPE, tabId }] }, value: null };
    });
    await Promise.all([add('tab-a'), add('tab-b'), add('tab-c')]);
    expect((await readEventScopes()).scopes.map((s) => s.tabId).sort()).toEqual(['tab-a', 'tab-b', 'tab-c']);
  });
});
