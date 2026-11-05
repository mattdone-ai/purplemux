import { useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import useMessageHistoryStore, { emptyState } from '@/hooks/use-message-history-store';
import type { IHistoryEntry } from '@/types/message-history';

interface IUseMessageHistoryOptions {
  wsId: string | undefined;
  /** The tab the input sends to: the history records it beside each message (story 36). */
  tabId?: string;
}

interface IUseMessageHistoryReturn {
  entries: IHistoryEntry[];
  isLoading: boolean;
  isError: boolean;
  fetchHistory: () => Promise<void>;
  addHistory: (message: string) => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
}

const useMessageHistory = ({ wsId, tabId }: IUseMessageHistoryOptions): IUseMessageHistoryReturn => {
  const { entries, isLoading, isError } = useMessageHistoryStore(
    useShallow((s) => (wsId ? (s.byWsId[wsId] ?? emptyState) : emptyState)),
  );

  const storeFetch = useMessageHistoryStore((s) => s.fetchHistory);
  const storeAdd = useMessageHistoryStore((s) => s.addHistory);
  const storeDelete = useMessageHistoryStore((s) => s.deleteHistory);

  const fetchHistory = useCallback(async () => {
    if (wsId) await storeFetch(wsId);
  }, [wsId, storeFetch]);

  const addHistory = useCallback(
    async (message: string) => {
      if (wsId) await storeAdd(wsId, message, tabId);
    },
    [wsId, tabId, storeAdd],
  );

  const deleteHistory = useCallback(
    async (id: string) => {
      if (wsId) await storeDelete(wsId, id);
    },
    [wsId, storeDelete],
  );

  useEffect(() => {
    if (wsId) storeFetch(wsId);
  }, [wsId, storeFetch]);

  return { entries, isLoading, isError, fetchHistory, addHistory, deleteHistory };
};

export default useMessageHistory;
