import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationErrorBoundary, CoordinationPanelView, deployBy, deployRecipients, deployWhen, formatAge, formatStamp, heldReasonLabel,
  type ICoordinationActions,
} from '@/components/features/mission-control/coordination-panel';
import type { ICoordinationSnapshot, IDeployRow } from '@/types/coordination';

// Story 20: each section's empty, populated and error states; the AC warnings.

const AT = Date.parse('2026-09-26T15:00:00Z');
const empty = (): ICoordinationSnapshot => ({
  at: AT,
  leases: { ok: true, items: [] }, notes: { ok: true, items: [] }, watches: { ok: true, items: [] },
  grants: { ok: true, items: [] }, inboxHeld: { ok: true, items: [] }, orchestrators: { ok: true, items: [] },
  host: { available: true, disks: [{ path: '/', usedPct: 40, freeBytes: 500 * 1024 ** 3, inodesUsedPct: 10 }], tmpInodesUsedPct: 20, loadAverage: [1, 2, 3], memAvailableBytes: 8 * 1024 ** 3 },
  signals: { state: 'not-configured' },
});
const render = (snapshot: ICoordinationSnapshot | null, error: string | null = null, loading = false) =>
  renderToStaticMarkup(<CoordinationPanelView snapshot={snapshot} error={error} loading={loading} />);
const sectionHtml = (html: string, title: string) => html.slice(html.indexOf(`data-section="${title}"`), html.indexOf('</div>', html.indexOf(`data-section="${title}"`)));

