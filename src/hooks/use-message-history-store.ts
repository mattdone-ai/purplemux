import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { IHistoryEntry } from '@/types/message-history';

const MAX_ENTRIES = 500;

interface IWsHistoryState {
  entries: IHistoryEntry[];
  isLoading: boolean;
  isError: boolean;
}

interface IMessageHistoryState {
  byWsId: Record<string, IWsHistoryState>;

  fetchHistory: (wsId: string) => Promise<void>;
  addHistory: (wsId: string, message: string, tabId?: string) => Promise<void>;
  deleteHistory: (wsId: string, id: string) => Promise<void>;
}

const emptyState: IWsHistoryState = { entries: [], isLoading: false, isError: false };

const getWs = (state: IMessageHistoryState, wsId: string): IWsHistoryState =>
  state.byWsId[wsId] ?? emptyState;

const useMessageHistoryStore = create<IMessageHistoryState>((set, get) => ({
  byWsId: {},

  fetchHistory: async (wsId) => {
    set((s) => ({
      byWsId: { ...s.byWsId, [wsId]: { ...getWs(s, wsId), isLoading: true, isError: false } },
    }));
    try {
      const res = await fetch(`/api/message-history?wsId=${encodeURIComponent(wsId)}`);
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      set((s) => ({
        byWsId: { ...s.byWsId, [wsId]: { entries: data.entries, isLoading: false, isError: false } },
      }));
    } catch {
      set((s) => ({
        byWsId: { ...s.byWsId, [wsId]: { ...getWs(s, wsId), isLoading: false, isError: true } },
      }));
    }
  },

  addHistory: async (wsId, message, tabId) => {
    const trimmed = message.trim();
    if (!trimmed || trimmed.startsWith('/')) return;

    const tempId = `temp-${nanoid()}`;
    const tempEntry: IHistoryEntry = {
      id: tempId,
      message: trimmed,
      sentAt: new Date().toISOString(),
    };

    set((s) => {
      const prev = getWs(s, wsId);
      const filtered = prev.entries.filter((e) => e.message !== trimmed);
      const next = [tempEntry, ...filtered];
      return {
        byWsId: {
          ...s.byWsId,
          [wsId]: { ...prev, entries: next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next },
        },
      };
    });

    try {
      const res = await fetch('/api/message-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wsId, message: trimmed, ...(tabId ? { tabId } : {}) }),
      });
      if (res.ok) {
        const data = await res.json();
        set((s) => {
          const ws = getWs(s, wsId);
          return {
            byWsId: {
              ...s.byWsId,
              [wsId]: { ...ws, entries: ws.entries.map((e) => (e.id === tempId ? data.entry : e)) },
            },
          };
        });
      }
    } catch {
      // fire-and-forget
    }
  },

  deleteHistory: async (wsId, id) => {
    const backup = getWs(get(), wsId).entries;

    set((s) => {
      const ws = getWs(s, wsId);
      return {
        byWsId: { ...s.byWsId, [wsId]: { ...ws, entries: ws.entries.filter((e) => e.id !== id) } },
      };
    });

    try {
      const res = await fetch('/api/message-history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wsId, id }),
      });
      if (!res.ok) throw new Error('delete failed');
    } catch {
      set((s) => ({
        byWsId: { ...s.byWsId, [wsId]: { ...getWs(s, wsId), entries: backup } },
      }));
    }
  },
}));

export { emptyState };
export default useMessageHistoryStore;
