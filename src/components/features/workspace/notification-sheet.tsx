import { useMemo, useCallback, useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslations } from 'next-intl';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  FilePen,
  FilePlus,
  Terminal,
  Search,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import Spinner from '@/components/ui/spinner';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import useTabStore from '@/hooks/use-tab-store';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import useSessionHistoryStore from '@/hooks/use-session-history-store';
import useOrchestrationStore from '@/hooks/use-orchestration-store';
import { fetchOrchestrationNudges } from '@/lib/orchestration-client';
import { dismissTab } from '@/hooks/use-agent-status';
import { navigateToTab, navigateToTabOrCreate, useLayoutStore } from '@/hooks/use-layout';
import { findPane } from '@/lib/layout-tree';
import type { ITabState } from '@/hooks/use-tab-store';
import type { ICurrentAction, IOrchestrationNudge } from '@/types/status';
import GrokIcon from '@/components/icons/grok-icon';
import { toSessionHistoryProvider } from '@/lib/agent-panel-types';
import type { ISessionHistoryEntry, TSessionHistoryProvider } from '@/types/session-history';
import { stripMarkdown } from '@/lib/strip-markdown';
import ClaudeCodeIcon from '@/components/icons/claude-code-icon';
import OpenAIIcon from '@/components/icons/openai-icon';

const ACTION_ICONS: Record<string, typeof FileText> = {
  Read: FileText,
  Edit: FilePen,
  Write: FilePlus,
  Bash: Terminal,
  Grep: Search,
  Glob: Search,
  Agent: Users,
};

/** A held digest nudge is waiting by design, not undelivered (ADR-0035). */
const nudgeDeliveryNote = (nudge: IOrchestrationNudge, t: (key: 'notDelivered' | 'heldForDigest' | 'logged') => string): string => {
  if (nudge.delivered) return '';
  if (nudge.wakeClass === 'digest') return ` · ${t('heldForDigest')}`;
  if (nudge.wakeClass === 'log') return ` · ${t('logged')}`;
  return ` · ${t('notDelivered')}`;
};

const ITEM_MOTION = {
  layout: true,
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.92 },
  transition: { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] as const },
};


interface IActiveTabInfo {
  id: string | null;
  agentSessionId: string | null;
  providerId: TSessionHistoryProvider | null;
}

const useActiveTab = (): IActiveTabInfo => {
  const router = useRouter();
  const isTerminalPage = router.pathname === '/';
  return useLayoutStore(useShallow((s): IActiveTabInfo => {
    if (!isTerminalPage) return { id: null, agentSessionId: null, providerId: null };
    if (!s.layout?.activePaneId) return { id: null, agentSessionId: null, providerId: null };
    const pane = findPane(s.layout.root, s.layout.activePaneId);
    if (!pane?.activeTabId) return { id: null, agentSessionId: null, providerId: null };
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (!tab) return { id: pane.activeTabId, agentSessionId: null, providerId: null };
    const providerId = toSessionHistoryProvider(tab.agentState?.providerId);
    const agentSessionId = tab.agentState?.sessionId ?? tab.claudeSessionId ?? null;
    return { id: pane.activeTabId, agentSessionId, providerId };
  }));
};

export const useNotificationCount = (): { busyCount: number; attentionCount: number } => {
  const tabs = useTabStore((s) => s.tabs);
  return useMemo(() => {
    let busyCount = 0;
    let attentionCount = 0;
    for (const tab of Object.values(tabs)) {
      if (tab.cliState === 'busy') busyCount++;
      else if (tab.cliState === 'ready-for-review' || tab.cliState === 'needs-input') attentionCount++;
    }
    return { busyCount, attentionCount };
  }, [tabs]);
};

interface INotificationItem {
  tabId: string;
  workspaceName: string;
  workspaceId: string;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  currentAction?: ICurrentAction | null;
  readyForReviewAt?: number | null;
  busySince?: number | null;
  dismissedAt?: number | null;
  agentSessionId?: string | null;
  providerId: TSessionHistoryProvider;
}

