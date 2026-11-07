import { ATTENTION_CLASSES } from '@/lib/attention-class';
import { QUESTION_LIMITS } from '@/lib/mission-question-format';
import type { TAttentionClass } from '@/types/mission-control';

// A turn that ends `NEEDS-DECISION:` becomes a Mission Control item (ADR-HFL-05 decision 5, ADR-0041).
// Pure: the end line in, a question-format-2 payload out (ADR-0037). The server validates it like any
// producer's question.

const MARKER = 'NEEDS-DECISION:';
const TAG = new RegExp(`^\\[(${ATTENTION_CLASSES.join('|')})\\]\\s*`, 'i');
/**
 * `[new]` (story PM-2, D50): the line asks a question other than the tab's open item, so it opens its own item instead
 * of revising that one. It may stand before or after the class tag; it is never part of the question or its line key.
 */
const NEW_MARK = /^\[new\]\s*/i;
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

/** The text after the marker without its leading `[new]` and class tags, in either order, and whether `[new]` was there. */
const splitHead = (line: string): { body: string; tag: RegExpExecArray | null; isNew: boolean } => {
  let body = line.trim().slice(MARKER.length).trim();
  let tag: RegExpExecArray | null = null;
  let isNew = false;
  for (let i = 0; i < 2; i += 1) {
    const mark = NEW_MARK.exec(body);
    if (mark && !isNew) {
      isNew = true;
      body = body.slice(mark[0].length).trim();
      continue;
    }
    const found: RegExpExecArray | null = tag ? null : TAG.exec(body);
    if (!found) break;
    tag = found;
    body = body.slice(found[0].length).trim();
  }
  return { body, tag, isNew };
};

/** Whether the line carries the `[new]` marker after `NEEDS-DECISION:` (story PM-2): it asks a new question. */
export const needsDecisionIsNew = (line: string): boolean => isNeedsDecisionLine(line) && splitHead(line).isNew;

/**
 * The line without its `[new]` marker, the rest unchanged: the line key of `[new] Q` and of `Q` is one key, so a `[new]`
 * line repeated while it waits finds its own item (story PM-2).
 */
export const withoutNewMark = (line: string): string => {
  if (!isNeedsDecisionLine(line)) return line;
  const trimmed = line.trim();
  const rest = trimmed.slice(MARKER.length);
  const lead = rest.length - rest.trimStart().length;
  const head = rest.trimStart();
  const direct = NEW_MARK.exec(head);
  if (direct) return `${MARKER}${rest.slice(0, lead)}${head.slice(direct[0].length)}`;
  const tag = TAG.exec(head);
  const afterTag = tag ? NEW_MARK.exec(head.slice(tag[0].length)) : null;
  if (tag && afterTag) return `${MARKER}${rest.slice(0, lead)}${tag[0]}${head.slice(tag[0].length + afterTag[0].length)}`;
  return trimmed;
};

/** Whether the text after the marker asks something: it holds a question mark (D28 v2 addendum: no `?`, no item). */
export const needsDecisionAsks = (line: string): boolean => /[?？]/.test(line.trim().slice(MARKER.length));

/** The line without its marker and class tag, whitespace collapsed: the owner push's text (ADR-0041 §2). */
export const needsDecisionText = (line: string): string => splitHead(line).body.replace(/\s+/g, ' ').trim();

/**
 * The owner push's detail (ADR-0041 §2 (ii)): `<tab name or id> · <workspace name or id>: <needsDecisionText>`. The push
 * goes out only when no item opened, so it never names one. Exported for the phone's fixture generator (story 37).
 */
export const needsDecisionPushDetail = (source: {
  tabId: string; tabName?: string; workspaceId: string; workspaceName?: string; line: string;
}): string => `${source.tabName || source.tabId} · ${source.workspaceName || source.workspaceId}: ${needsDecisionText(source.line)}`;

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
  const { body, tag } = splitHead(line);
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
  /** Why the owner gets a question a tab with a reportsTo asked (D28 review r1, 1); stated in the context. */
  fallbackReason?: string;
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
    ...(source.fallbackReason ? [`It reached you because ${source.fallbackReason}.`, ''] : []),
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
