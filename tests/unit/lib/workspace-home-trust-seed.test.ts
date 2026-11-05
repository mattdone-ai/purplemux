import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// D14 (story 05 AC 1, ruling R-05 and the story 05 consult ruling): a tab's cwd inside a workspace
// directory is pre-trusted in the workspace's claude home; a cwd outside is not.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const readJson = async (file: string) => JSON.parse(await fs.readFile(file, 'utf-8'));

describe('seedProjectDecisions with a tab cwd (story 05)', () => {
  let workspace: string;
  let claudeHome: string;

  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-seed-')));
    workspace = path.join(mockHome.value, 'code', 'purplemux');
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    claudeHome = path.join(mockHome.value, 'claude-home');
    await fs.mkdir(claudeHome);
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const writeOwnerConfig = (projects: Record<string, unknown>) =>
    fs.writeFile(path.join(mockHome.value, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects }));

  it('pre-trusts a worktree under a workspace directory, at the cwd and its git root, with the inherited keys', async () => {
    await writeOwnerConfig({ [workspace]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(git:*)'], lastCost: 9 } });
    const worktree = path.join(workspace, '.worktrees', 'hfl2-05');
    await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
    const { seedProjectDecisions } = await import('@/lib/workspace-home');

    await seedProjectDecisions(claudeHome, [workspace], path.join(worktree, 'src'));

    const { projects, hasCompletedOnboarding } = await readJson(path.join(claudeHome, '.claude.json'));
    const expected = {
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash(git:*)'],
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
    };
    expect(projects[path.join(worktree, 'src')]).toEqual(expected);
    expect(projects[worktree]).toEqual(expected);
    // The workspace directory keeps its own inherited entry; telemetry stays behind.
    expect(projects[workspace]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash(git:*)'] });
    expect(hasCompletedOnboarding).toBe(true);
  });

  it('pre-trusts nothing for a cwd outside every workspace directory', async () => {
    await writeOwnerConfig({});
    const outside = path.join(mockHome.value, 'portfolio');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ projects: { [outside]: { hasTrustDialogAccepted: false } } }));
    const { seedProjectDecisions } = await import('@/lib/workspace-home');

    await seedProjectDecisions(claudeHome, [workspace], outside);

    const { projects } = await readJson(path.join(claudeHome, '.claude.json'));
    expect(projects[outside]).toEqual({ hasTrustDialogAccepted: false });
  });

  it('keeps an imports decline in the claude home and leaves a fully decided file byte-identical', async () => {
    await writeOwnerConfig({});
    const decided = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true };
    const file = path.join(claudeHome, '.claude.json');
    const before = JSON.stringify({ oauthAccount: { id: 'x' }, hasCompletedOnboarding: true, projects: { [workspace]: decided } });
    await fs.writeFile(file, before);
    const { seedProjectDecisions } = await import('@/lib/workspace-home');

    await seedProjectDecisions(claudeHome, [workspace], workspace);

    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });

  it('replaces the default-filled triple Claude writes for an undecided project', async () => {
    await writeOwnerConfig({});
    const file = path.join(claudeHome, '.claude.json');
    await fs.writeFile(file, JSON.stringify({
      projects: { [workspace]: { hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false, lastSessionId: 's-1' } },
    }));
    const { seedProjectDecisions } = await import('@/lib/workspace-home');

    await seedProjectDecisions(claudeHome, [workspace], workspace);

    expect((await readJson(file)).projects[workspace]).toEqual({
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true, lastSessionId: 's-1',
    });
  });

  it('keeps a decline the owner config holds for the nearest workspace directory', async () => {
    await writeOwnerConfig({ [workspace]: { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } });
    const sub = path.join(workspace, 'docs');
    await fs.mkdir(sub);
    const { seedProjectDecisions } = await import('@/lib/workspace-home');

    await seedProjectDecisions(claudeHome, [workspace], sub);

    expect((await readJson(path.join(claudeHome, '.claude.json'))).projects[sub]).toEqual({
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true,
    });
  });

  it('ensureWorkspaceClaudeHome passes the tab cwd through to the seed', async () => {
    await writeOwnerConfig({});
    await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'a', directories: [workspace] }] }));
    const { ensureWorkspaceClaudeHome } = await import('@/lib/workspace-home');

    const home = await ensureWorkspaceClaudeHome('ws-a', workspace);

    expect((await readJson(path.join(home, '.claude.json'))).projects[workspace]).toMatchObject({ hasTrustDialogAccepted: true });
  });
});
