import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { paneAsSeen, paneShowsEmptyComposer, plainPaneShowsOptionList } from '@/lib/composer-readiness';
import { pointerRefusal, typeGuarded, type INotePointTargetDeps } from '@/lib/note-pointer';
import { composerHolds, isPaneShowingPendingLine } from '@/lib/tmux';
import type { ITab } from '@/types/terminal';

// PMUX-NOTE-DELIVERY: real captures (`capture-pane -p -e`) of Claude Code 2.1.322 at 120x50, mid-turn (writing a long
// answer, `esc to interrupt` on screen), 2026-11-12. A pointer line was typed into the busy composer, then Enter pressed.
// Busy Claude Code queues the line ABOVE the box ("ctrl+x ctrl+s to send now") and draws a dim hint in the empty box.

const pane = (name: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');
const LINE = '[purplemux note n-AbCdEf1234] from ws-test01/tab-test01 at 2026-11-12T04:20Z, flagged owner item, needs action now: '
  + 'run purplemux note show n-AbCdEf1234 now, then purplemux note ack n-AbCdEf1234';
const seen = (name: string) => paneAsSeen('claude-code', pane(name));

describe('a busy Claude Code pane, measured', () => {
  it('busy with an empty box: ready for a pointer line, no option list', () => {
    expect(paneShowsEmptyComposer('claude-code', pane('claude-busy-empty-composer.ansi'))).toBe(true);
    expect(plainPaneShowsOptionList(seen('claude-busy-empty-composer.ansi'))).toBe(false);
  });

  it('the typed line sits whole in the box, wrapped over two rows, and is no option list', () => {
    expect(isPaneShowingPendingLine(seen('claude-busy-line-in-composer.ansi'), LINE)).toBe(true);
    expect(plainPaneShowsOptionList(seen('claude-busy-line-in-composer.ansi'))).toBe(false);
    expect(paneShowsEmptyComposer('claude-code', pane('claude-busy-line-in-composer.ansi'))).toBe(false);
  });

  it('after Enter the line is queued above the box: read as submitted, and the box reads empty again', () => {
    expect(isPaneShowingPendingLine(seen('claude-busy-line-queued.ansi'), LINE)).toBe(false);
    expect(paneShowsEmptyComposer('claude-code', pane('claude-busy-line-queued.ansi'))).toBe(true);
    expect(plainPaneShowsOptionList(seen('claude-busy-line-queued.ansi'))).toBe(false);
  });
});

describe('typeGuarded: Enter only when the screen shows the whole line in the box and no dialog', () => {
  const TAB = { id: 'tab-a', name: 'orch', sessionName: 'pt-ws-1-p-tab-a', panelType: 'claude-code' } as unknown as ITab;
  const OPTIONS = 'Allow this command?\n❯ 1. Yes\n  2. No\n';

  /** A target whose captures follow `screens` in order (the last one repeats); records every key it was sent. */
  const target = (screens: Array<string | null>, permission: () => boolean = () => false) => {
    const keys: string[] = [];
    let read = 0;
    const deps: INotePointTargetDeps = {
      findTab: async () => TAB,
      hasSession: async () => true,
      status: () => ({ cliState: 'busy', permissionRequest: permission() ? { id: 'p' } : null }) as never,
      halted: () => false,
      capture: async () => screens[Math.min(read++, screens.length - 1)],
      withDispatchLock: async (_ws, _tab, work) => work(async () => ({ ok: true })),
      typeText: async (_s, line) => { keys.push(`type:${line.slice(0, 26)}`); },
      pressEnter: async () => { keys.push('Enter'); },
      beforeSubmit: async () => { keys.push('record'); },
      sleep: async () => {},
    };
    return { deps, keys };
  };
  const typed = pane('claude-busy-line-in-composer.ansi');
  const queued = pane('claude-busy-line-queued.ansi');

  it('measured: typed, seen in the box, one Enter, queued above the box: submitted', async () => {
    const { deps, keys } = target([typed, queued]);
    expect(await typeGuarded(deps, TAB, LINE)).toEqual({ outcome: 'submitted', cliState: 'busy' });
    expect(keys).toEqual([`type:${LINE.slice(0, 26)}`, 'record', 'Enter']);
  });

  it('a swallowed Enter gets one more Enter after a fresh capture', async () => {
    const { deps, keys } = target([typed, typed, queued]);
    expect(await typeGuarded(deps, TAB, LINE)).toMatchObject({ outcome: 'submitted' });
    expect(keys.filter((k) => k === 'Enter')).toHaveLength(2);
  });

  it('a line still in the box after the second Enter is stranded: no third Enter', async () => {
    const { deps, keys } = target([typed]);
    expect(await typeGuarded(deps, TAB, LINE)).toEqual({ outcome: 'stranded', cliState: 'busy', detail: 'line-in-composer' });
    expect(keys.filter((k) => k === 'Enter')).toHaveLength(2);
  });

  it('a permission request raised before the Enter: no Enter, unverified', async () => {
    const { deps, keys } = target([typed], () => true);
    expect(await typeGuarded(deps, TAB, LINE)).toMatchObject({ outcome: 'unverified', detail: 'dialog' });
    expect(keys).not.toContain('Enter');
  });

  it('an option list drawn under the typed line: no Enter, unverified', async () => {
    const { deps, keys } = target([`${typed}\n${OPTIONS}`]);
    expect(await typeGuarded(deps, TAB, LINE)).toMatchObject({ outcome: 'unverified', detail: 'dialog' });
    expect(keys).not.toContain('Enter');
  });

  it('a dialog after the first Enter, with the line still in the box: no second Enter', async () => {
    let enters = 0;
    const { deps, keys } = target([typed, typed], () => enters > 0);
    const press = deps.pressEnter;
    deps.pressEnter = async (s) => { enters += 1; await press(s); };
    expect(await typeGuarded(deps, TAB, LINE)).toMatchObject({ outcome: 'unverified', detail: 'dialog' });
    expect(keys.filter((k) => k === 'Enter')).toHaveLength(1);
  });

  // Round 2 (review concern): a person may type in the box between the readiness check and the typing. Only a box
  // that holds exactly the typed line is submitted; anything else is never submitted and never cleared.
  const BEFORE = typed.replace('\x1b[39m[purplemux note n-AbCdEf1234]', '\x1b[39mcommit this [purplemux note n-AbCdEf1234]');
  const AFTER = typed.replace('note ack n-AbCdEf1234', 'note ack n-AbCdEf1234 and push to main');
  const INSIDE = typed.replace('n-AbCdEf1234] from', 'n-AbCdEf1234]xx from');

  it.each([
    ['before the line', BEFORE],
    ['after the line', AFTER],
    ['inside the line', INSIDE],
  ])('text typed %s: no Enter, nothing cleared, composer-not-clean', async (_name, screen) => {
    expect(screen).not.toBe(typed);
    const { deps, keys } = target([screen]);
    expect(await typeGuarded(deps, TAB, LINE)).toEqual({ outcome: 'not-clean', cliState: 'busy', detail: 'composer-not-clean' });
    expect(keys).toEqual([`type:${LINE.slice(0, 26)}`]);
  });

  it('text a person adds after the first Enter, with the line still in the box: no second Enter', async () => {
    const { deps, keys } = target([typed, AFTER]);
    expect(await typeGuarded(deps, TAB, LINE)).toMatchObject({ outcome: 'not-clean' });
    expect(keys.filter((k) => k === 'Enter')).toHaveLength(1);
  });

  it('the box reads exactly the line, whatever its wrapping; anything more or less does not', () => {
    const plain = (screen: string) => paneAsSeen('claude-code', screen);
    expect(composerHolds(plain(typed), LINE)).toBe('exact');
    expect(composerHolds(plain(BEFORE), LINE)).toBe('with-other-text');
    expect(composerHolds(plain(AFTER), LINE)).toBe('with-other-text');
    expect(composerHolds(plain(INSIDE), LINE)).toBe('other-text');
    expect(composerHolds(plain(pane('claude-busy-empty-composer.ansi')), LINE)).toBe('empty');
    expect(composerHolds(plain(queued), LINE)).toBe('empty');
    // No drawn box: only a marker line that holds the line can be read.
    expect(composerHolds(`out\n❯ ${LINE}\n`, LINE)).toBe('exact');
    expect(composerHolds(`out\n❯ draft ${LINE}\n`, LINE)).toBe('with-other-text');
    expect(composerHolds('out\n❯ \n', LINE)).toBe('unknown');
  });

  it('an unreadable capture is never a receipt, before or after the Enter', async () => {
    const before = target([null]);
    expect(await typeGuarded(before.deps, TAB, LINE)).toMatchObject({ outcome: 'unverified', detail: 'capture-failed' });
    expect(before.keys).not.toContain('Enter');
    const after = target([typed, null]);
    expect(await typeGuarded(after.deps, TAB, LINE)).toMatchObject({ outcome: 'unverified', detail: 'capture-failed' });
    expect(after.keys.filter((k) => k === 'Enter')).toHaveLength(1);
  });

  it('busy is admitted for Claude Code only: a busy codex or grok tab is refused', async () => {
    for (const panelType of ['codex-cli', 'grok-cli'] as const) {
      const tab = { ...TAB, panelType } as ITab;
      const { deps } = target(['done\n────────\n› \n────────\n']);
      expect(await pointerRefusal({ ...deps, findTab: async () => tab }, 'ws-1', tab, async () => ({ ok: true }))).toEqual({
        code: 'note-point-not-ready', reason: 'composer-not-ready:busy',
      });
    }
    const { deps } = target([pane('claude-busy-empty-composer.ansi')]);
    expect(await pointerRefusal(deps, 'ws-1', TAB, async () => ({ ok: true }))).toBeNull();
  });
});