interface INotificationSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const collectItems = (
  tabs: Record<string, ITabState>,
  workspaces: { id: string; name: string }[],
  targetState: 'busy' | 'ready-for-review' | 'needs-input',
): INotificationItem[] => {
  const wsMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));
  const items: INotificationItem[] = [];

  for (const [tabId, tab] of Object.entries(tabs)) {
    if (tab.cliState !== targetState) continue;
    items.push({
      tabId,
      workspaceName: wsMap.get(tab.workspaceId) || tab.workspaceId,
      workspaceId: tab.workspaceId,
      lastUserMessage: tab.lastUserMessage,
      lastAssistantMessage: tab.lastAssistantMessage,
      currentAction: tab.currentAction,
      readyForReviewAt: tab.readyForReviewAt,
      busySince: tab.busySince,
      dismissedAt: tab.dismissedAt,
      agentSessionId: tab.agentSessionId,
      providerId: tab.agentProviderId === 'codex' ? 'codex' : 'claude',
    });
  }

  items.sort((a, b) => {
    const ta = a.readyForReviewAt ?? a.busySince ?? 0;
    const tb = b.readyForReviewAt ?? b.busySince ?? 0;
    return tb - ta;
  });

  return items;
};

interface ISessionHistoryGroup {
  groupKey: string;
  agentSessionId: string | null;
  providerId: TSessionHistoryProvider;
  tabId: string;
  workspaceName: string;
  latestEntry: ISessionHistoryEntry;
  olderEntries: ISessionHistoryEntry[];
}

const groupHistoryBySession = (entries: ISessionHistoryEntry[]): ISessionHistoryGroup[] => {
  const sessionMap = new Map<string, ISessionHistoryEntry[]>();

  for (const entry of entries) {
    const key = `${entry.providerId}:${entry.agentSessionId ?? entry.id}`;
    const existing = sessionMap.get(key);
    if (existing) existing.push(entry);
    else sessionMap.set(key, [entry]);
  }

  const groups: ISessionHistoryGroup[] = [];
  for (const [groupKey, sessionEntries] of sessionMap) {
    sessionEntries.sort((a, b) => b.completedAt - a.completedAt);
    const head = sessionEntries[0];
    groups.push({
      groupKey,
      agentSessionId: head.agentSessionId,
      providerId: head.providerId,
      tabId: head.tabId,
      workspaceName: head.workspaceName,
      latestEntry: head,
      olderEntries: sessionEntries.slice(1),
    });
  }

  groups.sort((a, b) => b.latestEntry.completedAt - a.latestEntry.completedAt);
  return groups;
};

const PROVIDER_BADGE: Record<TSessionHistoryProvider, { Icon: typeof ClaudeCodeIcon; label: string }> = {
  claude: { Icon: ClaudeCodeIcon, label: 'Claude' },
  codex: { Icon: OpenAIIcon, label: 'Codex' },
  grok: { Icon: GrokIcon, label: 'Grok' },
};

const ProviderBadge = ({ providerId }: { providerId: TSessionHistoryProvider }) => {
  const { Icon, label } = PROVIDER_BADGE[providerId] ?? PROVIDER_BADGE.claude;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground/60"
      aria-label={label}
    >
      <Icon className="size-3" />
    </span>
  );
};

type TDateGroup = 'today' | 'yesterday' | 'thisWeek' | 'older';

const groupSessionsByDate = (groups: ISessionHistoryGroup[]): { group: TDateGroup; sessions: ISessionHistoryGroup[] }[] => {
  const now = dayjs();
  const todayStart = now.startOf('day');
  const yesterdayStart = todayStart.subtract(1, 'day');
  const weekStart = todayStart.subtract(6, 'day');

  const buckets: Record<TDateGroup, ISessionHistoryGroup[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  };

  for (const sg of groups) {
    const time = dayjs(sg.latestEntry.completedAt);
    if (time.isAfter(todayStart)) buckets.today.push(sg);
    else if (time.isAfter(yesterdayStart)) buckets.yesterday.push(sg);
    else if (time.isAfter(weekStart)) buckets.thisWeek.push(sg);
    else buckets.older.push(sg);
  }

  return (['today', 'yesterday', 'thisWeek', 'older'] as TDateGroup[])
    .filter((g) => buckets[g].length > 0)
    .map((g) => ({ group: g, sessions: buckets[g] }));
};

const formatNotificationTime = (ts: number): string => {
  const d = dayjs(ts);
  const now = dayjs();
  if (now.diff(d, 'minute') < 60) return d.fromNow();
  if (d.isAfter(now.startOf('day'))) return d.format('HH:mm');
  return d.format('M/D HH:mm');
};




