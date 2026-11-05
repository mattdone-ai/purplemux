import fs from 'fs';
import path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import FlowPanel, {
  FLOW_LIST_URL, FLOW_REFRESH_MS, FlowPanelContent, flowDetailUrl, flowSelection, newestFlowWorkspace,
} from '@/components/features/mission-control/flow-panel';
import type { IFlowPanelContentProps } from '@/components/features/mission-control/flow-panel';
import { BOARD_URL, PULSE_URL } from '@/components/features/mission-control/owner-board';
import { deriveConstraint } from '@/lib/constraint';
import MissionControlPage from '@/pages/mission-control';
import type { IFlowDerived, IFlowRecord, IMissionFlowDetailResponse, IMissionFlowListResponse, IMissionFlowSummary } from '@/types/flow';

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const THRESHOLDS = { windowMinutes: 360, lockBusyPercent: 80, queueLength: 10, oldestMinutes: 240 };

const summary = (over: Partial<IMissionFlowSummary> = {}): IMissionFlowSummary => ({
  workspaceId: 'ws-a', workspaceName: 'alpha', receivedAt: NOW - MIN, generatedAt: NOW - MIN, source: 'v2-flow',
  stale: false, producerFlagCount: 1, derivedFlagCount: 2, ...over,
});

const list = (workspaces: IMissionFlowSummary[] = [summary()], errors: IMissionFlowListResponse['errors'] = []): IMissionFlowListResponse =>
  ({ workspaces, errors });

const record = (over: Partial<IFlowRecord> = {}): IFlowRecord => ({
  workspaceId: 'ws-a', receivedAt: NOW - MIN,
  snapshot: {
    schemaVersion: 1, generatedAt: NOW - MIN, source: 'v2-flow',
    queues: [
      { name: 'landing', capacity: 20, items: [
        { id: 'lane/a0', label: 'A0 landing', since: NOW - 67 * 60 * MIN, state: 'queued', pinned: true, holder: null },
        { id: 'lane/b1', label: null, since: NOW - 5 * MIN, state: 'active', pinned: false, holder: 'tab-x' },
        { id: 'lane/c2', label: null, since: NOW - 3 * MIN, state: 'held', pinned: false, holder: null },
      ] },
      { name: 'review', capacity: null, items: [] },
    ],
    locks: [{ name: 'landing', heldBy: 'lane/b1', since: NOW - 30 * MIN }, { name: 'deploy', heldBy: null, since: null }],
    meters: [
      { name: 'gate-slots', value: 6, unit: 'slots', limit: 5, windowMinutes: null },
      { name: 'reviews', value: 2, unit: '', limit: null, windowMinutes: 60 },
    ],
    flags: [{ text: 'main is red', severity: 'block' }],
  },
  history: [],
  ...over,
});

const derived = (over: Partial<IFlowDerived> = {}): IFlowDerived => ({
  flags: [
    { rule: 'queue-old', subject: 'landing', text: 'landing oldest item waits 67 h (threshold 4 h)', severity: 'warn' },
    { rule: 'lock-busy', subject: 'landing', text: 'landing held 92% of the last 6 h (threshold 80%)', severity: 'warn' },
  ],
  lockBusyShare: { landing: 0.92, deploy: null }, lockKnownMinutes: { landing: 360, deploy: 12.5 }, insufficientHistory: ['deploy'],
  windowMinutes: 360, thresholds: THRESHOLDS, ...over,
});

const detail = (over: Partial<IMissionFlowDetailResponse> = {}): IMissionFlowDetailResponse =>
  ({ workspaceId: 'ws-a', flow: record(), stale: false, derived: derived(), ...over });

