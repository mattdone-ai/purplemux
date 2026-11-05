import { ATTENTION_CLASSES } from '@/lib/attention-class';
import { QUESTION_LIMITS } from '@/lib/mission-question-format';
import type { TAttentionClass } from '@/types/mission-control';

// A turn that ends `NEEDS-DECISION:` becomes a Mission Control item (ADR-HFL-05 decision 5, ADR-0041).
// Pure: the end line in, a question-format-2 payload out (ADR-0037). The server validates it like any
// producer's question.

const MARKER = 'NEEDS-DECISION:';
const TAG = new RegExp(`^\\[(${ATTENTION_CLASSES.join('|')})\\]\\s*`, 'i');
// `(a) ... (b) ...` or `(1) ... (2) ...`, each mark at the start or after a space.
const OPTION_MARK = /(?:^|\s)\(([a-d]|[1-4])\)\s+/g;
const LETTERS = ['a', 'b', 'c', 'd'];
const DIGITS = ['1', '2', '3', '4'];

export interface INeedsDecisionLine {
  /** From the optional `[money|irreversible|scope|bookkeeping]` tag; null is unclassified. */
  class: TAttentionClass | null;
  /** The question: the line without its marker, tag and options. */
  question: string;
  /** Two to four options the line lists as `(a) ... (b) ...`; empty when it lists none. */
  options: Array<{ id: string; label: string }>;
}

const clipAtWord = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export const isNeedsDecisionLine = (line: string | undefined): line is string => !!line && line.trim().startsWith(MARKER);

/** The line without its marker and class tag, whitespace collapsed: the owner push's text (ADR-0041 §2). */
export const needsDecisionText = (line: string): string =>
  line.trim().slice(MARKER.length).trim().replace(TAG, '').replace(/\s+/g, ' ').trim();

/** The marks must run a, b, c… (or 1, 2, 3…) from the first; anything else is prose, not options. */
const splitOptions = (body: string): { question: string; options: Array<{ id: string; label: string }> } => {
  const marks = [...body.matchAll(OPTION_MARK)];
  if (marks.length < 2 || marks.length > 4) return { question: body, options: [] };
  const series = /\d/.test(marks[0][1]) ? DIGITS : LETTERS;
  if (marks.some((mark, i) => mark[1].toLowerCase() !== series[i])) return { question: body, options: [] };
  const options = marks.map((mark, i) => {
    const start = mark.index! + mark[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : body.length;
    return { id: series[i], label: body.slice(start, end).trim().replace(/[;,]$/, '').trim() };
  });
  if (options.some((option) => !option.label)) return { question: body, options: [] };
  return { question: body.slice(0, marks[0].index!).trim(), options };
};

export const parseNeedsDecisionLine = (line: string): INeedsDecisionLine => {
  let body = line.trim().slice(MARKER.length).trim();
  const tag = TAG.exec(body);
  if (tag) body = body.slice(tag[0].length).trim();
  const { question, options } = splitOptions(body);
  return {
    class: tag ? (tag[1].toLowerCase() as TAttentionClass) : null,
    question: question || body,
    options,
  };
};

export interface INeedsDecisionSource {
  line: string;
  /** False when the start of the line may be missing (`lastTurnLine`): options are then never read from it. */
  complete?: boolean;
  workspaceId: string;
  tabId: string;
  tabName: string;
}

/**
 * The item's question. `answerType: text` when the line gives no options, or when an option label is
 * longer than a card shows (60 chars): the options then stay in the context, verbatim, never cut.
 */
export const buildNeedsDecisionQuestion = (source: INeedsDecisionSource): Record<string, unknown> => {
  const parsed = parseNeedsDecisionLine(source.line);
  const complete = source.complete !== false;
  const fits = complete && parsed.options.length >= 2 && parsed.options.every((option) => option.label.length <= QUESTION_LIMITS.label);
  const name = source.tabName || source.tabId;
  const context = [
    `The tab **${name}** (\`${source.tabId}\`) ended its turn on this line:`,
    '',
    `> ${source.line.trim()}`,
    '',
    ...(complete ? [] : ['The line reached the harness clipped, so its options were not read: the whole question is in the pane.', '']),
    `Its pane: \`purplemux tab result -w ${source.workspaceId} ${source.tabId}\`. Your answer goes to the workspace orchestrator, which owns the run and relays it.`,
  ].join('\n');
  return {
    formatVersion: 2,
    kind: 'question',
    title: clipAtWord(`${name} needs a decision`, QUESTION_LIMITS.title),
    decision: clipAtWord(parsed.question.replace(/\s+/g, ' '), QUESTION_LIMITS.decision),
    whyNow: clipAtWord(`${name} stopped its turn on this decision; it waits for your answer.`, QUESTION_LIMITS.whyNow),
    answerType: fits ? 'single' : 'text',
    options: fits ? parsed.options.map((option) => ({ ...option, recommended: false, needsText: false })) : [],
    context: context.slice(0, QUESTION_LIMITS.context),
    storyIds: [],
    blockingScope: 'story',
    canContinue: false,
    ...(parsed.class ? { class: parsed.class } : {}),
  };
};