const SessionHistoryItem = ({
  entry,
  isActiveSession,
  compact,
  icon,
  onClick,
}: {
  entry: ISessionHistoryEntry;
  isActiveSession?: boolean;
  compact?: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
}) => {
  const t = useTranslations('notification');

  const durationText = useMemo(() => {
    const minutes = Math.round(entry.duration / 60000);
    if (minutes < 1) return t('durationUnderMinute');
    return t('durationMinutes', { count: minutes });
  }, [entry.duration, t]);

  const summaryText = useMemo(() => {
    const parts: string[] = [];
    if (entry.touchedFiles.length > 0) {
      parts.push(t('filesModified', { count: entry.touchedFiles.length }));
    }
    const total = Object.values(entry.toolUsage).reduce((a, b) => a + b, 0);
    if (total > 0 && entry.touchedFiles.length === 0) {
      parts.push(t('toolCalls', { count: total }));
    }
    return parts.join(' · ');
  }, [entry.touchedFiles, entry.toolUsage, t]);

  if (compact) {
    return (
      <div
        className="rounded px-2 py-1.5 transition-colors hover:bg-muted cursor-pointer"
        onClick={onClick}
      >
        <div className="flex items-center justify-between gap-2">
          {entry.prompt ? (
            <p className="truncate text-xs text-foreground/70">
              {stripMarkdown(entry.prompt)}
            </p>
          ) : (
            <span />
          )}
          <span className="shrink-0 text-xs text-muted-foreground/40">
            {formatNotificationTime(entry.completedAt)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground/40">
          {durationText}
          {summaryText && ` · ${summaryText}`}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors',
        isActiveSession
          ? 'bg-claude-active/10'
          : 'hover:bg-muted cursor-pointer',
      )}
      onClick={isActiveSession ? undefined : onClick}
    >
      <span className="mt-1 shrink-0">
        {icon ?? (entry.cancelled
          ? <XCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
          : <CheckCircle2 className={cn('h-3.5 w-3.5', entry.dismissedAt ? 'text-muted-foreground' : 'text-muted-foreground/50')} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            <ProviderBadge providerId={entry.providerId} />
            <span className="truncate">{entry.workspaceName}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground/60">
            {formatNotificationTime(entry.completedAt)}
          </span>
        </div>
        {entry.prompt && (
          <p className={cn('mt-0.5 truncate text-sm', isActiveSession ? 'text-foreground' : 'text-muted-foreground')}>
            {stripMarkdown(entry.prompt)}
          </p>
        )}
        {entry.result && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/50">
            {stripMarkdown(entry.result)}
          </p>
        )}
        <p className="mt-0.5 truncate text-xs text-muted-foreground/50">
          {durationText}
          {summaryText && ` · ${summaryText}`}
        </p>
      </div>
    </div>
  );
};

const NotificationItem = ({
  item,
  showActions,
  variant,
  isActiveTab,
  onDismiss,
  onNavigate,
}: {
  item: INotificationItem;
  showActions: boolean;
  variant?: 'needs-input' | 'done';
  isActiveTab?: boolean;
  onDismiss?: (tabId: string) => void;
  onNavigate?: (workspaceId: string, tabId: string) => void;
}) => {
  const t = useTranslations('notification');
  const action = item.currentAction;

  const renderAction = () => {
    if (!action) return showActions ? null : t('starting');
    const IconComponent = action.toolName ? ACTION_ICONS[action.toolName] ?? Wrench : null;
    return (
      <span className="inline-flex items-center gap-1 min-w-0">
        {IconComponent && <IconComponent size={11} className="shrink-0 text-muted-foreground/40" />}
        <span className="truncate">{action.summary}</span>
      </span>
    );
  };

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors',
        isActiveTab
          ? 'bg-claude-active/10'
          : 'hover:bg-muted cursor-pointer',
      )}
      onClick={isActiveTab ? undefined : () => onNavigate?.(item.workspaceId, item.tabId)}
    >
      <span className="mt-1 shrink-0">
        {variant === 'done' ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground/50" />
        ) : variant === 'needs-input' ? (
          <span className="block h-2 w-2 rounded-full bg-ui-amber animate-pulse" />
        ) : showActions ? (
          <span className="mt-px block h-2 w-2 rounded-full bg-claude-active" />
        ) : (
          <Spinner className="h-3 w-3 text-claude-active/70" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            <ProviderBadge providerId={item.providerId} />
            <span className="truncate">{item.workspaceName}</span>
          </span>
          {(item.dismissedAt || item.readyForReviewAt || item.busySince) && (
            <span className="shrink-0 text-xs text-muted-foreground/60">
              {formatNotificationTime(item.dismissedAt ?? item.readyForReviewAt ?? item.busySince!)}
            </span>
          )}
        </div>
        {item.lastUserMessage && (
          <p className={cn('mt-0.5 truncate text-sm', isActiveTab ? 'text-foreground' : 'text-muted-foreground')}>
            {stripMarkdown(item.lastUserMessage)}
          </p>
        )}
        {variant === 'done' ? (
          item.lastAssistantMessage && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground/50">
              {stripMarkdown(item.lastAssistantMessage)}
            </p>
          )
        ) : !variant && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/60">
            {renderAction()}
          </p>
        )}
        {showActions && !isActiveTab && (
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={(e) => { e.stopPropagation(); onDismiss?.(item.tabId); }}
            >
              <Check className="mr-1 h-3 w-3" />
              {t('dismiss')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export const NotificationPanel = ({ onNavigated, className }: { onNavigated?: () => void; className?: string }) => {
  const t = useTranslations('notification');
  const tOrch = useTranslations('orchestration');
  const tabs = useTabStore((s) => s.tabs);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const allNudges = useOrchestrationStore((s) => s.nudges);
  const orchestrationWorkspaceIds = useMemo(
    () => workspaces.filter((w) => w.orchestration?.enabled).map((w) => w.id),
    [workspaces],
  );
  useEffect(() => {
    for (const id of orchestrationWorkspaceIds) {
      fetchOrchestrationNudges(id)
        .then((fetched) => useOrchestrationStore.getState().mergeNudges(fetched))
        .catch(() => {});
    }
  }, [orchestrationWorkspaceIds]);
  const nudges = useMemo(
    () => allNudges.filter((n) => orchestrationWorkspaceIds.includes(n.workspaceId)),
    [allNudges, orchestrationWorkspaceIds],
  );
  const { id: activeTabId, agentSessionId: activeAgentSessionId, providerId: activeProviderId } = useActiveTab();
  const historyEntries = useSessionHistoryStore((s) => s.entries);
  const liveSessionKey = (providerId: TSessionHistoryProvider, agentSessionId: string | null): string =>
    `${providerId}:${agentSessionId ?? ''}`;
  const sessionTabMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [tabId, tab] of Object.entries(tabs)) {
      if (!tab.agentSessionId) continue;
      const provider = toSessionHistoryProvider(tab.agentProviderId);
      map.set(liveSessionKey(provider, tab.agentSessionId), tabId);
    }
    return map;
  }, [tabs]);
  const [expandedTabs, setExpandedTabs] = useState<Set<string>>(new Set());

  const busyItems = useMemo(() => collectItems(tabs, workspaces, 'busy'), [tabs, workspaces]);
  const needsInputItems = useMemo(() => collectItems(tabs, workspaces, 'needs-input'), [tabs, workspaces]);
  const reviewItems = useMemo(() => collectItems(tabs, workspaces, 'ready-for-review'), [tabs, workspaces]);
  const liveSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [, tab] of Object.entries(tabs)) {
      if ((tab.cliState === 'busy' || tab.cliState === 'needs-input' || tab.cliState === 'ready-for-review') && tab.agentSessionId) {
        const provider = toSessionHistoryProvider(tab.agentProviderId);
        keys.add(liveSessionKey(provider, tab.agentSessionId));
      }
    }
    return keys;
  }, [tabs]);
  const reviewSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [, tab] of Object.entries(tabs)) {
      if (tab.cliState === 'ready-for-review' && tab.agentSessionId) {
        const provider = toSessionHistoryProvider(tab.agentProviderId);
        keys.add(liveSessionKey(provider, tab.agentSessionId));
      }
    }
    return keys;
  }, [tabs]);
  const reviewHistoryMap = useMemo(() => {
    const map = new Map<string, ISessionHistoryEntry>();
    for (const entry of historyEntries) {
      if (!entry.agentSessionId) continue;
      const key = liveSessionKey(entry.providerId, entry.agentSessionId);
      if (!reviewSessionKeys.has(key)) continue;
      const existing = map.get(key);
      if (!existing || entry.completedAt > existing.completedAt) {
        map.set(key, entry);
      }
    }
    return map;
  }, [historyEntries, reviewSessionKeys]);
  const sessionGroups = useMemo(() => {
    const filtered = liveSessionKeys.size > 0
      ? historyEntries.filter((e) => {
          if (!e.agentSessionId) return true;
          return !liveSessionKeys.has(liveSessionKey(e.providerId, e.agentSessionId));
        })
      : historyEntries;
    return groupHistoryBySession(filtered);
  }, [historyEntries, liveSessionKeys]);
  const dateGroups = useMemo(() => groupSessionsByDate(sessionGroups), [sessionGroups]);

  const toggleExpanded = useCallback((sessionId: string) => {
    setExpandedTabs((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const handleDismiss = useCallback((tabId: string) => { dismissTab(tabId); }, []);

  const handleNavigate = useCallback((workspaceId: string, tabId: string) => {
    navigateToTab(workspaceId, tabId);
    onNavigated?.();
  }, [onNavigated]);

  const handleHistoryClick = useCallback((entry: ISessionHistoryEntry, resolvedTabId: string | null) => {
    onNavigated?.();
    if (resolvedTabId) {
      navigateToTab(entry.workspaceId, resolvedTabId);
    } else {
      navigateToTabOrCreate(
        entry.workspaceId,
        entry.tabId,
        entry.agentSessionId,
        entry.workspaceName,
        entry.workspaceDir,
        entry.providerId,
      );
    }
  }, [onNavigated]);

  const isEmpty = busyItems.length === 0 && needsInputItems.length === 0 && reviewItems.length === 0 && dateGroups.length === 0 && nudges.length === 0;

  return (
    <div className={cn('flex-1 overflow-y-auto', className)} style={{ scrollbarWidth: 'none' }}>
      {isEmpty ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          {busyItems.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('busySection', { count: busyItems.length })}
              </h3>
              <div className="flex flex-col gap-2">
                <AnimatePresence mode="popLayout" initial={false}>
                  {busyItems.map((item) => (
                    <motion.div key={item.tabId} {...ITEM_MOTION}>
                      <NotificationItem item={item} showActions={false} isActiveTab={item.tabId === activeTabId} onNavigate={handleNavigate} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}

          {needsInputItems.length > 0 && (
            <section className={busyItems.length > 0 ? 'mt-4' : ''}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('needsInputSection', { count: needsInputItems.length })}
              </h3>
              <div className="flex flex-col gap-2">
                <AnimatePresence mode="popLayout" initial={false}>
                  {needsInputItems.map((item) => (
                    <motion.div key={item.tabId} {...ITEM_MOTION}>
                      <NotificationItem item={item} showActions={false} variant="needs-input" isActiveTab={item.tabId === activeTabId} onNavigate={handleNavigate} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}

          {reviewItems.length > 0 && (
            <section className={busyItems.length > 0 || needsInputItems.length > 0 ? 'mt-4' : ''}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('reviewSection', { count: reviewItems.length })}
              </h3>
              <div className="flex flex-col gap-2">
                <AnimatePresence mode="popLayout" initial={false}>
                  {reviewItems.map((item) => {
                    const entry = item.agentSessionId
                      ? reviewHistoryMap.get(liveSessionKey(item.providerId, item.agentSessionId))
                      : undefined;
                    const isActive = item.tabId === activeTabId;
                    if (!entry) {
                      return (
                        <motion.div key={item.tabId} {...ITEM_MOTION}>
                          <NotificationItem item={item} showActions isActiveTab={isActive} onDismiss={handleDismiss} onNavigate={handleNavigate} />
                        </motion.div>
                      );
                    }
                    return (
                      <motion.div key={item.tabId} {...ITEM_MOTION}>
                        <SessionHistoryItem
                          entry={entry}
                          isActiveSession={isActive}
                          icon={<span className="mt-px block h-2 w-2 rounded-full bg-claude-active" />}
                          onClick={isActive ? undefined : () => handleNavigate(item.workspaceId, item.tabId)}
                        />
                        {!isActive && (
                          <div className="mt-1 flex items-center pl-9">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => handleDismiss(item.tabId)}
                            >
                              <Check className="mr-1 h-3 w-3" />
                              {t('dismiss')}
                            </Button>
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </section>
          )}

          {nudges.length > 0 && (
            <section className={busyItems.length > 0 || needsInputItems.length > 0 || reviewItems.length > 0 ? 'mt-4' : ''}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {tOrch('watchdogSection', { count: nudges.length })}
              </h3>
              <div className="flex flex-col gap-1">
                {nudges.slice(-8).reverse().map((nudge) => (
                  <button
                    key={nudge.id}
                    className="flex w-full flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() => handleNavigate(nudge.workspaceId, nudge.tabId)}
                  >
                    <span className="flex items-center gap-1.5 text-xs text-foreground">
                      <span className={cn(
                        'block h-1.5 w-1.5 shrink-0 rounded-full',
                        nudge.kind === 'needs-input' ? 'bg-ui-amber'
                          : nudge.kind === 'stuck' || nudge.kind === 'inactive' || nudge.kind === 'stalled' || nudge.kind === 'probe-failed' || nudge.kind === 'bg-failed' || nudge.kind === 'bg-exited-unknown' || nudge.kind === 'bg-died' || nudge.kind === 'model-drift' ? 'bg-destructive'
                          : 'bg-claude-active',
                      )} />
                      <span className="min-w-0 flex-1 truncate">{nudge.tabName || nudge.tabId}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{dayjs(nudge.at).format('HH:mm')}</span>
                    </span>
                    <span className="truncate pl-3 text-[11px] text-muted-foreground">
                      {tOrch(`kind_${nudge.kind}`)}{nudgeDeliveryNote(nudge, tOrch)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {dateGroups.length > 0 && (
            <section className={busyItems.length > 0 || needsInputItems.length > 0 || reviewItems.length > 0 || nudges.length > 0 ? 'mt-4' : ''}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('doneSection', { count: historyEntries.length >= 200 ? '200+' : historyEntries.length })}
              </h3>
              {dateGroups.map(({ group: dateGroup, sessions }) => (
                <div key={dateGroup}>
                  <h4 className="mb-1.5 mt-3 first:mt-0 text-xs text-muted-foreground/60">
                    {t(`dateGroup_${dateGroup}`)}
                  </h4>
                  <div className="flex flex-col gap-2">
                    <AnimatePresence mode="popLayout" initial={false}>
                      {sessions.map((group) => {
                        const isExpanded = expandedTabs.has(group.groupKey);
                        const hasOlder = group.olderEntries.length > 0;
                        const sessionKey = group.agentSessionId
                          ? liveSessionKey(group.providerId, group.agentSessionId)
                          : null;
                        const isActive =
                          activeAgentSessionId !== null &&
                          group.agentSessionId === activeAgentSessionId &&
                          group.providerId === activeProviderId &&
                          (sessionKey === null || !liveSessionKeys.has(sessionKey));
                        const resolvedTabId = sessionKey ? sessionTabMap.get(sessionKey) ?? null : null;
                        return (
                          <motion.div key={group.groupKey} {...ITEM_MOTION}>
                            <SessionHistoryItem
                              entry={group.latestEntry}
                              isActiveSession={isActive}
                              onClick={() => handleHistoryClick(group.latestEntry, resolvedTabId)}
                            />
                            {hasOlder && (
                              <button
                                type="button"
                                className="mt-1 flex w-full items-center gap-1 py-0.5 pl-9 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                                onClick={() => toggleExpanded(group.groupKey)}
                              >
                                <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
                                {isExpanded ? t('showLess') : t('showMore', { count: group.olderEntries.length })}
                              </button>
                            )}
                            {hasOlder && (
                              <div
                                className="grid transition-[grid-template-rows] duration-200 ease-out"
                                style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
                              >
                                <div className="overflow-hidden min-h-0">
                                  <div className="mt-1 flex flex-col border-l border-border/30 ml-5 pl-2">
                                    {group.olderEntries.map((entry) => (
                                      <SessionHistoryItem
                                        key={entry.id}
                                        entry={entry}
                                        compact
                                        onClick={() => handleHistoryClick(entry, resolvedTabId)}
                                      />
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
};

const NotificationSheet = ({ open, onOpenChange }: INotificationSheetProps) => {
  const t = useTranslations('notification');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" showCloseButton={false} className="w-80 sm:max-w-80">
        <div className="h-titlebar shrink-0" />
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
        </SheetHeader>
        <NotificationPanel onNavigated={() => onOpenChange(false)} className="px-4 pb-4" />
      </SheetContent>
    </Sheet>
  );
};

export default NotificationSheet;
