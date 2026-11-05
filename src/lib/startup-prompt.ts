import type { IStartupPromptReading } from '@/types/status';
import type { TCliState, TStartupPrompt } from '@/types/timeline';

/**
 * The words an operator face uses for a Claude Code startup dialog (D14). Every face (the web, Mission
 * Control, `tab status`, `tab list`, the `tab send` refusal) reads this map, never the wire token. Pure
 * data: the client bundle imports it too.
 */
const STARTUP_PROMPT_LABEL: Readonly<Record<TStartupPrompt, string>> = Object.freeze({
  'folder-trust': 'the folder-trust prompt',
  'external-imports': 'the external CLAUDE.md imports prompt',
});

/** The neutral fallback for a kind this build does not know (a newer server, a damaged record). */
const UNKNOWN_STARTUP_PROMPT_LABEL = 'a Claude Code startup prompt';

export const isStartupPromptKind = (value: unknown): value is TStartupPrompt =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(STARTUP_PROMPT_LABEL, value);

export const startupPromptLabel = (kind: unknown): string =>
  isStartupPromptKind(kind) ? STARTUP_PROMPT_LABEL[kind] : UNKNOWN_STARTUP_PROMPT_LABEL;

/** One sentence for a person or a sender: what the tab waits at, and the two ways to clear it. */
export const startupPromptFix = (kind: unknown): string =>
  `the agent waits at ${startupPromptLabel(kind)}: answer it in the tab, `
  + 'or create the tab with --cwd under a workspace directory, which purplemux pre-trusts';

/**
 * The startup-prompt fields of a `tab status` / `tab list` row: the kind, its label and since when, only
 * for a tab in `startup-prompt`; nothing for every other state (an additive wire change, ADR-0004).
 */
export const startupPromptBody = (
  cliState: TCliState | null | undefined,
  reading: IStartupPromptReading | null | undefined,
): { startupPrompt?: TStartupPrompt | null; startupPromptLabel?: string; startupPromptSince?: number | null } => {
  if (cliState !== 'startup-prompt') return {};
  const kind = isStartupPromptKind(reading?.kind) ? reading.kind : null;
  return { startupPrompt: kind, startupPromptLabel: startupPromptLabel(kind), startupPromptSince: reading?.since ?? null };
};
