import { describe, expect, it } from 'vitest';
import { WAKE_CLASS_TABLE, classifyWake, headerNames, isNoReplyMessage, parseSendHeader, type TWakeKind } from '@/lib/wake-class';
import type { TWakeClass } from '@/types/tab-events';

describe('the wake-class table (AC 1)', () => {
  it.each<[TWakeKind, TWakeClass]>([
    ['needs-input', 'urgent'],
    ['off-scope', 'urgent'],
    ['thrash', 'urgent'],
    ['api-error', 'urgent'],
    ['usage-limit', 'urgent'],
    ['inactive', 'urgent'],
    ['stalled', 'urgent'],
    ['model-drift', 'urgent'],
    ['ready-for-review', 'digest'],
    ['turn-ended', 'digest'],
    ['idle-no-end-line', 'digest'],
    ['long-wait', 'digest'],
    ['stuck', 'digest'],
    ['probe-failed', 'digest'],
    ['mission', 'urgent'],
    ['resume', 'urgent'],
    ['watch', 'urgent'],
    ['deploy', 'urgent'],
    ['note', 'digest'],
    ['red-main', 'urgent'],
    ['rotate', 'urgent'],
    ['standing-order', 'urgent'],
  ])('%s is %s', (kind, expected) => {
    expect(classifyWake(kind)).toBe(expected);
  });

  it.each<[string, TWakeClass]>([
    ['DONE: shipped', 'urgent'],
    ['BLOCKED: gate red', 'urgent'],
    ['NEEDS-DECISION: which option', 'urgent'],
    ['READY-TO-MERGE: owner/repo#1', 'urgent'],
    ['CHECKPOINTED: handoff at x.md', 'digest'],
    ['an end line with no marker', 'urgent'],
  ])('a turn ending "%s" is %s (the last line carries the verdict)', (last, expected) => {
    expect(classifyWake('turn-marker', { markerLines: ['READY-TO-MERGE: owner/repo#1', last] })).toBe(expected);
  });

  it('a turn marker with no lines is urgent', () => {
    expect(classifyWake('turn-marker')).toBe('urgent');
  });

  it.each(['bg-completed', 'bg-failed', 'bg-exited-unknown', 'bg-died'] as const)(
    '%s is urgent to the tab that waits on its job and digest to any other', (kind) => {
      expect(classifyWake(kind, { toWaitingTab: true })).toBe('urgent');
      expect(classifyWake(kind, { toWaitingTab: false })).toBe('digest');
    },
  );

  it('the first heartbeat of an idle episode is digest; later beats are unchanged and logged', () => {
    expect(classifyWake('heartbeat', { beat: 1 })).toBe('digest');
    expect(classifyWake('heartbeat', { beat: 2 })).toBe('log');
    expect(classifyWake('heartbeat', { beat: 3 })).toBe('log');
  });

  it('a block-severity flag or alarm is urgent; a warn flag or a ledger alarm is digest', () => {
    expect(classifyWake('flag', { severity: 'block' })).toBe('urgent');
    expect(classifyWake('flag', { severity: 'warn' })).toBe('digest');
    expect(classifyWake('alarm', { severity: 'block' })).toBe('urgent');
    expect(classifyWake('alarm', { severity: 'warn' })).toBe('digest');
  });

  const send = (text: string, recipientName = 'v2-orchestrator') => classifyWake('tab-send', { text, recipientName });

  it('a tab send is digest only to a tab that is a copy, or when it says no reply is needed (architect ruling 09-C1)', () => {
    // The orchestrator is the `->` addressee: the original, whatever the cc list.
    expect(send('SCOPE -> ORCH (cc H-1): slice 4 contract filed')).toBe('urgent');
    expect(send('[kit -> ORCH, cc SM]: rules diff')).toBe('urgent');
    expect(send('SCOPE -> ORCH, v2-fold1 (cc kit): DEC-387 is built for review')).toBe('urgent');
    // The orchestrator only on the cc list: a copy.
    expect(send('H-2 -> v2-fold1 (cc ORCH): rebased onto main')).toBe('digest');
    expect(send('[kit -> SM, cc ORCH]: rules diff')).toBe('digest');
    expect(send('SCOPE -> ORCH (cc H-1): slice 4 contract filed', 'v2-e1-helper-h1')).toBe('digest');
    expect(send('SM -> ORCH (cc kit, SCOPE): forecast refreshed', 'v2-kit')).toBe('digest');
    expect(send('Measure -> ORCH: pair unstuck. No reply needed.')).toBe('digest');
    expect(send('H-2 -> ORCH: KEY MOVE, span E group')).toBe('urgent');
    // A cc after the header is the body's business, not the routing.
    expect(send('kit -> ORCH: please cc the SM')).toBe('urgent');
    // No recipient name: nothing can be shown to be a copy.
    expect(classifyWake('tab-send', { text: 'H-2 -> v2-fold1 (cc ORCH): rebased' })).toBe('urgent');
  });

  it('a relayed owner answer is urgent, wherever the tab sits in the header (architect ruling 09-C1)', () => {
    expect(send("SM -> v2-fold1 (cc ORCH): OWNER, verbatim, SM tab ~21:4xZ: 'I authorise you to run that script.'")).toBe('urgent');
    expect(send('SM -> kit (cc ORCH): his answer, verbatim: "no we need an architect". No reply needed.')).toBe('urgent');
  });

  it('names a tab by its name, a part, a prefix of a part, or its initials', () => {
    expect(headerNames('ORCH', 'v2-orchestrator')).toBe(true);
    expect(headerNames('SM', 'v2-scrum-master')).toBe(true);
    expect(headerNames('kit', 'v2-kit')).toBe(true);
    expect(headerNames('H-1', 'v2-e1-helper-h1')).toBe(true);
    expect(headerNames('v2-fold1', 'v2-fold1')).toBe(true);
    expect(headerNames('Visa', 'v2-w-visa')).toBe(true);
    expect(headerNames('SM', 'v2-kit')).toBe(false);
    expect(headerNames('H-2', 'v2-e1-helper-h1')).toBe(false);
    expect(headerNames('or', 'v2-orchestrator')).toBe(false);
  });

  it('parses the header\'s recipients and copies', () => {
    expect(parseSendHeader('SCOPE -> ORCH, v2-fold2 (cc kit, SM): x')).toEqual({ to: ['ORCH', 'v2-fold2'], cc: ['kit', 'SM'] });
    expect(parseSendHeader('[kit -> ORCH, cc SM]: x')).toEqual({ to: ['ORCH'], cc: ['SM'] });
    expect(parseSendHeader('no header here: x')).toBeNull();
  });

  it('every kind of the table has a pinned class, and a kind outside it is urgent, never held', () => {
    const pinned = new Set(['needs-input', 'off-scope', 'thrash', 'api-error', 'usage-limit', 'inactive', 'stalled', 'model-drift',
      'ready-for-review', 'turn-ended', 'idle-no-end-line', 'long-wait', 'stuck', 'probe-failed', 'mission', 'resume', 'watch',
      'deploy', 'note', 'red-main', 'rotate', 'turn-marker', 'bg-completed', 'bg-failed', 'bg-exited-unknown', 'bg-died',
      'heartbeat', 'flag', 'alarm', 'tab-send', 'standing-order', 'curator-candidate']);
    expect(new Set(Object.keys(WAKE_CLASS_TABLE))).toEqual(pinned);
    expect(classifyWake('something-new')).toBe('urgent');
    expect(classifyWake('toString')).toBe('urgent');
    expect(classifyWake('__proto__')).toBe('urgent');
  });

  it('a copy whose body or header line carries an urgent end marker is urgent (review r2, F7; 09-C1)', () => {
    expect(send('kit -> SM (cc ORCH): status\nBLOCKED: gate red on main')).toBe('urgent');
    expect(send('H-2 -> kit (cc ORCH): landed\n  DONE: RF5 merged')).toBe('urgent');
    expect(send('Measure -> ORCH: x. No reply needed.\nNEEDS-DECISION: which window')).toBe('urgent');
    expect(send('kit -> SM (cc ORCH): READY-TO-MERGE: o/r#1')).toBe('urgent');
    expect(send('kit -> SM (cc ORCH): note\nCHECKPOINTED: handoff')).toBe('digest');
  });

  it('reads a copy only from the header and its recipient, never from a cc in the body', () => {
    expect(isNoReplyMessage('SM -> kit (cc ORCH): disk at 82%', 'v2-orchestrator')).toBe(true);
    expect(isNoReplyMessage('SM -> ORCH (cc kit): disk at 82%', 'v2-orchestrator')).toBe(false);
    expect(isNoReplyMessage('accounting ccy mismatch', 'v2-orchestrator')).toBe(false);
  });
});