describe('coordination panel', () => {
  it.each(['Leases', 'Open notes', 'Watches', 'Grants', 'Held deliveries', 'Orchestrator coverage'])('%s: empty state', (title) => {
    expect(sectionHtml(render(empty()), title)).toContain('data-state="empty"');
  });

  it.each([
    ['Leases', 'leases'], ['Open notes', 'notes'], ['Watches', 'watches'], ['Grants', 'grants'], ['Held deliveries', 'inboxHeld'],
    ['Orchestrator coverage', 'orchestrators'],
  ] as const)('%s: error state shows the served error', (title, key) => {
    const snap = { ...empty(), [key]: { ok: false, error: `${key} store unreadable` } } as ICoordinationSnapshot;
    const html = sectionHtml(render(snap), title);
    expect(html).toContain('data-state="error"');
    expect(html).toContain(`${key} store unreadable`);
  });

  it('a lease whose holder tab closed shows "closed" in the warning style (not hidden); agent gone too', () => {
    const snap = empty();
    const lease = (name: string, holderState: string) => ({
      name, kind: 'merge', resource: 'x/y', holder: { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-a', tabName: 'worker', verified: true, admin: false },
      epic: null, note: null, acquiredAt: '', renewedAt: '', expiresAt: null, ttlSeconds: null, survivesTab: false,
      ageSeconds: 90, expiresInSeconds: null, holderState,
    });
    snap.leases = { ok: true, items: [lease('merge:x/y', 'closed'), lease('merge:x/z', 'live'), lease('merge:x/q', 'something-new')] } as ICoordinationSnapshot['leases'];
    const html = render(snap);
    expect(html).toMatch(/data-lease="merge:x\/y" data-holder-state="closed".*?<span class="text-ui-amber">closed<\/span>/);
    expect(html).toMatch(/data-lease="merge:x\/z".*?<span class="">live<\/span>/);
    // An unmapped state reads a neutral word, never the raw token.
    expect(html).not.toContain('>something-new<');
    expect(html).toMatch(/data-lease="merge:x\/q".*?>other</);
  });

  it('a 99 % disk is in the warning state; 40 % is not', () => {
    const snap = empty();
    expect(render(snap)).not.toContain('data-warn="true"');
    if (snap.host.available) snap.host.disks[0].usedPct = 99;
    expect(render(snap)).toMatch(/data-disk="\/" data-warn="true".*?<span class="text-ui-amber">disk 99%/);
  });

  it('shows reasoned missing and uncertain orchestrator coverage', () => {
    const snap = empty();
    snap.orchestrators = { ok: true, items: [
      {
        workspaceId: 'ws-missing', workspaceName: 'Payments', state: 'missing', workState: 'remaining',
        orchestratorState: 'missing', designatedTabId: null, evidence: ['active epic lease: epic:payments'],
        reason: 'Work remains but no orchestrator is designated.', observedAt: AT,
      },
      {
        workspaceId: 'ws-unknown', workspaceName: 'Acme-ledger', state: 'uncertain', workState: 'remaining',
        orchestratorState: 'unknown', designatedTabId: 'tab-owner', evidence: ['latest standup is awaiting-human'],
        reason: 'The designated orchestrator liveness is unknown.', observedAt: AT,
      },
    ] };
    const html = render(snap);
    expect(html).toContain('data-orchestrator-coverage="ws-missing"');
    expect(html).toContain('data-state="missing"');
    expect(html).toContain('active epic lease: epic:payments');
    expect(html).toContain('data-orchestrator-coverage="ws-unknown"');
    expect(html).toContain('The designated orchestrator liveness is unknown.');
  });

  it('host signals: not configured, validation error, values with stamp, stale', () => {
    expect(render(empty())).toContain('Host signals: not configured');
    const err = { ...empty(), signals: { state: 'error', error: 'invalid: tmpInodesPct — Required', ranAt: AT - 60_000, stale: false } } as ICoordinationSnapshot;
    expect(render(err)).toMatch(/data-signals="error".*invalid: tmpInodesPct — Required · run 1m ago/);
    const ok = { ...empty(), signals: { state: 'ok', ranAt: AT - 120_000, stale: false, value: { schemaVersion: 1, stampedAt: AT - 130_000, gateSlots: { total: 6, held: 2, holders: [] }, worktrees: [{ repo: 'acme-ledger-ui', count: 374, byEpic: {} }], tmpInodesPct: 41.2 } } } as ICoordinationSnapshot;
    expect(render(ok)).toMatch(/data-signals="ok".*gate slots 2\/6 held · 374 worktrees \(acme-ledger-ui 374\) · \/tmp inodes 41.2%/);
    const stale = { ...ok, signals: { ...ok.signals, stale: true } } as ICoordinationSnapshot;
    expect(render(stale)).toContain('(stale)');
  });

  it('host unavailable (not Linux) says why; no snapshot says loading or the error, never an empty panel', () => {
    expect(render({ ...empty(), host: { available: false, reason: 'host metrics are Linux only (this host is darwin)' } })).toContain('Linux only');
    expect(render(null, null, true)).toContain('Loading coordination');
    expect(render(null, 'Authentication required')).toContain('Coordination unavailable: Authentication required');
  });

  it('watches and held deliveries show labels, never the raw tokens', () => {
    const snap = empty();
    snap.watches = { ok: true, items: [{ id: 'w-1', workspaceId: 'ws-1', tabId: 'tab-a', kind: 'pr', target: 'Acme/x#1', until: 'head-moved', ageSeconds: 60, expiresInSeconds: 600, owner: 'closed' }] } as unknown as ICoordinationSnapshot['watches'];
    snap.inboxHeld = { ok: true, items: [{ id: 'i-1', kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', heldReason: 'stranded-in-composer' }] } as unknown as ICoordinationSnapshot['inboxHeld'];
    const html = render(snap);
    expect(html).toContain('(PR) until head moved');
    expect(html).not.toContain('head-moved');
    expect(html).toMatch(/owner closed/);
    expect(html).toContain('resume → ws-1/tab-a');
  });

  it('open notes: populated rows show subject, state label and age; undeliverable is a warning', () => {
    const snap = empty();
    snap.notes = { ok: true, items: [
      { id: 'n-1', subject: 'merge window', state: 'delivered', ageSeconds: 120 },
      { id: 'n-2', subject: 'rebase please', state: 'undeliverable', ageSeconds: 7200 },
      { id: 'n-3', subject: 'odd', state: 'mystery-state', ageSeconds: 5 },
    ] } as unknown as ICoordinationSnapshot['notes'];
    const html = sectionHtml(render(snap), 'Open notes');
    expect(html).toContain('data-state="populated"');
    expect(html).toMatch(/data-note="n-1".*?merge window.*?<span class="shrink-0 text-muted-foreground">delivered · 2m<\/span>/);
    expect(html).toMatch(/data-note="n-2".*?rebase please.*?<span class="shrink-0 text-ui-amber">undeliverable · 2h<\/span>/);
    expect(html).toMatch(/data-note="n-3".*?>other · 5s</);
    expect(html).not.toContain('mystery-state');
  });

  it('grants: populated rows show the grantee, the workspaces it reads and the expiry', () => {
    const snap = empty();
    snap.grants = { ok: true, items: [
      { id: 'g-1', grantee: { workspaceId: 'ws-orch', tabId: 'tab-o' }, workspaces: ['ws-a', 'ws-b'], expiresAt: AT + 3_600_000 },
    ] } as unknown as ICoordinationSnapshot['grants'];
    const html = sectionHtml(render(snap), 'Grants');
    expect(html).toContain('data-state="populated"');
    expect(html).toMatch(/data-grant="g-1".*?ws-orch\/tab-o reads ws-a, ws-b.*?until [^<]+</);
    expect(html).toContain(new Date(AT + 3_600_000).toLocaleString());
  });

  it('grants: an owner grant reads "owner session — reads every workspace", never "reads *" or "No active grants" (ADR-0029)', () => {
    const snap = empty();
    snap.grants = { ok: true, refused: [], items: [
      { id: 'g-own1', capability: 'owner', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaces: ['*'], expiresAt: AT + 3_600_000 },
    ] } as unknown as ICoordinationSnapshot['grants'];
    const html = sectionHtml(render(snap), 'Grants');
    expect(html).toContain('data-grant="g-own1" data-grant-capability="owner"');
    expect(html).toContain('ws-1/tab-o owner session — reads every workspace');
    expect(html).not.toContain('reads *');
    expect(html).not.toContain('No active grants');
  });

  it('grants: one refused file names itself with the served reason; the other file\'s grants still show; never "No active grants"', () => {
    const snap = empty();
    snap.grants = { ok: true, items: [
      { id: 'g-drv1', capability: 'drive', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], expiresAt: AT + 3_600_000 },
    ], refused: [{ capability: 'owner', file: 'owner-grants.json', error: '/h/.purplemux/owner-grants.json is malformed', code: 'grant-store-unreadable' }] } as unknown as ICoordinationSnapshot['grants'];
    let html = sectionHtml(render(snap), 'Grants');
    expect(html).toContain('data-state="partial"');
    expect(html).toContain('Owner sessions are not honoured: owner-grants.json cannot be read — /h/.purplemux/owner-grants.json is malformed');
    expect(html).toContain('data-grant="g-drv1"');

    snap.grants = { ok: true, items: [], refused: [{ capability: 'drive', file: 'grants.json', error: 'bad', code: 'grant-store-unreadable' }] };
    html = sectionHtml(render(snap), 'Grants');
    expect(html).toContain('Read grants are not honoured: grants.json cannot be read — bad');
    expect(html).not.toContain('No active grants');
    expect(html).not.toContain('data-state="empty"');
  });

  it('host signals: pending before the first run', () => {
    expect(render({ ...empty(), signals: { state: 'pending' } })).toContain('data-signals="pending"');
  });

  it('a stamp Date cannot represent renders "—" instead of throwing', () => {
    expect(formatStamp(1.79e18)).toBe('—');
    expect(formatStamp(AT)).toBe('2026-09-26T15:00:00.000Z');
    const ok = { ...empty(), signals: { state: 'ok', ranAt: AT, stale: false, value: { schemaVersion: 1, stampedAt: 1.79e18, gateSlots: { total: 1, held: 0, holders: [] }, worktrees: [], tmpInodesPct: 1 } } } as ICoordinationSnapshot;
    expect(render(ok)).toContain('stamped —)');
  });

  it('held reasons read as labels plus the served detail, never the bare token', () => {
    expect(heldReasonLabel('stranded-in-composer')).toBe('stranded in the composer');
    expect(heldReasonLabel('transport-uncertain:tmux gone')).toBe('delivery uncertain: tmux gone');
    expect(heldReasonLabel('composer-not-ready:busy (30 refusals)')).toBe('composer not ready: busy (30 refusals)');
    expect(heldReasonLabel('session-not-running (undelivered after 24 h)')).toBe('session not running (undelivered after 24 h)');
    expect(heldReasonLabel('brand-new-reason (8 refusals)')).toBe('other (8 refusals)');
    expect(heldReasonLabel('Weird Reason')).toBe('other: Weird Reason');
    expect(heldReasonLabel(null)).toBe('held');
    // The exact string inbox-store holds for a notice that expired with no refusal (story 20 r2 N1).
    expect(heldReasonLabel('never ready (undelivered after 24 h)')).toBe('target never ready (undelivered after 24 h)');
    // Story 12's preflight refusals (architect CONFIRM note).
    expect(heldReasonLabel('preflight-unregistered (30 refusals)')).toBe('owner not ready (30 refusals)');
    expect(heldReasonLabel('preflight-error:runtime stopped (30 refusals)')).toBe('owner check failed: runtime stopped (30 refusals)');
    const snap = empty();
    snap.inboxHeld = { ok: true, items: [{ id: 'i-1', kind: 'note', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', heldReason: 'target-not-agent' }] } as unknown as ICoordinationSnapshot['inboxHeld'];
    expect(render(snap)).toMatch(/data-held="i-1".*?target is not an agent tab/);
  });

  it('an unknown disk percentage reads "—" and never warns', () => {
    const snap = empty();
    if (snap.host.available) snap.host.disks[0].usedPct = null;
    const html = render(snap);
    expect(html).toContain('disk —');
    expect(html).not.toContain('data-warn="true"');
  });

  it('the error boundary turns a render failure into this panel\'s error, with Retry', () => {
    expect(CoordinationErrorBoundary.getDerivedStateFromError(new RangeError('Invalid time value'))).toEqual({ error: 'Invalid time value' });
    const boundary = new CoordinationErrorBoundary({ children: <p>child</p> });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>child</p>');
    boundary.state = { error: 'Invalid time value' };
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('data-state="render-error"');
    expect(html).toContain('Coordination panel failed to render: Invalid time value');
    expect(html).toContain('Retry');
  });

  it('formats ages', () => {
    expect([formatAge(5), formatAge(90), formatAge(7200), formatAge(200_000), formatAge(null)]).toEqual(['5s', '1m', '2h', '2d', '—']);
  });

  describe('deploys (ADR-0029 §9)', () => {
    const row = (overrides: Partial<IDeployRow> = {}): IDeployRow => ({
      id: 'd-aaaaaaaaaa', reason: 'release 1.4', createdAt: AT - 60_000, restartAt: AT + 240_000, phase: 'pending',
      by: { workspaceId: null, tabId: null, admin: true }, recipients: { total: 4, delivered: 2, queued: 1, held: 1, dropped: 0 }, ...overrides,
    });

    it('lists each announcement: reason, when, who, and how far its notices got', () => {
      const snap = { ...empty(), deploys: { ok: true, items: [row(), row({ id: 'd-bbbbbbbbbb', phase: 'past', restartAt: AT - 7_200_000,
        by: { workspaceId: 'ws-ops', tabId: 'tab-d', admin: false }, recipients: { total: 2, delivered: 2, queued: 0, held: 0, dropped: 0 } })] } } as ICoordinationSnapshot;
      const html = sectionHtml(render(snap), 'Deploys');
      expect(html).toContain('data-state="populated"');
      expect(html).toMatch(/data-deploy="d-aaaaaaaaaa" data-phase="pending".*?release 1\.4.*?restart in 4m.*?by admin · 2\/4 delivered · 1 queued · 1 held/);
      expect(html).toMatch(/data-deploy="d-bbbbbbbbbb" data-phase="past".*?restarted 2h ago.*?by ws-ops\/tab-d · 2\/2 delivered</);
    });

    it('empty, a store error, and a server older than the section each read as themselves', () => {
      expect(sectionHtml(render({ ...empty(), deploys: { ok: true, items: [] } }), 'Deploys')).toContain('No deploy announced in the last 24 h');
      const failed = sectionHtml(render({ ...empty(), deploys: { ok: false, error: 'deploy-announcements.json is malformed' } }), 'Deploys');
      expect(failed).toContain('data-state="error"');
      expect(failed).toContain('deploy-announcements.json is malformed');
      const older = sectionHtml(render(empty()), 'Deploys');
      expect(older).toContain('data-state="unsupported"');
      expect(older).not.toContain('No deploy');
    });

    it('formats the parts without raw tokens or a zero for an absent count', () => {
      expect(deployWhen({ phase: 'pending', restartAt: AT + 30_000 }, AT)).toBe('restart in 30s');
      expect(deployWhen({ phase: 'past', restartAt: AT - 90_000 }, AT)).toBe('restarted 1m ago');
      expect(deployWhen({ phase: 'later' as IDeployRow['phase'], restartAt: AT }, AT)).toBe(`restart at ${formatStamp(AT)}`);
      expect(deployBy({ workspaceId: 'ws-1', tabId: null, admin: false })).toBe('ws-1/—');
      expect(deployRecipients({ total: 0, delivered: 0, queued: 0, held: 0, dropped: 0 })).toBe('no recipients');
      expect(deployRecipients({ total: 2, delivered: 1, queued: 0, held: 0, dropped: 1 })).toBe('1/2 delivered · 1 dropped');
      expect(deployRecipients({ total: 4, delivered: 1, queued: 1, held: 0, dropped: 0 })).toBe('1/4 delivered · 1 queued · 2 no longer tracked');
      expect(deployRecipients({ total: 2, delivered: 0, queued: 0, held: 0, dropped: 0 })).toBe('0/2 delivered · 2 no longer tracked');
    });
  });

  describe('human actions (ADR-0029 §6-§8)', () => {
    const actions = (busy: string[] = []): ICoordinationActions => ({ onRetry: vi.fn(), onBreak: vi.fn(), onSendNote: vi.fn(), busy: new Set(busy) });
    const held = (id: string, heldReason: string) => ({ id, kind: 'watch', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', heldReason });
    const withRows = (): ICoordinationSnapshot => {
      const snap = empty();
      snap.inboxHeld = { ok: true, items: [
        held('i-budget', 'composer-not-empty (30 refusals)'), held('i-day', 'never ready (undelivered after 24 h)'),
        held('i-strand', 'stranded-in-composer'), held('i-uncertain', 'transport-uncertain:tmux paste failed'), held('i-agent', 'target-not-agent'),
      ] } as unknown as ICoordinationSnapshot['inboxHeld'];
      snap.leases = { ok: true, items: [{ name: 'merge:x/y', kind: 'merge', resource: 'x/y', holder: { workspaceId: 'ws-1', workspaceName: 'P', tabId: 'tab-a', tabName: 'w', verified: true, admin: false },
        epic: null, note: null, acquiredAt: '', renewedAt: '', expiresAt: null, ttlSeconds: null, survivesTab: false, ageSeconds: 5, expiresInSeconds: null, holderState: 'live' }] } as ICoordinationSnapshot['leases'];
      return snap;
    };
    const heldRow = (html: string, id: string) => html.slice(html.indexOf(`data-held="${id}"`), html.indexOf('</li>', html.indexOf(`data-held="${id}"`)));

    it('offers Retry on a refusal-budget or 24 h hold, never on a stranded, transport-uncertain or not-agent hold', () => {
      const html = renderToStaticMarkup(<CoordinationPanelView snapshot={withRows()} error={null} loading={false} actions={actions()} />);
      for (const id of ['i-budget', 'i-day']) expect(heldRow(html, id)).toContain('data-action="retry"');
      for (const id of ['i-strand', 'i-uncertain', 'i-agent']) expect(heldRow(html, id)).not.toContain('data-action="retry"');
    });

    it('offers Break… on each lease and one "Send note as owner"; a retry in flight disables its button', () => {
      const html = renderToStaticMarkup(<CoordinationPanelView snapshot={withRows()} error={null} loading={false} actions={actions(['i-budget'])} />);
      expect(html).toMatch(/data-lease="merge:x\/y".*?data-action="break"[^>]*>.*?Break…/);
      expect(html.match(/data-action="send-note"/g)).toHaveLength(1);
      expect(heldRow(html, 'i-budget')).toMatch(/<button[^>]*disabled=""[^>]*data-action="retry"/);
      expect(heldRow(html, 'i-day')).not.toContain('disabled=""');
    });

    it('renders no action without the container (read-only view)', () => {
      const html = render(withRows());
      expect(html).not.toContain('data-action=');
    });
  });
});
