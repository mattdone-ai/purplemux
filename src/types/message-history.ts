export interface IHistoryEntry {
  id: string;
  message: string;
  /** The latest send; a re-send of the same text keeps the entry's first id (story 36). */
  sentAt: string;
  /** The tab it was last sent to; null or absent when the sender named none (entries before story 36). */
  tabId?: string | null;
}

export interface IMessageHistoryFile {
  entries: IHistoryEntry[];
}

export interface IMessageHistoryResponse {
  entries: IHistoryEntry[];
}

export interface IMessageHistoryAddResponse {
  entry: IHistoryEntry;
}

export interface IMessageHistoryDeleteResponse {
  success: boolean;
}
