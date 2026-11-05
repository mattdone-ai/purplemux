import { createHash } from 'crypto';
import { SPOT_CHECK_SIZE } from '@/lib/curator';
import { OWNER_MESSAGE_CLASSES, curatorLabelName } from '@/lib/curator-tasks';
import { QUESTION_LIMITS } from '@/lib/mission-question-format';
import { looksLikeSecret } from '@/lib/secret-patterns';
import type { TSpotCheckVerdict } from '@/types/curator';

// The owner's spot check of 30 gold labels (AC 6; consult ruling of 2026-11-03): one format-2 `multi` item.

export const SPOT_CHECK_OPTIONS = {
  allRight: 'all-right',
  someWrong: 'some-wrong',
  cantJudge: 'cant-judge',
} as const;

export const SPOT_CHECK_EXCERPT_CHARS = 90;

/** Every spot-check item id starts so: the curator never matches, queues or labels its own item (review r2 F6). */
export const SPOT_CHECK_ITEM_PREFIX = 'curator-spot-check-';
export const isSpotCheckItem = (itemId: string): boolean => itemId.startsWith(SPOT_CHECK_ITEM_PREFIX);

export interface ISpotCheckCandidate {
  id: string;
  label: string;
  text: string;
}

export interface ISpotCheckDraw {
  picked: ISpotCheckCandidate[];
  perClass: Record<string, number>;
  /** Candidates skipped because the full message matched a credential pattern. */
  skippedSecret: number;
}

const order = (id: string): string => createHash('sha256').update(`spot-check:${id}`).digest('hex');

/**
 * 30 labels, an even share per gold class. A message whose full text looks like a credential is skipped,
 * never redacted; a short class is filled from the others, and the counts say what was drawn.
 */
export const drawSpotCheck = (candidates: readonly ISpotCheckCandidate[], size = SPOT_CHECK_SIZE): ISpotCheckDraw => {
  const clean = candidates.filter((c) => !looksLikeSecret(c.text));
  const byClass = new Map<string, ISpotCheckCandidate[]>(OWNER_MESSAGE_CLASSES.map((label) => [label, []]));
  for (const candidate of [...clean].sort((a, b) => order(a.id).localeCompare(order(b.id)))) {
    byClass.get(candidate.label)?.push(candidate);
  }
  const share = Math.floor(size / OWNER_MESSAGE_CLASSES.length);
  const picked: ISpotCheckCandidate[] = [];
  for (const label of OWNER_MESSAGE_CLASSES) picked.push(...byClass.get(label)!.splice(0, share));
  for (const label of OWNER_MESSAGE_CLASSES) {
    const pool = byClass.get(label)!;
    while (picked.length < size && pool.length) picked.push(pool.shift()!);
  }
  const perClass = Object.fromEntries(OWNER_MESSAGE_CLASSES.map((label) => [label, picked.filter((p) => p.label === label).length]));
  return { picked, perClass, skippedSecret: candidates.length - clean.length };
};

/** The matcher's spot check: up to `size` true-positive covered rows, none that looks like a credential. */
export const drawMatchSpotCheck = (candidates: readonly ISpotCheckCandidate[], size: number): ISpotCheckDraw => {
  const clean = candidates.filter((c) => !looksLikeSecret(c.text)).sort((a, b) => order(a.id).localeCompare(order(b.id)));
  const picked = clean.slice(0, size);
  const perClass: Record<string, number> = {};
  for (const p of picked) perClass[p.label] = (perClass[p.label] ?? 0) + 1;
  return { picked, perClass, skippedSecret: candidates.length - clean.length };
};

const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

export const excerpt = (text: string, max = SPOT_CHECK_EXCERPT_CHARS): string => {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};

/** `n. "<excerpt>" -> <label name>`, every excerpt shortened alike until the list fits Mission Control's context. */
export const spotCheckContext = (picked: readonly ISpotCheckCandidate[], intro: string): string => {
  for (let max = SPOT_CHECK_EXCERPT_CHARS; max >= 10; max -= 5) {
    const lines = picked.map((p, i) => `${i + 1}. "${excerpt(p.text, max)}" -> ${curatorLabelName(p.label)}`);
    const context = [intro, ...lines].join('\n');
    if (context.length <= QUESTION_LIMITS.context) return context;
  }
  throw new Error('spot-check list does not fit the Mission Control context limit');
};

export const SPOT_CHECK_DECISION = 'Which of these 30 message labels are wrong?';

export type TSpotCheckKind = 'owner-messages' | 'standing-order-matches';

