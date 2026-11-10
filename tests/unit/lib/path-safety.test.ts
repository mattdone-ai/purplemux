import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_ERROR_CODE,
  DIRECTORY_MISSING_ERROR,
  NOT_A_DIRECTORY_ERROR,
  OUTSIDE_HOME_ERROR,
  buildDirectoryValidation,
  canCreateDirectory,
  directoryError,
  isDirectoryError,
  planDirectoryCreate,
} from '@/lib/path-safety';

const HOME = '/home/user';

describe('canCreateDirectory', () => {
  it('accepts absolute paths inside home, including home itself', () => {
    expect(canCreateDirectory('/home/user/code/fresh', HOME)).toBe(true);
    expect(canCreateDirectory('/home/user/a/b/c', HOME)).toBe(true);
    expect(canCreateDirectory('/home/user', HOME)).toBe(true);
    expect(canCreateDirectory('/home/user/', HOME)).toBe(true);
  });

  it('rejects paths outside home', () => {
    expect(canCreateDirectory('/etc/x', HOME)).toBe(false);
    expect(canCreateDirectory('/', HOME)).toBe(false);
    expect(canCreateDirectory('/home', HOME)).toBe(false);
    expect(canCreateDirectory('/home/other/x', HOME)).toBe(false);
  });

  it('rejects a sibling home whose name merely starts with the home path', () => {
    expect(canCreateDirectory('/home/user-backup/x', HOME)).toBe(false);
  });

  it('rejects any path containing a .. segment, even one that resolves inside home', () => {
    expect(canCreateDirectory('/home/user/../user/x', HOME)).toBe(false);
    expect(canCreateDirectory('/home/user/../../etc/x', HOME)).toBe(false);
    expect(canCreateDirectory('/home/user/..', HOME)).toBe(false);
  });

  it('allows .. inside a path segment name', () => {
    expect(canCreateDirectory('/home/user/we..ird', HOME)).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(canCreateDirectory('code/fresh', HOME)).toBe(false);
    expect(canCreateDirectory('./fresh', HOME)).toBe(false);
    expect(canCreateDirectory('../fresh', HOME)).toBe(false);
  });

  it('treats a leading ~ as a literal directory name, never as home', () => {
    expect(canCreateDirectory('~/code/fresh', HOME)).toBe(false);
    expect(canCreateDirectory('~', HOME)).toBe(false);
    expect(canCreateDirectory('/home/user/~/x', HOME)).toBe(true);
  });

  it('never consults the filesystem — containment is lexical by design', () => {
    expect(canCreateDirectory('/home/user/projects/newthing', HOME)).toBe(true);
    expect(canCreateDirectory('/home/user/does-not-exist/at/all', HOME)).toBe(true);
  });

  it('rejects blank, non-string, and non-absolute home values', () => {
    expect(canCreateDirectory('', HOME)).toBe(false);
    expect(canCreateDirectory('   ', HOME)).toBe(false);
    expect(canCreateDirectory('/home/user/x', '')).toBe(false);
    expect(canCreateDirectory('/home/user/x', 'home/user')).toBe(false);
    expect(canCreateDirectory(undefined as unknown as string, HOME)).toBe(false);
    expect(canCreateDirectory('/home/user/x', null as unknown as string)).toBe(false);
  });
});

describe('buildDirectoryValidation', () => {
  it('reports an existing directory as valid with a suggested name', () => {
    expect(buildDirectoryValidation({ directory: '/home/user/code', home: HOME, stat: 'directory' })).toEqual({
      valid: true,
      suggestedName: 'code',
      exists: true,
      isDirectory: true,
      canCreate: true,
    });
  });

  it('reports an existing directory outside home as valid but not creatable', () => {
    expect(buildDirectoryValidation({ directory: '/etc', home: HOME, stat: 'directory' })).toEqual({
      valid: true,
      suggestedName: 'etc',
      exists: true,
      isDirectory: true,
      canCreate: false,
    });
  });

  it('reports a missing in-home path as creatable', () => {
    expect(buildDirectoryValidation({ directory: '/home/user/fresh', home: HOME, stat: 'missing' })).toEqual({
      valid: false,
      error: DIRECTORY_MISSING_ERROR,
      exists: false,
      isDirectory: false,
      canCreate: true,
    });
  });

  it('reports a missing path outside home as not creatable', () => {
    expect(buildDirectoryValidation({ directory: '/etc/x', home: HOME, stat: 'missing' })).toEqual({
      valid: false,
      error: DIRECTORY_MISSING_ERROR,
      exists: false,
      isDirectory: false,
      canCreate: false,
    });
  });

  it('reports an existing file as existing, not a directory, and never creatable', () => {
    expect(buildDirectoryValidation({ directory: '/home/user/notes.txt', home: HOME, stat: 'file' })).toEqual({
      valid: false,
      error: NOT_A_DIRECTORY_ERROR,
      exists: true,
      isDirectory: false,
      canCreate: false,
    });
  });
});

describe('planDirectoryCreate', () => {
  it('uses an existing directory whether or not mkdir was asked for', () => {
    expect(planDirectoryCreate({ directory: '/home/user/code', home: HOME, stat: 'directory', mkdir: false })).toEqual({ action: 'use' });
    expect(planDirectoryCreate({ directory: '/etc', home: HOME, stat: 'directory', mkdir: true })).toEqual({ action: 'use' });
  });

  it('creates a missing in-home path only when mkdir is opted in', () => {
    expect(planDirectoryCreate({ directory: '/home/user/fresh', home: HOME, stat: 'missing', mkdir: true })).toEqual({ action: 'create' });
    expect(planDirectoryCreate({ directory: '/home/user/fresh', home: HOME, stat: 'missing', mkdir: false })).toEqual({
      action: 'reject',
      error: DIRECTORY_MISSING_ERROR,
    });
  });

  it('refuses to create outside home even with mkdir', () => {
    for (const directory of ['/etc/x', '/home/user/../x', '~/../x', 'relative/x']) {
      expect(planDirectoryCreate({ directory, home: HOME, stat: 'missing', mkdir: true })).toEqual({
        action: 'reject',
        error: OUTSIDE_HOME_ERROR,
      });
    }
  });

  it('refuses an existing file without attempting a create', () => {
    expect(planDirectoryCreate({ directory: '/home/user/notes.txt', home: HOME, stat: 'file', mkdir: true })).toEqual({
      action: 'reject',
      error: NOT_A_DIRECTORY_ERROR,
    });
  });
});

describe('directoryError', () => {
  it('tags the error so callers can map it to 400 without matching on message text', () => {
    const err = directoryError(DIRECTORY_MISSING_ERROR);
    expect(err.message).toBe(DIRECTORY_MISSING_ERROR);
    expect((err as { code?: string }).code).toBe(DIRECTORY_ERROR_CODE);
    expect(isDirectoryError(err)).toBe(true);
  });

  it('does not tag unrelated failures', () => {
    expect(isDirectoryError(new Error('ENOSPC'))).toBe(false);
    expect(isDirectoryError(null)).toBe(false);
    expect(isDirectoryError('Directory does not exist')).toBe(false);
  });
});