const render = (props: Partial<IFlowPanelContentProps> = {}) => renderToStaticMarkup(
  <FlowPanelContent list={list()} listLoading={false} listError={null} selected="ws-a" detail={detail()} detailLoading={false}
    detailError={null} now={NOW} onRetry={() => {}} onSelect={() => {}} {...props} />,
);

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('FlowPanelContent', () => {
  it('shows derived and producer flags on top, then each queue, lock and meter', () => {
    const html = render();
    const plain = text(html);
    expect(html).toContain('aria-label="Flow"');
    expect(plain).toContain('Warning Oldest item waits landing oldest item waits 67 h (threshold 4 h)');
    expect(plain).toContain('Warning Lock busy landing held 92% of the last 6 h');
    expect(plain).toContain('Blocking From v2-flow main is red');
    expect(html.indexOf('main is red')).toBeLessThan(html.indexOf('>Queues<'));
    // The queue bar: one segment per item, by state, the pinned item marked, the capacity and the oldest age.
    expect(plain).toContain('3 items · capacity 20 · oldest 67 h');
    expect(html.match(/role="listitem"/g)).toHaveLength(3);
    expect(html).toMatch(/data-state="queued" data-pinned="true"/);
    expect(html).toContain('aria-label="pinned"');
    expect(html).toContain('title="A0 landing · Queued · pinned · waits 67 h"');
    expect(html).toContain('title="lane/b1 · Active · holder tab-x · waits 5 min"');
    expect(html).toContain('aria-label="17 free of capacity"');
    expect(plain).toContain('0 items · no capacity · oldest —');
    expect(plain).toContain('Empty');
    // Locks: holder, held since, busy share; a lock with too little history says so.
    expect(plain).toMatch(/Held by lane\/b1 since \w{3} \d+ \d\d:\d\d \(30 min\)/);
    expect(plain).toContain('Held 92% of the last 6 h');
    expect(plain).toContain('Free');
    expect(plain).toContain('Busy share unknown: 12 min known in the last 6 h');
    // Meters against their limit.
    expect(plain).toContain('6 slots of 5 slots');
    expect(html).toContain('aria-label="gate-slots against its limit"');
    expect(plain).toContain('2 · no limit · per 1 h');
    expect(plain).toContain('From v2-flow · published 1 min ago');
    expect(plain).not.toContain('stale');
  });

  it('offers every workspace with a record and marks the selected one, with its flag count or stale', () => {
    const html = render({ list: list([summary(), summary({ workspaceId: 'ws-b', workspaceName: 'beta', stale: true, producerFlagCount: 0, derivedFlagCount: 1 }),
      summary({ workspaceId: 'ws-c', workspaceName: 'gamma', producerFlagCount: 0, derivedFlagCount: 0 })]) });
    expect(html).toMatch(/aria-pressed="true"[^>]*>alpha<span[^>]*>3 flags<\/span>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>beta<span[^>]*>stale<\/span><span[^>]*>1 flag<\/span>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>gamma<\/button>/);
  });

  it('shows a stale record under "stale — last published <age> ago" and never as current', () => {
    const html = render({
      list: list([summary({ stale: true })]),
      detail: detail({ stale: true, flow: record({ receivedAt: NOW - 11 * MIN }),
        derived: derived({ flags: [{ rule: 'stale', subject: 'ws-a', text: 'no publish for 11 min', severity: 'warn' }] }) }),
    });
    const plain = text(html);
    expect(plain).toContain('stale — last published 11 min ago');
    expect(html.indexOf('stale — last published')).toBeLessThan(html.indexOf('>Queues<'));
    expect(plain).toContain('Warning Stale no publish for 11 min');
    expect(plain).toContain('main is red as of the last publish');
    expect(html).toContain('data-stale="true"');
    expect(plain).not.toContain('published 11 min ago ·');
    expect(plain).not.toContain('From v2-flow · published');
  });

  it('shows a kept answer as stale once it ages past 10 minutes while refreshes fail', () => {
    // The served answer said fresh; the refreshes since then failed and the clock moved on.
    const html = render({ detail: detail({ stale: false, flow: record({ receivedAt: NOW - 11 * MIN }) }), detailError: 'Bad Gateway' });
    const plain = text(html);
    expect(plain).toContain('stale — last published 11 min ago');
    expect(html).toContain('data-stale="true"');
    expect(plain).toContain('main is red as of the last publish');
    expect(plain).not.toContain('From v2-flow · published');
    // Ten minutes is not yet stale.
    expect(text(render({ detail: detail({ stale: false, flow: record({ receivedAt: NOW - 10 * MIN }) }) }))).not.toContain('stale —');
  });

  it('names the known time when the busy share covers less than the window', () => {
    const plain = text(render({ detail: detail({ derived: derived({ lockBusyShare: { landing: 1, deploy: null }, lockKnownMinutes: { landing: 181, deploy: 0 } }) }) }));
    expect(plain).toContain('Held 100% of 3 h 1 min known in the last 6 h');
    expect(plain).toContain('Busy share unknown: 0 min known in the last 6 h');
  });

  it('shows the error text of an unreadable record, and of a list it cannot read', () => {
    const unreadable = render({ detail: undefined, detailError: 'flow storage unreadable: the file is not JSON' });
    expect(text(unreadable)).toContain('Flow for alpha unreadable: flow storage unreadable: the file is not JSON');
    expect(unreadable).toContain('Retry');
    const listed = render({ list: list([summary()], [{ workspaceId: 'ws-b', error: 'flow storage unreadable: EACCES' }]) });
    expect(text(listed)).toContain('Flow for ws-b unreadable: flow storage unreadable: EACCES');
    expect(text(listed)).toContain('3 items');
    // Only an unreadable record: the panel still shows, with the error.
    const onlyError = render({ list: list([], [{ workspaceId: 'ws-b', error: 'flow storage unreadable: EIO' }]), selected: null, detail: undefined });
    expect(text(onlyError)).toContain('Flow for ws-b unreadable: flow storage unreadable: EIO');
    const failed = render({ list: undefined, listError: 'Internal Server Error' });
    expect(text(failed)).toContain('Flow unavailable: Internal Server Error');
    expect(failed).toContain('Retry');
  });

  it('keeps the last answer when a refresh fails, and says so', () => {
    const plain = text(render({ listError: 'Bad Gateway', detailError: 'Bad Gateway' }));
    expect(plain).toContain('Refresh failed: Bad Gateway. Showing the last answer.');
    expect(plain).toContain('3 items');
  });

  it('renders nothing while the list loads and when no workspace has a record', () => {
    expect(render({ list: undefined, listLoading: true })).toBe('');
    expect(render({ list: list([]), selected: null, detail: undefined })).toBe('');
    expect(render({ list: undefined })).toBe('');
  });

  it('says loading for the record, and no flow for a workspace whose record went away', () => {
    expect(text(render({ detail: undefined, detailLoading: true }))).toContain('Loading alpha flow…');
    expect(text(render({ detail: detail({ flow: null, stale: null, derived: undefined }) }))).toContain('No flow published for alpha.');
    // A detail answer for another workspace is never shown under this one.
    expect(text(render({ detail: detail({ workspaceId: 'ws-b' }), detailLoading: true }))).not.toContain('3 items');
  });

  it('labels an unknown rule, severity or item state with a neutral word, never the bare token', () => {
    const odd = record();
    odd.snapshot.queues[0].items[1] = { ...odd.snapshot.queues[0].items[1], state: 'parked' as never };
    odd.snapshot.flags = [{ text: 'odd', severity: 'urgent' as never }];
    const html = render({ detail: detail({ flow: odd, derived: derived({ flags: [
      { rule: 'queue-weird' as never, subject: 'landing', text: 'something new', severity: 'warn' },
      { rule: 'constructor' as never, subject: 'x', text: 'proto', severity: 'toString' as never },
    ] }) }) });
    const plain = text(html);
    expect(plain).toContain('Warning Flag something new rule queue-weird');
    expect(plain).toContain('Notice Flag proto severity toString · rule constructor');
    expect(plain).toContain('Notice From v2-flow odd severity urgent');
    expect(html).toContain('title="lane/b1 · Unknown state · state parked · holder tab-x · waits 5 min"');
  });

  it('says what an older server without derived answers cannot tell, never 0', () => {
    const html = render({ list: list([summary({ derivedFlagCount: undefined })]), detail: detail({ derived: undefined }) });
    const plain = text(html);
    expect(plain).toContain('Derived flags not available: this server does not derive them.');
    expect(plain).toContain('Busy share not available');
    expect(plain).toContain('alpha flags —');
    expect(plain).not.toContain('Busy 0%');
  });

  it('says no flags raised when nothing is flagged', () => {
    const html = render({ detail: detail({ flow: record({ snapshot: { ...record().snapshot, flags: [] } }), derived: derived({ flags: [] }) }) });
    expect(text(html)).toContain('No flags raised.');
  });
});

