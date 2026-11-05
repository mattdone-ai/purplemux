import { create } from 'zustand';
import type { IOrchestrationNudge } from '@/types/status';

const MAX_NUDGES = 200;

interface IOrchestrationState {
  nudges: IOrchestrationNudge[];
  addNudge: (nudge: IOrchestrationNudge) => void;
  mergeNudges: (incoming: IOrchestrationNudge[]) => void;
}

const useOrchestrationStore = create<IOrchestrationState>((set) => ({
  nudges: [],
  // A nudge the client already holds comes again when its digest goes out: replace it in place (ADR-0035).
  addNudge: (nudge) => set((s) => {
    const index = s.nudges.findIndex((n) => n.id === nudge.id);
    if (index === -1) return { nudges: [...s.nudges, nudge].slice(-MAX_NUDGES) };
    const nudges = [...s.nudges];
    nudges[index] = nudge;
    return { nudges };
  }),
  mergeNudges: (incoming) => set((s) => {
    const byId = new Map(s.nudges.map((n) => [n.id, n]));
    const unchanged = incoming.every((n) => {
      const held = byId.get(n.id);
      return held !== undefined && held.delivered === n.delivered && held.wakeClass === n.wakeClass;
    });
    if (unchanged) return s;
    for (const n of incoming) byId.set(n.id, n);
    return { nudges: [...byId.values()].sort((a, b) => a.at - b.at).slice(-MAX_NUDGES) };
  }),
}));

export default useOrchestrationStore;
