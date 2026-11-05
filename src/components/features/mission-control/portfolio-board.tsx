import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, RefreshCw } from 'lucide-react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { createMissionSubmissionId } from '@/components/features/mission-control/mission-control-utils';
import type { IGrantee } from '@/types/grant';
import type { IPortfolioImpact, IPortfolioSnapshot } from '@/types/portfolio';

const time = (at: number | null): string => at === null ? 'No checkpoint' : new Date(at).toLocaleString();
const age = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const responseBody = async (response: Response): Promise<{ error?: string }> =>
  response.json().catch(() => ({ error: response.statusText || 'Request failed' }));

const readPortfolio = async (resolvedBefore: string | null): Promise<IPortfolioSnapshot> => {
  const url = resolvedBefore ? `/api/mission-control/portfolio?resolvedBefore=${encodeURIComponent(resolvedBefore)}`
    : '/api/mission-control/portfolio';
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error((await responseBody(response)).error || 'Portfolio unavailable');
  return response.json() as Promise<IPortfolioSnapshot>;
};

const readManagers = async (): Promise<IGrantee[]> => {
  const response = await fetch('/api/mission-control/portfolio-managers', { cache: 'no-store' });
  if (!response.ok) throw new Error((await responseBody(response)).error || 'Manager tabs unavailable');
  return (await response.json() as { grantees: IGrantee[] }).grantees;
};

interface IPortfolioBoardContentProps {
  snapshot: IPortfolioSnapshot;
  priorityFilter: 'all' | 'top';
  onPriorityFilter: (value: 'all' | 'top') => void;
  showResolved?: boolean;
  onShowResolved?: (value: boolean) => void;
  olderResolved?: boolean;
  onOlderResolved?: () => void;
  onLatestResolved?: () => void;
  decisions: Record<string, string>;
  onDecision: (id: string, value: string) => void;
  pendingId: string | null;
  onAcknowledge: (impact: IPortfolioImpact) => void;
  onAssign: (impact: IPortfolioImpact) => void;
  milestoneEvidence?: Record<string, string>;
  milestoneStage?: Record<string, 'merged' | 'deployed' | 'verified'>;
  onMilestoneEvidence?: (id: string, value: string) => void;
  onMilestoneStage?: (id: string, value: 'merged' | 'deployed' | 'verified') => void;
  onConfirmMilestone?: (impact: IPortfolioImpact) => void;
}

