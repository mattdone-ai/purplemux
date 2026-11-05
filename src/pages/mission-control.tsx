import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { AlertCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import PortfolioBoard from '@/components/features/mission-control/portfolio-board';
import OwnerBoard from '@/components/features/mission-control/owner-board';
import { boardItemOf, boardViewOf } from '@/components/features/mission-control/board-model';
import type { TBoardView } from '@/components/features/mission-control/board-model';
import { getPageShellWithTitlebarLayout } from '@/components/layout/page-shell';
import MissionControlDashboard, {
  MissionControlDashboardSkeleton,
  MissionControlErrorState,
} from '@/components/features/mission-control/mission-control-dashboard';
import MissionControlNeedsYou from '@/components/features/mission-control/mission-control-needs-you';
import {
  adoptCurrentMissionItem,
  createMissionDraft,
  createMissionSubmissionId,
  editMissionDraft,
  isMissionDraftEmpty,
  missionDraftRequest,
  rebaseMissionDraft,
  reconcileMissionDraftWithItem,
} from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft, IMissionDraftPatch } from '@/components/features/mission-control/mission-control-utils';
import useBrowserTitle from '@/hooks/use-browser-title';
import useMissionControl, { normalizeMissionItem } from '@/hooks/use-mission-control';
import { useSelectWorkspace } from '@/hooks/use-sidebar-actions';
import type {
  IMissionAnswerResponse,
  IMissionAttentionItem,
  IMissionBootstrap,
  IMissionError,
} from '@/types/mission-control';

const parseError = async (response: Response): Promise<IMissionError> => {
  try {
    return await response.json() as IMissionError;
  } catch {
    return {
      error: response.statusText || `Request failed (${response.status})`,
      code: response.status === 409 ? 'conflict' : 'storage-unavailable',
    };
  }
};

const isAttentionItem = (value: IMissionError['current']): value is IMissionAttentionItem =>
  Boolean(value && 'kind' in value && 'options' in value);

const VIEWS: Array<{ view: TBoardView; label: string }> = [
  { view: 'board', label: 'Board' },
  { view: 'answers', label: 'Answers' },
  { view: 'portfolio', label: 'Portfolio' },
];

