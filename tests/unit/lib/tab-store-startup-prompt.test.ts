import { describe, expect, it } from 'vitest';
import { selectGlobalStatus, selectTabDisplayStatus, selectWorkspaceStatus } from '@/hooks/use-tab-store';
import type { ITabState } from '@/hooks/use-tab-store';
import type { TCliState } from '@/types/timeline';

// D14 (story 05): the web shows a tab at a Claude Code startup dialog as one that needs a person,
// through the same display states every indicator already maps; the token never reaches the face.

const tab = (cliState: TCliState, workspaceId = 'ws-a'): ITabState => ({ cliState, workspaceId } as ITabState);

describe('the web display of a startup-prompt tab (story 05, D14)', () => {
  it('displays as needs-input, never idle (as inactive does)', () => {
    expect(selectTabDisplayStatus({ t: tab('startup-prompt') }, 't')).toBe('needs-input');
    expect(selectTabDisplayStatus({ t: tab('inactive') }, 't')).toBe('idle');
  });

  it('counts toward attention in the workspace and the global badge', () => {
    const tabs = { a: tab('startup-prompt'), b: tab('busy'), c: tab('inactive') };
    expect(selectWorkspaceStatus(tabs, 'ws-a')).toEqual({ busyCount: 1, attentionCount: 1 });
    expect(selectGlobalStatus(tabs)).toEqual({ busyCount: 1, attentionCount: 1 });
  });
});
