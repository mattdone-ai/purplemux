import { brandCodedError } from '@/lib/coded-error';

// Standing orders (ADR-0041; ADR-HFL-05 decision 4): a rule the owner states once, kept as a file and
// written into the workspace prompt file every Claude tab loads. Pure: parse, render, validate, measure.

export const STANDING_ORDERS_MAX_BYTES = 8 * 1024;
export const STANDING_ORDER_ID = /^SO-([1-9]\d{0,5})$/;
export const STANDING_ORDER_STATES = ['active', 'struck'] as const;
export type TStandingOrderState = (typeof STANDING_ORDER_STATES)[number];

export const ORDER_LIMITS = { text: 600, source: 300, scope: 64, check: 200, reason: 300 } as const;

export interface IStandingOrder {
  id: string;
  text: string;
  /** The owner message it came from: its id and UTC date. */
  source: string;
  /** `fleet`, a workspace id, or a role such as `workers`. */
  scope: string;
  /** The hook or test that enforces it, or `prose` when nothing does yet. */
  check: string;
  state: TStandingOrderState;
  added: string;
  /** `<UTC time> — <reason>` once struck. */
  struck?: string;
}

export interface IStandingOrderFile {
  /** `fleet` or the workspace id. */
  owner: string;
  orders: IStandingOrder[];
}

export type TStandingOrderErrorCode = 'so-invalid' | 'so-too-large' | 'so-not-found' | 'so-unreadable' | 'so-struck' | 'forbidden';

export class StandingOrderError extends Error {
  constructor(readonly code: TStandingOrderErrorCode, message: string) {
    super(message);
    brandCodedError(this, 'StandingOrderError');
  }
}

const FIELDS = ['text', 'source', 'scope', 'check', 'state', 'added', 'struck'] as const;
type TField = (typeof FIELDS)[number];
// One line each: a newline would start a field of its own; a control or bidi character hides text.
const REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9 ,._:/-]*$/;

export const orderNumber = (id: string): number => Number(STANDING_ORDER_ID.exec(id)?.[1] ?? 0);

const oneLine = (field: string, value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new StandingOrderError('so-invalid', `${field}: required, one line of at most ${max} characters`);
  const text = value.trim();
  if (REFUSED.test(text)) throw new StandingOrderError('so-invalid', `${field}: one line, with no control or format character`);
  if ([...text].length > max) throw new StandingOrderError('so-invalid', `${field}: ${[...text].length} characters, at most ${max}`);
  return text;
};

export interface IOrderInput {
  text: unknown;
  source: unknown;
  scope?: unknown;
  check?: unknown;
}

/** A new order's fields, or a refusal naming the field. Scope defaults to the file's owner, check to `prose`. */
export const checkOrderInput = (input: IOrderInput, owner: string): Pick<IStandingOrder, 'text' | 'source' | 'scope' | 'check'> => {
  const scope = input.scope === undefined || input.scope === null || input.scope === '' ? owner : oneLine('scope', input.scope, ORDER_LIMITS.scope);
  if (!SCOPE.test(scope)) throw new StandingOrderError('so-invalid', 'scope: letters, digits, space and , . _ : / - only');
  return {
    text: oneLine('text', input.text, ORDER_LIMITS.text),
    source: oneLine('source', input.source, ORDER_LIMITS.source),
    scope,
    check: input.check === undefined || input.check === null || input.check === '' ? 'prose' : oneLine('check', input.check, ORDER_LIMITS.check),
  };
};

export const checkStrikeReason = (reason: unknown): string => oneLine('reason', reason, ORDER_LIMITS.reason);

const FILE_HEADER = '# Standing orders:';

const header = (owner: string): string => `${FILE_HEADER} ${owner}

The active orders below are written into the workspace prompt file of every Claude tab they reach
(ADR-0041). Change them with \`purplemux so add|strike\`; a hand edit must keep this layout.
`;

