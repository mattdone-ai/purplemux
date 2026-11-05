import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeMissionRefreshSnapshot } from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAnswerResponse,
  IMissionAttentionItem,
  IMissionBootstrap,
  IMissionSnapshot,
} from '@/types/mission-control';

const POLL_INTERVAL_MS = 5_000;

/** A server older than ADR-0031 omits `class`, `defaultOptionId` and `autoAnswer`; every consumer reads one absence value, null. */
export const normalizeMissionItem = (item: IMissionAttentionItem): IMissionAttentionItem => ({
  ...item,
  class: item.class ?? null,
  defaultOptionId: item.defaultOptionId ?? null,
  autoAnswer: item.autoAnswer ?? null,
  evidenceLinks: item.evidenceLinks ?? [],
  lint: item.lint ?? [],
  changes: item.changes ?? null,
});

/** The snapshot with this item replaced when it is newer than the one held; unchanged otherwise. */
export const mergeMissionItem = (snapshot: IMissionSnapshot, item: IMissionAttentionItem): IMissionSnapshot => {
  const held = snapshot.items.find((candidate) => candidate.id === item.id);
  if (!held || held.revision >= item.revision) return snapshot;
  return { ...snapshot, items: snapshot.items.map((candidate) => candidate.id === item.id ? item : candidate) };
};

export const normalizeMissionSnapshot = (snapshot: IMissionSnapshot): IMissionSnapshot => ({
  ...snapshot,
  items: snapshot.items.map(normalizeMissionItem),
});

export interface IMissionPollScheduler {
  start: () => void;
  restart: () => void;
  stop: () => void;
}

interface IMissionPollSchedulerDeps {
  refresh: () => Promise<void>;
  isHidden: () => boolean;
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}

export const createMissionPollScheduler = (
  deps: IMissionPollSchedulerDeps,
  intervalMs = POLL_INTERVAL_MS,
): IMissionPollScheduler => {
  let active = true;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) deps.cancel(timer);
    timer = null;
  };

  const poll = async (pollEpoch: number): Promise<void> => {
    if (!active || pollEpoch !== epoch || deps.isHidden()) return;
    await deps.refresh();
    if (!active || pollEpoch !== epoch || deps.isHidden()) return;
    timer = deps.schedule(() => void poll(pollEpoch), intervalMs);
  };

  const restart = () => {
    epoch += 1;
    clearTimer();
    if (!active || deps.isHidden()) return;
    void poll(epoch);
  };

  return {
    start: restart,
    restart,
    stop: () => {
      active = false;
      epoch += 1;
      clearTimer();
    },
  };
};

interface IMissionControlState {
  snapshot: IMissionSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  unsupported: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  applyAnswer: (response: IMissionAnswerResponse) => void;
  applyItem: (item: IMissionAttentionItem) => void;
  applyBootstrap: (bootstrap: IMissionBootstrap) => void;
}

const responseError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: string };
    if (body.error) return body.error;
  } catch {
    // The status text remains the truthful fallback for non-JSON failures.
  }
  return response.statusText || `Request failed (${response.status})`;
};

const useMissionControl = (enabled = true): IMissionControlState => {
  const [snapshot, setSnapshot] = useState<IMissionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const bootstrapMutationEpoch = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const bootstrapEpochAtRequest = bootstrapMutationEpoch.current;

    const request = (async () => {
      setRefreshing(true);
      try {
        const response = await fetch('/api/mission-control', {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (response.status === 404 || response.status === 405) {
          setUnsupported(true);
          setError(null);
          return;
        }
        if (!response.ok) throw new Error(await responseError(response));

        const incoming = normalizeMissionSnapshot(await response.json() as IMissionSnapshot);
        setSnapshot((current) => mergeMissionRefreshSnapshot(
          current,
          incoming,
          bootstrapEpochAtRequest,
          bootstrapMutationEpoch.current,
        ));
        setUnsupported(false);
        setError(null);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Unable to load Mission Control');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    })();

    inFlight.current = request;
    await request;
    inFlight.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const scheduler = createMissionPollScheduler({
      refresh,
      isHidden: () => document.hidden,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (timer) => clearTimeout(timer),
    });
    const handleVisibility = () => scheduler.restart();

    scheduler.start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      scheduler.stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, refresh]);

  const applyAnswer = useCallback((response: IMissionAnswerResponse) => {
    setSnapshot((current) => {
      if (!current) return current;
      if (response.cursor < current.cursor) return current;

      const replaceById = <T extends { id: string }>(rows: T[], row: T): T[] =>
        rows.some((candidate) => candidate.id === row.id)
          ? rows.map((candidate) => candidate.id === row.id ? row : candidate)
          : [...rows, row];
      const items = current.items.some((item) =>
        item.id === response.item.id && item.revision > response.item.revision)
        ? current.items
        : replaceById(current.items, normalizeMissionItem(response.item));
      const deliveries = current.deliveries.some((delivery) =>
        delivery.id === response.delivery.id && delivery.updatedAt > response.delivery.updatedAt)
        ? current.deliveries
        : replaceById(current.deliveries, response.delivery);

      return {
        ...current,
        cursor: Math.max(current.cursor, response.cursor),
        items,
        answers: replaceById(current.answers, response.answer),
        deliveries,
      };
    });
  }, []);

  /** A newer item the server answered with (a 409's `current`), so the card and its draft agree at once. */
  const applyItem = useCallback((item: IMissionAttentionItem) => {
    setSnapshot((current) => current ? mergeMissionItem(current, normalizeMissionItem(item)) : current);
  }, []);

  const applyBootstrap = useCallback((bootstrap: IMissionBootstrap) => {
    bootstrapMutationEpoch.current += 1;
    setSnapshot((current) => current ? { ...current, bootstrap } : current);
  }, []);

  return {
    snapshot,
    loading,
    refreshing,
    unsupported,
    error,
    refresh,
    applyAnswer,
    applyItem,
    applyBootstrap,
  };
};

export default useMissionControl;
