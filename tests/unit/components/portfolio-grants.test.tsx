import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import grants from '../../../messages/en/grants.json';
import PortfolioGrantsPanel, { type IPortfolioGrantsPanelProps } from '@/components/features/workspace/portfolio-grants-panel';
import { GrantBadgeView } from '@/components/features/workspace/grant-badge';
import type { IGrant, IGrantee } from '@/types/grant';

// Story 28: every state of the grant dialog and the badge, rendered statically.

const NOW = Date.parse('2026-09-26T14:00:00Z');
const grantees: IGrantee[] = [
  { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-orch', name: 'orchestrator', panelType: 'claude-code', identity: 'launch' },
  { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-old', name: 'old worker', panelType: 'claude-code', identity: 'hook' },
  { workspaceId: 'ws-2', workspaceName: 'Billing', tabId: 'tab-x', name: 'shell', panelType: 'terminal', identity: 'none' },
];
const active: IGrant = {
  id: 'g-live1', capability: 'drive', grantee: { workspaceId: 'ws-1', tabId: 'tab-orch' }, workspaces: ['ws-2', 'ws-3'], reason: 'r',
  createdAt: NOW - 1, createdBy: 'human', expiresAt: NOW + 3_600_000, revokedAt: null, revokedBy: null, revokeReason: null, expiryNotedAt: null,
};
const names = { 'ws-1': 'Portfolio', 'ws-2': 'Billing', 'ws-3': 'Acme-ledger' };

const panel = (over: Partial<IPortfolioGrantsPanelProps> = {}) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
    <PortfolioGrantsPanel
      available grantees={grantees} granteesError={null} unreadableWorkspaceIds={[]} grants={[]} workspaceNames={names} now={NOW}
      granteeKey={null} onGranteeChange={vi.fn()} workspaces={[]} onWorkspacesChange={vi.fn()}
      expiresInHours={24} onExpiryChange={vi.fn()} reason="" onReasonChange={vi.fn()} password="" onPasswordChange={vi.fn()}
      error={null} submitting={false} revokingIds={[]} onSubmit={vi.fn()} onRevoke={vi.fn()}
      {...over}
    />
  </NextIntlClientProvider>,
);

describe('portfolio grants dialog content', () => {
  it('lists unverified tabs disabled with the recreate hint; a launch tab is selectable', () => {
    const html = panel();
    const row = (key: string) => html.slice(html.indexOf(`data-grantee="${key}"`), html.indexOf('</label>', html.indexOf(`data-grantee="${key}"`)));
    // The radio itself is disabled (aria-disabled on role=radio), not only its row.
    expect(row('ws-1/tab-orch')).not.toMatch(/role="radio"[^>]*aria-disabled="true"/);
    expect(row('ws-1/tab-orch')).not.toContain('Recreate the tab to grant');
    for (const key of ['ws-1/tab-old', 'ws-2/tab-x']) {
      expect(row(key)).toMatch(/role="radio"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*role="radio"/);
      expect(row(key)).toContain('Recreate the tab to grant');
    }
  });

  it('offers only other workspaces than the grantee\'s own', () => {
    const html = panel({ granteeKey: 'ws-1/tab-orch' });
    expect(html).toContain('data-target="ws-2"');
    expect(html).toContain('data-target="ws-3"');
    expect(html).not.toContain('data-target="ws-1"');
  });

  it('lists an active grant with its workspaces, expiry and a Revoke button; revoked and expired ones are gone', () => {
    const html = panel({ grants: [active, { ...active, id: 'g-rev1', revokedAt: NOW - 1 }, { ...active, id: 'g-exp1', expiresAt: NOW }] });
    expect(html).toContain('data-grant="g-live1"');
    expect(html).toContain('reads Billing, Acme-ledger');
    expect(html).toContain('Revoke');
    expect(html).not.toContain('g-rev1');
    expect(html).not.toContain('g-exp1');
    expect(panel()).toContain('No active grants');
  });

  it('shows the served refusal text it is given, and the create button stays disabled without a password', () => {
    const html = panel({ error: 'Wrong password: the purplemux password is wrong or missing' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Wrong password: the purplemux password is wrong or missing');
    expect(panel({ granteeKey: 'ws-1/tab-orch', workspaces: ['ws-2'], reason: 'r' })).toMatch(/<button[^>]* disabled=""[^>]*>(<[^>]*>)*Create grant/);
  });

  it('enables Create for a launch grantee with workspaces, a reason and a password; never for a hook grantee', () => {
    const ready = { workspaces: ['ws-2'], reason: 'portfolio run', password: 'pw' };
    expect(panel({ granteeKey: 'ws-1/tab-orch', ...ready })).not.toMatch(/<button[^>]* disabled=""[^>]*>(<[^>]*>)*Create grant/);
    expect(panel({ granteeKey: 'ws-1/tab-old', ...ready })).toMatch(/<button[^>]* disabled=""[^>]*>(<[^>]*>)*Create grant/);
  });

  it('a grantee-list read failure is shown, and the list is unknown (—), never "no tabs"', () => {
    const html = panel({ grantees: [], granteesError: 'workspaces.json is malformed' });
    expect(html).toContain('The tab list could not be read: workspaces.json is malformed');
    expect(html).toContain('data-unavailable="grantees"');
    expect(html).not.toContain('No tabs to grant');
  });

  it('unreadable workspaces are named, and an empty list then does not claim "no tabs"', () => {
    const html = panel({ grantees: [], unreadableWorkspaceIds: ['ws-3'] });
    expect(html).toContain('Tabs of Acme-ledger could not be read');
    expect(html).not.toContain('No tabs to grant');
  });

  it('only the grant being revoked shows as busy', () => {
    const html = panel({ grants: [active, { ...active, id: 'g-live2' }], revokingIds: ['g-live1'] });
    const block = (id: string) => html.slice(html.indexOf(`data-grant="${id}"`), html.indexOf('Revoke', html.indexOf(`data-grant="${id}"`)));
    expect(block('g-live1')).toMatch(/<button[^>]* disabled=""/);
    expect(block('g-live2')).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('while loading or after a failed read, the lists are unknown (—), never "none"', () => {
    const html = panel({ available: false, grantees: [], error: 'Could not load the grants — Your session has expired — log in again' });
    expect(html).toContain('data-unavailable="grantees"');
    expect(html).toContain('data-unavailable="grants"');
    expect(html).not.toContain('No tabs to grant');
    expect(html).not.toContain('No active grants');
    expect(html).toContain('Your session has expired');
  });

  it('says so when there are no tabs to grant', () => {
    expect(panel({ grantees: [] })).toContain('No tabs to grant');
  });
});

describe('grant badge', () => {
  it('shows "reads N" with the workspaces and the expiry in its label', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
        <GrantBadgeView badge={{ count: 2, workspaces: ['ws-2', 'ws-3'], expiresAt: NOW + 3_600_000 }} workspaceNames={names} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('reads 2 workspaces');
    expect(html).toContain('data-grant-badge="2"');
    expect(html).toMatch(/aria-label="Reads Billing, Acme-ledger until [^"]+"/);
    expect(html).not.toContain('data-stale');
  });

  it('keeps showing after a failed refresh, marked not refreshed with the reason; one workspace is singular', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
        <GrantBadgeView badge={{ count: 1, workspaces: ['ws-2'], expiresAt: NOW + 3_600_000 }} workspaceNames={names} staleReason="Authentication required" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('reads 1 workspace<');
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('not refreshed: Authentication required');
  });
});