export const renderOrderFile = (file: IStandingOrderFile): string => {
  const blocks = file.orders.map((order) => [
    `## ${order.id}`,
    ...FIELDS.filter((field) => order[field] !== undefined).map((field) => `- ${field}: ${order[field]}`),
  ].join('\n'));
  return [header(file.owner), ...blocks].join('\n\n').concat('\n');
};

/** A file this module wrote, or a hand edit in its layout; anything else is refused, never read as empty. */
export const parseOrderFile = (text: string, owner: string, where: string): IStandingOrderFile => {
  // An empty or header-less file is a broken file, never a file with no orders (review r1, R3).
  if (!text.startsWith(FILE_HEADER)) throw new StandingOrderError('so-unreadable', `${where}: does not start with "${FILE_HEADER}"`);
  const orders: IStandingOrder[] = [];
  const chunks = text.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const [head, ...lines] = chunk.split('\n');
    const id = head.trim();
    if (!STANDING_ORDER_ID.test(id)) throw new StandingOrderError('so-unreadable', `${where}: "## ${id}" is not an order id SO-<n>`);
    const fields: Partial<Record<TField, string>> = {};
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
      const m = /^- ([a-z]+): (.*)$/.exec(line);
      if (!m || !(FIELDS as readonly string[]).includes(m[1])) throw new StandingOrderError('so-unreadable', `${where} ${id}: line "${line.slice(0, 80)}" is not "- <field>: <value>" with a field of ${FIELDS.join(', ')}`);
      fields[m[1] as TField] = m[2].trim();
    }
    for (const required of ['text', 'source', 'scope', 'check', 'state', 'added'] as const) {
      if (!fields[required]) throw new StandingOrderError('so-unreadable', `${where} ${id}: no ${required}`);
    }
    if (!(STANDING_ORDER_STATES as readonly string[]).includes(fields.state!)) {
      throw new StandingOrderError('so-unreadable', `${where} ${id}: state ${fields.state} is not one of ${STANDING_ORDER_STATES.join(', ')}`);
    }
    if (orders.some((o) => o.id === id)) throw new StandingOrderError('so-unreadable', `${where}: ${id} appears twice`);
    orders.push({
      id,
      text: fields.text!,
      source: fields.source!,
      scope: fields.scope!,
      check: fields.check!,
      state: fields.state as TStandingOrderState,
      added: fields.added!,
      ...(fields.struck ? { struck: fields.struck } : {}),
    });
  }
  return { owner, orders };
};

const orderLine = (order: IStandingOrder): string => `- **${order.id}** (${order.scope}; check: ${order.check}) ${order.text}`;

/** The prompt section for one workspace: the active fleet orders, then the workspace's own. Empty when none is active. */
export const renderPromptSection = (fleet: readonly IStandingOrder[], workspace: readonly IStandingOrder[]): string => {
  const active = [...fleet, ...workspace].filter((order) => order.state === 'active');
  if (!active.length) return '';
  return [
    '## Standing orders',
    '',
    "The owner's standing orders. Each holds until it is struck: act on it without asking again, and cite it",
    'as SO-<n> when it decides something. `purplemux so list` shows each with its source.',
    '',
    ...active.map(orderLine),
    '',
  ].join('\n');
};

export const sectionBytes = (fleet: readonly IStandingOrder[], workspace: readonly IStandingOrder[]): number =>
  Buffer.byteLength(renderPromptSection(fleet, workspace), 'utf8');

/** The one line a live tab is sent when an order changes (ADR-HFL-05 decision 4). */
export const orderChangeLine = (order: IStandingOrder, change: 'added' | 'struck', owner: string): string => {
  const text = order.text.length > 300 ? `${order.text.slice(0, 299)}…` : order.text;
  const tail = change === 'added'
    ? 'it holds until struck; purplemux so list shows every order'
    : 'it no longer holds';
  return `[purplemux standing order] ${order.id} ${change} (${owner}): ${text} — ${tail}`;
};
