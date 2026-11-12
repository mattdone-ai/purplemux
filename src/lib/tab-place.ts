import { createLogger } from '@/lib/logger';
import { DEFAULT_TAB_PLACE_MODE, tabPlaceModeOf } from '@/lib/pool';
import type { IPlainPlacement } from '@/lib/pool-tab-placement';
import { recordTabPlace } from '@/lib/pool-runtime';
import type { IPoolRoomAnswer, TPoolTabPlaceMode } from '@/types/pool';

// A `tab create` without `--host` (ADR-0045): `pool.tab-place.<workspaceId>` decides whether the pool is asked.
// `advise` asks after the create has started, so the advice never delays it (ruling 14); `place` asks first and
// places on a clean answer (ruling 1); `here` asks nothing.

const log = createLogger('tab-place');

/**
 * Only a claude-code tab with no role and no pool class may leave this host (ADR-0039 §4): any other plain create is
 * not placeable, and a coordinator is created with `--host local` or as class control-plane.
 */
export const isPlainPlaceable = (panelType: string, role: string | null | undefined, poolClass: unknown): boolean =>
  panelType === 'claude-code' && !role && (poolClass === undefined || poolClass === null);

/** The workspace's mode. A fleet store that cannot be read gives `here`: today's create, never a placement on a guess. */
export const readTabPlaceMode = async (workspaceId: string): Promise<TPoolTabPlaceMode> => {
  try {
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    const state = await readFleetConfig();
    return tabPlaceModeOf((key) => valueOf(state, key)?.value ?? null, workspaceId);
  } catch (err) {
    log.warn(`pool.tab-place.${workspaceId} unreadable, the create runs here (default ${DEFAULT_TAB_PLACE_MODE} not applied): ${err instanceof Error ? err.message : err}`);
    return 'here';
  }
};

export interface ITabAdvice {
  room: IPoolRoomAnswer;
  localFree: number | null;
}

const adviceText = (advice: ITabAdvice | null): string => {
  if (!advice) return 'the pool did not answer';
  return advice.room.host ? `room answer ${advice.room.host}: ${advice.room.reason}` : `no room answer: ${advice.room.reason}`;
};

/**
 * One plain create, recorded when its advice settles (never awaited by the create). `placement` is the `place`
 * answer; absent in `advise` mode, where the tab always runs here.
 */
export const notePlainCreate = (
  entry: { mode: Exclude<TPoolTabPlaceMode, 'here'>; workspaceId: string; tabId: string; placement: IPlainPlacement | null },
  advice: Promise<ITabAdvice | null>,
): void => {
  const remote = entry.placement?.applied === true && !entry.placement.local;
  void advice.then((a) => {
    recordTabPlace({
      mode: entry.mode,
      workspaceId: entry.workspaceId,
      tabId: entry.tabId,
      outcome: remote ? 'placed-remote' : 'here',
      localFree: a?.localFree ?? null,
      detail: entry.placement ? `${entry.placement.reason}; ${adviceText(a)}` : adviceText(a),
    });
  }).catch((err: unknown) => log.warn(`tab-place record failed: ${err instanceof Error ? err.message : err}`));
};
