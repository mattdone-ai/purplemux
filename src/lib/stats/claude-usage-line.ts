export interface IClaudeUsageLine {
  /** `message.id`, else the line's `uuid`, else ''. A non-empty id counts once per transcript. */
  messageId: string;
  model: string;
  sessionId: string;
  sidechain: boolean;
  /** UTC `YYYY-MM-DD` of the line's `timestamp`. */
  day: string;
  /** The line's `timestamp` in ms; null when it does not parse. */
  at: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
}

/**
 * The one reading of a Claude transcript line's token usage (ADR-0030). The stats
 * cache and the spend index both count through it, so they cannot disagree on
 * what a line costs.
 */
export const readClaudeUsage = (entry: Record<string, unknown>): IClaudeUsageLine | null => {
  if (entry.type !== 'assistant') return null;
  const timestamp = String(entry.timestamp ?? '');
  if (!timestamp) return null;
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const model = String(message.model ?? '');
  const usage = message.usage as Record<string, unknown> | undefined;
  // `<synthetic>` and similar placeholders are written by the client, not billed.
  if (!model || model.startsWith('<') || !usage) return null;

  const messageId = typeof message.id === 'string' ? message.id : '';
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
  const split = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheCreation1h = Number(split?.ephemeral_1h_input_tokens ?? 0);
  const cacheCreation5m = split?.ephemeral_5m_input_tokens != null
    ? Number(split.ephemeral_5m_input_tokens)
    : Math.max(0, cacheCreation - cacheCreation1h);

  return {
    messageId: messageId || String(entry.uuid ?? ''),
    model,
    sessionId: String(entry.sessionId ?? ''),
    sidechain: entry.isSidechain === true,
    day: timestamp.slice(0, 10),
    at: Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : null,
    input: Number(usage.input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0),
    cacheRead: Number(usage.cache_read_input_tokens ?? 0),
    cacheCreation,
    cacheCreation5m,
    cacheCreation1h,
  };
};