export const PortfolioBoardContent = ({ snapshot, priorityFilter, onPriorityFilter, showResolved = false, onShowResolved,
  olderResolved = false, onOlderResolved, onLatestResolved, decisions, onDecision,
  pendingId, onAcknowledge, onAssign, milestoneEvidence = {}, milestoneStage = {}, onMilestoneEvidence, onMilestoneStage,
  onConfirmMilestone }: IPortfolioBoardContentProps) => {
  const now = snapshot.generatedAt;
  const impacts = snapshot.dependencies.flatMap((dependency) => dependency.impacts)
    .filter((impact) => showResolved || impact.state !== 'resolved');
  const actionable = impacts.filter((impact) => impact.state !== 'resolved');
  const topPriority = (actionable.length ? actionable : impacts).reduce((highest, impact) => Math.max(highest, impact.priority), 0);
  const visible = snapshot.dependencies.map((dependency) => {
    const filtered = dependency.impacts.filter((impact) => (showResolved || impact.state !== 'resolved')
      && (priorityFilter === 'all' || impact.priority === topPriority));
    return { ...dependency, impacts: filtered,
      firstBlockedAt: filtered.reduce((earliest, impact) => Math.min(earliest, impact.firstBlockedAt), Infinity) };
  }).filter((dependency) => dependency.impacts.length).sort((a, b) =>
    Math.max(...b.impacts.map((impact) => impact.priority)) - Math.max(...a.impacts.map((impact) => impact.priority))
    || a.firstBlockedAt - b.firstBlockedAt);
  const gaps = snapshot.coverage.filter((entry) => entry.access !== 'available');

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="shadow-none"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Managed coverage</p><p className="mt-1 text-xl font-semibold">{snapshot.coverage.length - gaps.length} / {snapshot.coverage.length}</p><p className="text-xs text-muted-foreground">Explicitly selected workspaces</p></CardContent></Card>
        <Card className="shadow-none"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Open dependencies</p><p className="mt-1 text-xl font-semibold">{snapshot.dependencies.filter((dependency) => dependency.impacts.some((impact) => impact.state !== 'resolved')).length}</p><p className="text-xs text-muted-foreground">Shared resources counted once</p></CardContent></Card>
        <Card className="shadow-none"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Releases affected</p><p className="mt-1 text-xl font-semibold">{new Set(impacts.filter((impact) => impact.state !== 'resolved').map((impact) => `${impact.workspaceId}/${impact.runId}`)).size}</p><p className="text-xs text-muted-foreground">Resolution does not verify deployment</p></CardContent></Card>
      </div>

      {gaps.length > 0 && (
        <div className="rounded-lg border border-ui-amber/30 bg-ui-amber/5 p-4" role="status">
          <p className="flex items-center gap-2 text-sm font-semibold text-ui-amber"><AlertTriangle className="h-4 w-4" /> Coverage incomplete</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {gaps.map((gap) => <span key={gap.workspaceId} className="rounded bg-background px-2 py-1">{gap.name}: {gap.access.replaceAll('-', ' ')}</span>)}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Unavailable workspace blockers are excluded from counts and cards. Restore a missing coordinator in its own workspace or update the selected scope.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-sm font-semibold">Release blockers</h2><p className="text-xs text-muted-foreground">Work from the next clearing action, then check proof.</p></div>
        <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs">Priority
          <select aria-label="Priority filter" className="rounded border bg-background px-2 py-1.5" value={priorityFilter} onChange={(event) => onPriorityFilter(event.target.value as 'all' | 'top')}>
            <option value="all">All</option><option value="top">Highest priority</option>
          </select>
        </label><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showResolved} onChange={(event) => onShowResolved?.(event.target.checked)} /> Show resolved</label></div>
      </div>

      {showResolved && (olderResolved || snapshot.resolvedNextCursor) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Resolved history is shown 100 at a time; older records remain available.</span>
          {olderResolved && <Button size="sm" variant="outline" onClick={onLatestResolved}>Latest resolved</Button>}
          {snapshot.resolvedNextCursor && <Button size="sm" variant="outline" onClick={onOlderResolved}>Older resolved</Button>}
        </div>
      )}

      {snapshot.selection?.workspaceIds.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Select the workspaces this manager is responsible for.</p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {gaps.length ? 'No blocker data is available in the covered workspaces. Coverage remains incomplete.' : 'No open blockers in the selected workspaces. Show resolved to verify closure.'}
        </p>
      ) : visible.map((dependency) => (
        <section key={dependency.resourceKey} className="space-y-3 rounded-xl border bg-card/50 p-3 sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><p className="break-all text-xs font-medium uppercase tracking-wide text-muted-foreground">{dependency.kind} · {dependency.resourceKey}</p>
              <h3 className="mt-1 text-sm font-semibold">Shared dependency · {dependency.impacts.length} affected release{dependency.impacts.length === 1 ? '' : 's'}</h3></div>
            <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /> First blocked {age(dependency.firstBlockedAt, now)} ago</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {dependency.impacts.sort((a, b) => b.priority - a.priority).map((impact) => {
              const checkpointMissed = impact.checkpointAt !== null && impact.checkpointAt < now && impact.state !== 'resolved';
              const proof = impact.proof ? JSON.parse(impact.proof) as
                | { source: 'watch'; notice: string; sha: string | null }
                | { source: 'coordinator-capacity'; observedAt: number; evidence: {
                  host: string; measuredReason: string; limit: string | null; use: string | null;
                  holder: string | null; clearingCondition: string; reference: string } } : null;
              const rank = { merged: 1, deployed: 2, verified: 3 };
              const milestone = snapshot.milestones.filter((entry) => entry.workspaceId === impact.workspaceId && entry.runId === impact.runId)
                .sort((a, b) => b.observedAt - a.observedAt || rank[b.stage] - rank[a.stage])[0];
              return <Card key={impact.id} className="min-w-0 shadow-none"><CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs text-muted-foreground">{impact.workspaceId} · {impact.runId}</p><h4 className="break-words text-sm font-semibold">{impact.outcome}</h4></div>
                  <span className="rounded bg-ui-blue/10 px-2 py-1 text-xs font-medium text-ui-blue">Priority {impact.priority}</span></div>
                <div className="flex flex-wrap gap-2 text-xs"><span className="rounded bg-muted px-2 py-1">{impact.state.replaceAll('-', ' ')}</span><span className="rounded bg-muted px-2 py-1">Reported stage: {impact.stage}</span>
                  <span className="rounded bg-muted px-2 py-1">Last human-confirmed milestone: {milestone?.stage ?? 'none'}</span></div>
                {milestone && <p className="text-xs text-muted-foreground">Confirmed by {milestone.actor} · {time(milestone.observedAt)} · {milestone.evidence}</p>}
                <div className="grid gap-2 text-xs sm:grid-cols-2"><p><span className="text-muted-foreground">Owner</span><br />{impact.owner}</p><p><span className="text-muted-foreground">Decision owner</span><br />{impact.decisionOwner}</p>
                  <p><span className="text-muted-foreground">First blocked</span><br />{time(impact.firstBlockedAt)}</p><p><span className="text-muted-foreground">Freshness / checkpoint</span><br />Updated {age(impact.updatedAt, now)} ago · {time(impact.checkpointAt)}{checkpointMissed && ' · missed'}</p></div>
                <p className="text-xs"><span className="text-muted-foreground">Cause and reported evidence</span><br />{impact.cause} · {impact.evidence}</p>
                {impact.capacity && <div className="grid gap-1 rounded bg-muted/50 p-2 text-xs sm:grid-cols-2"><span>Host: {impact.capacity.host}</span><span>Measured: {impact.capacity.measuredReason}</span><span>Limit / use: {impact.capacity.limit ?? 'unknown'} / {impact.capacity.use ?? 'unknown'}</span><span>Holder: {impact.capacity.holder ?? 'unknown'}</span><span className="sm:col-span-2">Clears when: {impact.capacity.clearingCondition ?? 'unspecified'}</span></div>}
                <p className="rounded border-l-2 border-ui-blue pl-3 text-xs"><span className="font-semibold">Next unblock action</span><br />{impact.nextAction}</p>
                {proof && <p className="flex items-start gap-1 text-xs text-ui-teal"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>Dependency proof: {proof.source === 'watch'
                    ? `${proof.notice}${proof.sha ? ` · ${proof.sha.slice(0, 10)}` : ''}`
                    : `Coordinator capacity evidence on ${proof.evidence.host} at ${time(proof.observedAt)}: ${proof.evidence.measuredReason} · limit ${proof.evidence.limit ?? 'unknown'} / use ${proof.evidence.use ?? 'unknown'} · holder ${proof.evidence.holder ?? 'unknown'} · clears when ${proof.evidence.clearingCondition} · reference ${proof.evidence.reference}`}</span></p>}
                {impact.noteId && <p className="text-xs text-muted-foreground">Decision note {impact.noteId}: {impact.noteState ?? 'unknown'} · composer delivery {impact.noteDeliveredAt ? time(impact.noteDeliveredAt) : 'pending'} · application {impact.state === 'waiting' || impact.state === 'resolved' ? 'reported' : 'pending'}</p>}
                {snapshot.actions.filter((action) => action.impactId === impact.id).slice(0, 3).map((action) =>
                  <p key={action.id} className="rounded bg-muted/50 p-2 text-xs"><span className="font-medium">Decision by {action.actor}</span> · {time(action.createdAt)}<br />{action.decision}<br /><span className="text-muted-foreground">{action.state} · {action.noteId ?? 'note pending'}</span></p>)}
                {impact.state !== 'resolved' && <div className="space-y-2 border-t pt-3">
                  <div className="flex flex-wrap gap-2">{impact.state === 'received' && <Button size="sm" variant="outline" onClick={() => onAcknowledge(impact)} disabled={pendingId === impact.id}>Acknowledge</Button>}
                    <span className="text-xs text-muted-foreground">Acknowledgement records receipt; the blocker stays open.</span></div>
                  <textarea aria-label={`Decision for ${impact.outcome}`} className="min-h-20 w-full rounded border bg-background p-2 text-sm" maxLength={4000} placeholder="Clearing decision or instruction for the owning orchestrator" value={decisions[impact.id] ?? ''} onChange={(event) => onDecision(impact.id, event.target.value)} />
                  <Button size="sm" onClick={() => onAssign(impact)} disabled={!decisions[impact.id]?.trim() || pendingId === impact.id}>Route action to orchestrator <ArrowUpRight className="ml-1 h-3.5 w-3.5" /></Button>
                </div>}
                {onConfirmMilestone && <details className="border-t pt-2 text-xs"><summary className="cursor-pointer">Confirm release milestone with evidence</summary>
                  <div className="mt-2 flex flex-wrap gap-2"><select aria-label={`Milestone for ${impact.outcome}`} className="rounded border bg-background px-2 py-1" value={milestoneStage[impact.id] ?? 'deployed'}
                    onChange={(event) => onMilestoneStage?.(impact.id, event.target.value as 'merged' | 'deployed' | 'verified')}>
                    <option value="merged">Merged</option><option value="deployed">Deployed</option><option value="verified">Verified</option></select>
                    <input aria-label={`Milestone evidence for ${impact.outcome}`} className="min-w-0 flex-1 rounded border bg-background px-2 py-1" maxLength={2000}
                      placeholder="Deployment record or verification evidence" value={milestoneEvidence[impact.id] ?? ''}
                      onChange={(event) => onMilestoneEvidence?.(impact.id, event.target.value)} />
                    <Button size="sm" variant="outline" disabled={(milestoneEvidence[impact.id]?.trim().length ?? 0) < 10 || pendingId === impact.id}
                      onClick={() => onConfirmMilestone(impact)}>Confirm milestone</Button></div>
                </details>}
              </CardContent></Card>;
            })}
          </div>
        </section>
      ))}
    </div>
  );
};