describe('newestFlowWorkspace', () => {
  it('picks the workspace that published last', () => {
    expect(newestFlowWorkspace([])).toBeNull();
    expect(newestFlowWorkspace([summary({ workspaceId: 'ws-a', receivedAt: 5 }), summary({ workspaceId: 'ws-b', receivedAt: 9 }),
      summary({ workspaceId: 'ws-c', receivedAt: 7 })])).toBe('ws-b');
  });
});

describe('flowSelection', () => {
  it('keeps the selection on every poll, and moves it only when the workspace leaves the list', () => {
    const a = summary({ workspaceId: 'ws-a', receivedAt: 10 });
    const b = summary({ workspaceId: 'ws-b', receivedAt: 20 });
    let selected = flowSelection(null, [a, b]);
    expect(selected).toBe('ws-b');
    // The two publishers alternate as the newest from poll to poll.
    for (let poll = 1; poll <= 4; poll += 1) {
      const rows = poll % 2 ? [{ ...a, receivedAt: 30 + poll }, b] : [a, { ...b, receivedAt: 30 + poll }];
      selected = flowSelection(selected, rows);
      expect(selected, `poll ${poll}`).toBe('ws-b');
    }
    expect(flowSelection('ws-a', [a, b])).toBe('ws-a');
    expect(flowSelection('ws-b', [a])).toBe('ws-a');
    expect(flowSelection('ws-b', [])).toBeNull();
  });
});

