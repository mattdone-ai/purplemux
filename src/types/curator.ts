/** The classifiers: each scored on a labelled set by the Clopper-Pearson gate (ADR-0038 §5). */
export type TCuratorLabelTask = 'classify-owner-message' | 'flag-owner-question' | 'match-standing-order';
/** Every curator task; `reshape-question` proposes a question draft and has its own gate (ADR-HFL-11 rule 3). */
export type TCuratorTask = TCuratorLabelTask | 'reshape-question';

/** `shadow`: labels are logged and nothing routes. `routing`: the label routes, in a workspace that opts in (ADR-0038 §5). */
export type TCuratorTaskState = 'shadow' | 'routing';

/** What came of one call: only `labelled` carries the model's label; every other outcome routes by the rules. */
export type TCuratorOutcome = 'labelled' | 'timeout' | 'down' | 'error' | 'unparsable' | 'dropped';

export type TCuratorHealthState = 'up' | 'down' | 'unknown';

export interface ICuratorHealth {
  state: TCuratorHealthState;
  /** Why it is down: `tunnel` (no answer on the local port) or `model` (Ollama answers without the model). */
  reason: string | null;
  /** When the state last changed; null before the first probe. */
  since: number | null;
  checkedAt: number | null;
}

/** One call, as `tab_events` records it (kind `curator`, class `log`): never the input text, only the quoted span. */
export interface ICuratorCallRecord {
  task: TCuratorTask;
  model: string;
  promptVersion: string;
  /** The labelled-set id of the input, for the blind label pass; null when the caller has none (codex, grok). */
  sourceId: string | null;
  /** The served model's digest at the call (from /api/tags); null when no probe has answered. */
  modelDigest: string | null;
  outcome: TCuratorOutcome;
  /** The model's label; null unless `labelled`. */
  label: string | null;
  /** The rules' label for the same input: what routes when the curator does not, and the shadow agreement's other side. */
  rulesLabel: string;
  /** The model's quoted span, as returned; null when it gave none or it was withheld. */
  span: string | null;
  /** The span was dropped because the input or the span looks like a credential. */
  withheld?: true;
  /** Whether the span occurs in the input (whitespace-normalised). */
  spanFound: boolean;
  latencyMs: number | null;
  /** Time spent queued before the call started. */
  waitedMs: number;
  /** Estimated tokens cut from the head of the input; 0 when it fitted. */
  cutTokens: number;
  promptTokens: number | null;
  /** Where the label that would route came from. */
  source: 'curator' | 'rules';
  error?: string;
  /** reshape-question: the sha256 of the reshaped draft, never its text. */
  draftSha?: string;
}

export interface ICuratorResult {
  record: ICuratorCallRecord;
  /** The label to route: the model's when `labelled`, else the rules'. */
  routed: string;
  /** What the task's reader returned beside the label (reshape-question: the verdict and the draft); never recorded. */
  payload?: unknown;
}

export interface ICuratorTaskStatus {
  task: TCuratorTask;
  state: TCuratorTaskState;
  promptVersion: string;
  shadowSince: number | null;
  /** When promote may first pass the 72 h condition; null before the client ran live. */
  shadowEndsAt: number | null;
  promotedAt: number | null;
  /** The prompt version the gate passed on; a different live prompt version is back in shadow. */
  promotedPromptVersion: string | null;
}

export interface ICuratorAgreement {
  task: TCuratorTask;
  calls: number;
  /** Calls with a model label, compared with the rules' label. */
  compared: number;
  agreed: number;
}

export interface ICuratorBoard {
  health: ICuratorHealth;
  tasks: Array<ICuratorTaskStatus & { routingHere: boolean }>;
  /** Shadow agreement in this workspace over the last 72 h; null when the ledger cannot be read. */
  agreement: ICuratorAgreement[] | null;
}

export interface ICuratorEvalRow {
  id: string;
  gold: string;
  /** null: no model label (timeout, error, unparsable, down). */
  predicted: string | null;
  outcome: TCuratorOutcome | 'unresolved';
  latencyMs: number | null;
}