const PortfolioBoard = () => {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const { data: grantees, error: managersError, mutate: refreshManagers } = useSWR('/api/mission-control/portfolio-managers', readManagers);
  const [snapshot, setSnapshot] = useState<IPortfolioSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managerKey, setManagerKey] = useState('');
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'top'>('all');
  const [showResolved, setShowResolved] = useState(false);
  const [resolvedBefore, setResolvedBefore] = useState<string | null>(null);
  const currentCursor = useRef(resolvedBefore);
  const requestSequence = useRef(0);
  const changeResolvedPage = (next: string | null) => { currentCursor.current = next; setResolvedBefore(next); };
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [actionIds, setActionIds] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [milestoneEvidence, setMilestoneEvidence] = useState<Record<string, string>>({});
  const [milestoneStage, setMilestoneStage] = useState<Record<string, 'merged' | 'deployed' | 'verified'>>({});
  const [milestoneRequests, setMilestoneRequests] = useState<Record<string,
    { eventId: string; observedAt: number; stage: 'merged' | 'deployed' | 'verified'; evidence: string }>>({});

  const refresh = useCallback(async () => {
    const cursor = resolvedBefore;
    const sequence = ++requestSequence.current;
    try {
      const next = await readPortfolio(cursor);
      if (sequence !== requestSequence.current || cursor !== currentCursor.current) return;
      setSnapshot(next);
      setError(null);
    } catch (failure) {
      if (sequence !== requestSequence.current || cursor !== currentCursor.current) return;
      setSnapshot(null);
      setError(failure instanceof Error ? failure.message : 'Portfolio unavailable');
    } finally { if (sequence === requestSequence.current && cursor === currentCursor.current) setLoading(false); }
  }, [resolvedBefore]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!snapshot || editing) return;
    const selection = snapshot.selection;
    setManagerKey(selection ? `${selection.managerWorkspaceId}/${selection.managerTabId}` : '');
    setWorkspaceIds(selection?.workspaceIds ?? []);
  }, [snapshot, editing]);

  const managers = useMemo(() => grantees?.filter((grantee) => grantee.identity === 'launch'
    && workspaces.some((workspace) => workspace.id === grantee.workspaceId
      && workspace.orchestration?.enabled && workspace.orchestration.orchestratorTabId === grantee.tabId)) ?? [], [grantees, workspaces]);

  const mutate = async (body: unknown, method: 'PUT' | 'POST') => {
    const response = await fetch('/api/mission-control/portfolio', { method,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await responseBody(response)).error || 'Portfolio action failed');
    await refresh();
  };

  const saveSelection = async () => {
    const slash = managerKey.indexOf('/');
    if (slash < 0) return;
    setPendingId('scope'); setError(null);
    try {
      await mutate({ managerWorkspaceId: managerKey.slice(0, slash), managerTabId: managerKey.slice(slash + 1), workspaceIds }, 'PUT');
      changeResolvedPage(null);
      setEditing(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Scope could not be saved'); }
    finally { setPendingId(null); }
  };

  const submit = async (impact: IPortfolioImpact, kind: 'acknowledge' | 'assign') => {
    setPendingId(impact.id); setError(null);
    try {
      const actionId = actionIds[impact.id] ?? createMissionSubmissionId();
      if (kind === 'assign' && !actionIds[impact.id]) setActionIds((current) => ({ ...current, [impact.id]: actionId }));
      await mutate(kind === 'assign'
        ? { type: kind, workspaceId: impact.workspaceId, impactId: impact.id, expectedRevision: impact.revision,
          actionId, decision: decisions[impact.id] }
        : { type: kind, workspaceId: impact.workspaceId, impactId: impact.id, expectedRevision: impact.revision }, 'POST');
      if (kind === 'assign') {
        setDecisions((current) => ({ ...current, [impact.id]: '' }));
        setActionIds((current) => { const next = { ...current }; delete next[impact.id]; return next; });
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed'); }
    finally { setPendingId(null); }
  };

  const confirmMilestone = async (impact: IPortfolioImpact) => {
    const stage = milestoneStage[impact.id] ?? 'deployed';
    const evidence = milestoneEvidence[impact.id]?.trim() ?? '';
    const previous = milestoneRequests[impact.id];
    const request = previous?.stage === stage && previous.evidence === evidence
      ? previous : { eventId: createMissionSubmissionId(), observedAt: Date.now(), stage, evidence };
    setMilestoneRequests((current) => ({ ...current, [impact.id]: request }));
    setPendingId(impact.id); setError(null);
    try {
      await mutate({ type: 'milestone', ...request, workspaceId: impact.workspaceId, runId: impact.runId }, 'POST');
      setMilestoneEvidence((current) => ({ ...current, [impact.id]: '' }));
      setMilestoneRequests((current) => { const next = { ...current }; delete next[impact.id]; return next; });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Milestone could not be confirmed'); }
    finally { setPendingId(null); }
  };

  return <div className="mx-auto w-full max-w-[1440px] space-y-5 px-3 py-5 sm:px-5 lg:px-8">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">Portfolio board</h1><p className="text-sm text-muted-foreground">A release view for the selected Scrum Master. Saved scope gives its manager tab read access to selected workspaces.</p></div>
      <Button size="sm" variant="outline" onClick={() => { void refresh(); void refreshManagers(); }}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh</Button></div>
    <Card className="shadow-none"><CardContent className="space-y-3 p-4"><div><h2 className="text-sm font-semibold">Managed scope</h2><p className="text-xs text-muted-foreground">Choose the current manager tab and workspaces it supervises. Save scope to authorize its reads. Cross-workspace work requests go through each workspace orchestrator.</p></div>
      <div className="grid gap-3 sm:grid-cols-[minmax(200px,1fr)_2fr_auto]"><label className="space-y-1 text-xs">Manager tab
        <select aria-label="Manager tab" className="w-full rounded border bg-background px-2 py-2" value={managerKey} onChange={(event) => { setManagerKey(event.target.value); setEditing(true); }}><option value="">Choose a coordinator</option>{managers.map((manager) => <option key={`${manager.workspaceId}/${manager.tabId}`} value={`${manager.workspaceId}/${manager.tabId}`}>{manager.name || manager.tabId} · {manager.workspaceName}</option>)}</select></label>
        <div className="space-y-1 text-xs"><p>Managed workspaces</p><div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">{workspaces.map((workspace) => <label key={workspace.id} className="flex items-center gap-1 rounded border px-2 py-1"><input type="checkbox" checked={workspaceIds.includes(workspace.id)} onChange={(event) => { setEditing(true); setWorkspaceIds((current) => event.target.checked ? [...current, workspace.id] : current.filter((id) => id !== workspace.id)); }} />{workspace.name}</label>)}</div></div>
        <Button size="sm" className="self-end" disabled={!managerKey || pendingId === 'scope'} onClick={() => void saveSelection()}>Save scope</Button></div>
      {!grantees && !managersError && <p className="text-xs text-muted-foreground">Loading eligible manager tabs…</p>}
      {managersError && <p role="alert" className="text-xs text-ui-red">Manager tabs unavailable. Refresh to retry.</p>}
    </CardContent></Card>
    {error && <p role="alert" className="rounded border border-ui-red/30 bg-ui-red/5 p-3 text-sm text-ui-red">{error}</p>}
    {loading ? <p className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">Loading portfolio coverage and blockers…</p>
      : !snapshot ? <p className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">Portfolio unavailable. Retry after the storage or connection error is fixed.</p>
        : snapshot.selection === null ? <p className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">Choose a manager and managed workspaces to begin. No portfolio is assumed.</p>
          : <><PortfolioBoardContent snapshot={snapshot} priorityFilter={priorityFilter} onPriorityFilter={setPriorityFilter}
            showResolved={showResolved} onShowResolved={(value) => { setShowResolved(value); if (!value) changeResolvedPage(null); }}
            olderResolved={resolvedBefore !== null} onOlderResolved={() => changeResolvedPage(snapshot.resolvedNextCursor ?? null)}
            onLatestResolved={() => changeResolvedPage(null)}
            decisions={decisions} onDecision={(id, value) => { setDecisions((current) => ({ ...current, [id]: value })); setActionIds((current) => { const next = { ...current }; delete next[id]; return next; }); }}
            pendingId={pendingId} onAcknowledge={(impact) => void submit(impact, 'acknowledge')} onAssign={(impact) => void submit(impact, 'assign')}
            milestoneEvidence={milestoneEvidence} milestoneStage={milestoneStage} onMilestoneEvidence={(id, value) => setMilestoneEvidence((current) => ({ ...current, [id]: value }))}
            onMilestoneStage={(id, value) => setMilestoneStage((current) => ({ ...current, [id]: value }))}
            onConfirmMilestone={(impact) => void confirmMilestone(impact)} /></>}
  </div>;
};

export default PortfolioBoard;