const MissionControlPage = () => {
  const router = useRouter();
  const view = boardViewOf(router.query);
  const focusItemId = boardItemOf(router.query);
  useBrowserTitle(view === 'portfolio' ? 'Portfolio board' : 'Mission Control');
  const [legacyOpen, setLegacyOpen] = useState(false);
  const selectWorkspace = useSelectWorkspace();
  const {
    snapshot,
    loading,
    refreshing,
    unsupported,
    error,
    refresh,
    applyAnswer,
    applyItem,
    applyBootstrap,
  } = useMissionControl();
  const [drafts, setDrafts] = useState<Record<string, IMissionDraft>>({});
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapId, setBootstrapId] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const item of snapshot.items) {
        if (item.state === 'open' && !next[item.id]) {
          next[item.id] = createMissionDraft(item);
        }
      }

      for (const [itemId, draft] of Object.entries(next)) {
        const currentItem = snapshot.items.find((item) => item.id === itemId);
        const reconciled = reconcileMissionDraftWithItem(draft, currentItem);
        if (!reconciled) {
          delete next[itemId];
          continue;
        }
        next[itemId] = reconciled;
      }
      return next;
    });
  }, [snapshot]);

  const handleDraftChange = useCallback((item: IMissionAttentionItem, patch: IMissionDraftPatch) => {
    setDrafts((current) => {
      const draft = current[item.id] ?? createMissionDraft(item);
      return { ...current, [item.id]: editMissionDraft(draft, patch) };
    });
  }, []);

  const handleAdoptCurrent = useCallback((itemId: string) => {
    setDrafts((current) => {
      const draft = current[itemId];
      if (!draft) return current;
      return { ...current, [itemId]: adoptCurrentMissionItem(draft) };
    });
  }, []);

  const handleSubmit = useCallback(async (item: IMissionAttentionItem) => {
    const existing = drafts[item.id];
    if (!existing || isMissionDraftEmpty(existing)) return;
    const submittingDraft = { ...existing, status: 'submitting' as const, error: null, hasAttempted: true };
    setDrafts((current) => ({ ...current, [item.id]: submittingDraft }));

    try {
      const response = await fetch(`/api/mission-control/items/${encodeURIComponent(item.id)}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(missionDraftRequest(submittingDraft)),
      });
      if (!response.ok) {
        const responseBody = await parseError(response);
        if (response.status === 409) {
          const latest = isAttentionItem(responseBody.current)
            ? normalizeMissionItem(responseBody.current)
            : snapshot?.items.find((candidate) => candidate.id === item.id) ?? submittingDraft.item;
          if (latest.state === 'open' && latest.revision > submittingDraft.expectedRevision) {
            // ADR-0037 §4: the server found the change incompatible; answer the current revision.
            applyItem(latest);
            setDrafts((current) => ({
              ...current,
              [item.id]: rebaseMissionDraft({ ...(current[item.id] ?? submittingDraft), hasAttempted: true }, latest, responseBody.changes),
            }));
            return;
          }
          setDrafts((current) => ({
            ...current,
            [item.id]: {
              ...(current[item.id] ?? submittingDraft),
              status: 'conflict',
              error: responseBody.error,
              currentItem: latest,
              hasAttempted: true,
            },
          }));
          return;
        }
        throw new Error(responseBody.error);
      }

      const responseBody = await response.json() as IMissionAnswerResponse;
      applyAnswer(responseBody);
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    } catch (submitError) {
      setDrafts((current) => ({
        ...current,
        [item.id]: {
          ...(current[item.id] ?? submittingDraft),
          status: current[item.id]?.currentItem ? 'conflict' : 'error',
          error: submitError instanceof Error ? submitError.message : 'The answer could not be saved',
          hasAttempted: true,
        },
      }));
    }
  }, [applyAnswer, applyItem, drafts, snapshot?.items]);

  const handleBootstrap = useCallback(async () => {
    const requestId = bootstrapId ?? createMissionSubmissionId();
    if (!bootstrapId) setBootstrapId(requestId);
    setBootstrapPending(true);
    setBootstrapError(null);
    try {
      const response = await fetch('/api/mission-control/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ bootstrapId: requestId, reconcile: true }),
      });
      if (!response.ok) {
        const responseBody = await parseError(response);
        throw new Error(responseBody.error);
      }
      const responseBody = await response.json() as IMissionBootstrap;
      applyBootstrap(responseBody);
      setBootstrapId(null);
      void refresh();
    } catch (bootstrapRequestError) {
      setBootstrapError(bootstrapRequestError instanceof Error
        ? bootstrapRequestError.message
        : 'Workspace discovery could not start');
    } finally {
      setBootstrapPending(false);
    }
  }, [applyBootstrap, bootstrapId, refresh]);

  let content;
  if (!legacyOpen && view === 'board') {
    content = (
      <div className="mx-auto w-full max-w-[1440px] px-3 pt-5 pb-8 sm:px-5 lg:px-8">
        <OwnerBoard />
      </div>
    );
  } else if (!legacyOpen && view === 'portfolio') {
    content = <PortfolioBoard />;
  } else if (!legacyOpen) {
    content = (
      <div className="mx-auto w-full max-w-[1440px] px-3 pt-5 pb-8 sm:px-5 lg:px-8">
        <MissionControlNeedsYou
          snapshot={snapshot}
          loading={loading}
          unsupported={unsupported}
          error={error}
          refreshing={refreshing}
          drafts={drafts}
          focusItemId={focusItemId}
          onRetry={() => void refresh()}
          onDraftChange={handleDraftChange}
          onAdoptCurrent={handleAdoptCurrent}
          onSubmit={(item) => void handleSubmit(item)}
        />
      </div>
    );
  } else if (loading) {
    content = <MissionControlDashboardSkeleton />;
  } else if (!snapshot) {
    content = <MissionControlErrorState unsupported={unsupported} error={error} onRetry={() => void refresh()} />;
  } else {
    content = (
      <>
        {error && (
          <div className="mx-auto mt-4 flex w-[calc(100%-1.5rem)] max-w-[1440px] items-start gap-2 rounded-md border border-ui-red/20 bg-ui-red/5 px-3 py-2 text-sm text-ui-red sm:w-[calc(100%-2.5rem)] lg:w-[calc(100%-4rem)]">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Live refresh failed: {error}. Showing the last confirmed snapshot.</span>
          </div>
        )}
        <MissionControlDashboard
          snapshot={snapshot}
          drafts={drafts}
          refreshing={refreshing}
          bootstrapPending={bootstrapPending}
          bootstrapError={bootstrapError}
          onRefresh={() => void refresh()}
          onOpenWorkspace={selectWorkspace}
          onBootstrap={() => void handleBootstrap()}
        />
      </>
    );
  }

  return (
    <>
      <Head><title>{view === 'portfolio' ? 'Portfolio board' : 'Mission Control'} · PurpleMux</title></Head>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-between gap-2 px-3 pt-3 sm:px-5 lg:px-8">
          <nav aria-label="Mission Control views" className="flex gap-1">
            {VIEWS.map((entry) => (
              <Link key={entry.view} href={`/mission-control?view=${entry.view}`} shallow
                className={buttonVariants({ size: 'sm', variant: !legacyOpen && view === entry.view ? 'secondary' : 'ghost' })}
                aria-current={!legacyOpen && view === entry.view ? 'page' : undefined}
                onClick={() => setLegacyOpen(false)} data-view-link={entry.view}>
                {entry.label}
              </Link>
            ))}
          </nav>
          <Button size="sm" variant="ghost" onClick={() => setLegacyOpen((open) => !open)}>
            {legacyOpen ? 'Back to the board' : 'Mission records'}
          </Button>
        </div>
        {content}
      </main>
    </>
  );
};

MissionControlPage.getLayout = getPageShellWithTitlebarLayout;

export const getServerSideProps: GetServerSideProps = async (context) => {
  const { requireAuth } = await import('@/lib/require-auth');
  const { loadMessagesServer } = await import('@/lib/load-messages');
  return requireAuth(context, async () => {
    const messages = await loadMessagesServer();
    return { props: { messages } };
  });
};

export default MissionControlPage;