describe('FlowPanel through the SWR cache', () => {
  const cached = (fallback: Record<string, unknown>) => renderToStaticMarkup(
    <SWRConfig value={{ provider: () => new Map() as never, fallback }}><FlowPanel /></SWRConfig>,
  );

  it('selects the newest published workspace by default and reads its record', () => {
    const newer = record({ workspaceId: 'ws-b', snapshot: { ...record().snapshot, source: 'beta-board' } });
    const html = cached({
      [FLOW_LIST_URL]: list([summary(), summary({ workspaceId: 'ws-b', workspaceName: 'beta', receivedAt: NOW })]),
      [flowDetailUrl('ws-b')]: detail({ workspaceId: 'ws-b', flow: newer }),
    });
    expect(html).toMatch(/aria-pressed="true"[^>]*>beta/);
    expect(text(html)).toContain('From beta-board');
  });

  it('polls every 60 seconds and asks the human route only, with GETs', () => {
    expect(FLOW_REFRESH_MS).toBe(60_000);
    // The panel renders no history rows, so it asks for none.
    expect(flowDetailUrl('ws a/b')).toBe('/api/mission-control/flow?workspaceId=ws%20a%2Fb&history=none');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/components/features/mission-control/flow-panel.tsx'), 'utf-8');
    expect(source).not.toMatch(/method\s*:/);
    expect(source).not.toMatch(/\/api\/cli\//);
    expect(source.match(/fetch\(/g)).toHaveLength(2);
    expect(source.match(/'\/api\/[^']*'/g)).toEqual(["'/api/mission-control/flow'"]);
  });

  it('stores the selection from each list answer, so a poll never moves it', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/components/features/mission-control/flow-panel.tsx'), 'utf-8');
    expect(source).toMatch(/onSuccess:\s*\(data\)\s*=>\s*setChosen\(\(current\)\s*=>\s*flowSelection\(current,\s*data\.workspaces\)\)/);
  });
});

describe('the default Mission Control view', () => {
  it('mounts the flow panel inside the board\'s flow section, not beside the answer list (story 12 AC 6)', () => {
    const router = { pathname: '/mission-control', asPath: '/mission-control', query: {}, push: async () => true } as unknown as NextRouter;
    const board = (generatedAt: number) => ({ boards: [{ ...deriveConstraint(null, null, null, null, generatedAt), workspaceId: 'ws-a',
      stuckTotal: 0, needsYou: [], experiments: null, ageMs: 0, staleSince: null }] });
    const html = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map() as never, fallback: {
        [FLOW_LIST_URL]: list(), [flowDetailUrl('ws-a')]: detail(), [BOARD_URL]: board(NOW), [PULSE_URL]: { pulses: [] },
      } }}>
        <RouterContext.Provider value={router}><MissionControlPage /></RouterContext.Provider>
      </SWRConfig>,
    );
    const flowSection = html.indexOf('data-board-section="flow"');
    const flow = html.indexOf('aria-label="Flow"');
    expect(flowSection).toBeGreaterThan(-1);
    expect(flow).toBeGreaterThan(flowSection);
    expect(flow).toBeLessThan(html.indexOf('data-board-section="experiments"'));
    expect(html).not.toContain('id="needs-you-heading"');
  });
});