export interface ICuratorClassScore {
  label: string;
  support: number;
  predicted: number;
  truePositives: number;
  /** null when nothing was predicted into the class: not measured, never 0 or 1. */
  precision: number | null;
  recall: number | null;
}

export interface ICuratorGateCheck {
  label: string;
  metric: 'precision' | 'recall';
  threshold: number;
  /** The point estimate, successes / trials. */
  measured: number | null;
  successes: number;
  /** Predictions into the class (precision) or its gold support (recall). */
  trials: number;
  /** The one-sided 95% Clopper-Pearson lower bound; null with no trials. It alone decides `pass`. */
  lowerBound: number | null;
  /** Trials a run with no error needs to pass. */
  minTrials: number;
  pass: boolean;
}

export interface ICuratorScore {
  classes: ICuratorClassScore[];
  checks: ICuratorGateCheck[];
  pass: boolean;
}

export interface ICuratorEvalResult {
  task: TCuratorLabelTask;
  promptVersion: string;
  model: string;
  split: 'holdout' | 'train' | 'all';
  startedAt: number;
  finishedAt: number;
  /** Items scored. */
  n: number;
  /** Per-class counts: all the held-out run keeps, so no per-id prediction is stored for it (review r1 F7). */
  counts: Array<{ label: string; support: number; predicted: number; truePositives: number }>;
  /** Per-id rows: kept for the train and whole-set runs only. */
  rows?: ICuratorEvalRow[];
  /** Ids the set names whose text is no longer readable, inside the 30-day source horizon. */
  unresolved: number;
  /** Unresolved ids older than the horizon: reported, left out of every denominator. */
  agedOut: number;
  unresolvedByClass: Record<string, number>;
  /** Ids left out because a labelled shadow row of this version holds them, or the owner disputed their gold. */
  excluded: { shadow: number; disputed: number };
  /** The spot-check answer the run applied (classify-owner-message). */
  spotCheck: { itemId: string; answeredAt: number } | null;
  /** Why the run refused to score: more than 10% unresolved overall or in a gated class. null: it scored. */
  refused: string | null;
  outcomes: Partial<Record<ICuratorEvalRow['outcome'], number>>;
  latency: { p50: number | null; p90: number | null };
  score: ICuratorScore;
  rules: ICuratorScore;
}

export interface ICuratorEvalProgress {
  task: TCuratorTask;
  running: boolean;
  done: number;
  total: number;
  startedAt: number;
  error: string | null;
}

export interface ICuratorKoditWindow {
  from: number;
  to: number;
  docsPerHour: number | null;
  summariesPerHour: number | null;
  samples: number;
}

export interface ICuratorKoditMeasure {
  before: ICuratorKoditWindow;
  after: ICuratorKoditWindow | null;
  /** Fall in docs per hour, before to after, as a fraction; null until the after window is measured. */
  drop: number | null;
  measuredAt: number;
}

export interface ICuratorState {
  version: 1;
  /** First start of a server carrying the client: the shadow clock's start (ADR-0038 §5). */
  liveSince: number | null;
  tasks: Partial<Record<TCuratorTask, {
    state: TCuratorTaskState;
    promotedAt: number | null;
    promotedPromptVersion: string | null;
    /** Each prompt version's first shadow call outside the evaluation: its 72 h clock (consult 16-promote-gate, ruling 2). */
    shadowSince?: Record<string, number>;
  }>>;
  kodit: ICuratorKoditMeasure | null;
  /** Set by the kodit rule (ADR-0038 §7): calls start at most this often. */
  rateLimitMs: number;
}

export type TSpotCheckVerdict =
  | { state: 'unanswered' }
  | { state: 'unreadable'; reason: string }
  | { state: 'answered'; disputed: string[]; unjudged: string[]; wrongShare: number; judged: number; answeredAt?: number };

export interface ISpotCheckFile {
  task: TCuratorLabelTask;
  itemId: string;
  workspaceId: string;
  openedAt: number;
  /** Item number (1-30) to the labelled set's message id. */
  numbers: Record<string, string>;
  perClass: Record<string, number>;
}
