import { useCallback, useEffect, useRef, useState } from 'react';
import { createMissionPollScheduler } from '@/hooks/use-mission-control';
import type { ICoordinationSnapshot } from '@/types/coordination';

const POLL_INTERVAL_MS = 15_000;

/** The coordination panel's data (story 20): polled every 15 s while the page is visible. */
const useCoordination = () => {
  const [snapshot, setSnapshot] = useState<ICoordinationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const response = await fetch('/api/mission-control/coordination', { cache: 'no-store', headers: { Accept: 'application/json' } });
        const body = await response.json().catch(() => null) as (ICoordinationSnapshot & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error || response.statusText || `Request failed (${response.status})`);
        setSnapshot(body);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    inFlight.current = request;
    await request;
    inFlight.current = null;
  }, []);

  useEffect(() => {
    const scheduler = createMissionPollScheduler({
      refresh,
      isHidden: () => document.hidden,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (timer) => clearTimeout(timer),
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => scheduler.restart();
    scheduler.start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      scheduler.stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh]);

  return { snapshot, error, loading, refresh };
};

export default useCoordination;