/** One format-2 multi item (consult of 2026-11-03): owner-message gold labels, or the matcher's covered rows (ruling 1). */
export const buildSpotCheckQuestion = (picked: readonly ISpotCheckCandidate[], kind: TSpotCheckKind = 'owner-messages') => {
  const n = picked.length;
  const owner = kind === 'owner-messages';
  return {
    formatVersion: 2 as const,
    kind: 'question' as const,
    title: owner ? 'Curator: spot-check 30 message labels' : `Curator: spot-check ${n} standing-order matches`,
    decision: owner ? SPOT_CHECK_DECISION : `Which of these ${n} standing-order matches are wrong?`,
    whyNow: owner
      ? 'The local curator is scored against these labels before it may route anything (your OD-9 yes).'
      : 'Before the curator may answer bookkeeping asks as covered by a standing order (your OD-9 yes).',
    answerType: 'multi' as const,
    options: [
      { id: SPOT_CHECK_OPTIONS.allRight, label: owner ? 'All 30 labels are right' : `All ${n} matches are right`, recommended: false, needsText: false },
      { id: SPOT_CHECK_OPTIONS.someWrong, label: 'Some are wrong: type their numbers', recommended: false, needsText: true },
      { id: SPOT_CHECK_OPTIONS.cantJudge, label: "I can't judge some: type their numbers", recommended: false, needsText: true },
    ],
    context: spotCheckContext(picked, owner
      ? 'Each line: your message (cut to fit) and the class it was given. Both lists: "wrong: 3,7; unsure: 12".'
      : 'Each line: an agent\'s ask (cut to fit) and the order the curator matched. Both lists: "wrong: 3,7; unsure: 12".'),
    storyIds: ['16-curator-service-and-eval-gate'],
    blockingScope: 'none' as const,
    canContinue: true,
  };
};

const answeredAt = (answer: ISpotCheckAnswer) => (answer.createdAt === undefined ? {} : { answeredAt: answer.createdAt });

const numbersIn = (text: string): number[] | null => {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d{1,2}$/.test(p))) return null;
  return parts.map(Number);
};

export interface ISpotCheckAnswer {
  optionIds: readonly string[];
  text: string;
  /** Who answered: a `system:` actor (the bookkeeping rule) is never the owner (review r1 F10). */
  actor: string;
  createdAt?: number;
}

/** The owner's answer, read by the consult's grammar; anything else is unreadable and counts as no answer. */
export const readSpotCheckAnswer = (answer: ISpotCheckAnswer | null, numbers: Record<string, string>): TSpotCheckVerdict => {
  if (!answer) return { state: 'unanswered' };
  if (answer.actor.startsWith('system:')) return { state: 'unreadable', reason: `answered by ${answer.actor}, not the owner` };
  const ids = new Set(answer.optionIds);
  const text = answer.text.trim();
  const size = Object.keys(numbers).length;
  if (!ids.size) return { state: 'unreadable', reason: 'text with no option selected' };
  if (ids.has(SPOT_CHECK_OPTIONS.allRight)) {
    if (ids.size > 1) return { state: 'unreadable', reason: '"all right" selected with another option' };
    return { state: 'answered', disputed: [], unjudged: [], wrongShare: 0, judged: size, ...answeredAt(answer) };
  }
  let wrong: number[] = [];
  let unsure: number[] = [];
  const both = ids.has(SPOT_CHECK_OPTIONS.someWrong) && ids.has(SPOT_CHECK_OPTIONS.cantJudge);
  if (both) {
    const match = /^wrong:\s*([\d,\s]+);\s*unsure:\s*([\d,\s]+)$/i.exec(text);
    const w = match ? numbersIn(match[1]) : null;
    const u = match ? numbersIn(match[2]) : null;
    if (!w || !u) return { state: 'unreadable', reason: 'both options selected: the text must read "wrong: 3,7; unsure: 12"' };
    wrong = w;
    unsure = u;
  } else {
    const list = numbersIn(text);
    if (!list) return { state: 'unreadable', reason: 'the selected option needs its numbers, e.g. "3, 7, 12"' };
    if (ids.has(SPOT_CHECK_OPTIONS.someWrong)) wrong = list;
    else if (ids.has(SPOT_CHECK_OPTIONS.cantJudge)) unsure = list;
    else return { state: 'unreadable', reason: 'no known option selected' };
  }
  const outside = [...wrong, ...unsure].filter((n) => !Object.hasOwn(numbers, String(n)));
  if (outside.length) return { state: 'unreadable', reason: `number outside 1-${size}: ${outside.join(', ')}` };
  const twice = wrong.filter((n) => unsure.includes(n));
  if (twice.length) return { state: 'unreadable', reason: `in both lists: ${twice.join(', ')}` };
  const disputed = [...new Set(wrong)].map((n) => numbers[String(n)]);
  const unjudged = [...new Set(unsure)].map((n) => numbers[String(n)]);
  const judged = size - unjudged.length;
  return { state: 'answered', disputed, unjudged, judged, wrongShare: judged === 0 ? 1 : disputed.length / judged, ...answeredAt(answer) };
};
