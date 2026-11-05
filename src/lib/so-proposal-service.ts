import { createHash } from 'crypto';
import type { ICaller } from '@/lib/caller';
import { normalisedOrderText } from '@/lib/curator-routing';
import { createLogger } from '@/lib/logger';
import type { IMissionItemOpener, IMissionOpenRunBinding, MissionControlStore, TMissionSoProposalInput } from '@/lib/mission-control-store';
import { SO_PROPOSAL_EVENT_PREFIX } from '@/lib/mission-control-validation';
import {
  EXPIRED_REASON, PROPOSAL_LIMITS, SO_PROPOSAL_TTL_MS, YES, buildProposalQuestion, proposalItemId, proposalOrderSource,
  proposalOutcomeLine, sourceNamesAnswer,
} from '@/lib/so-proposal';
import { StandingOrderError, checkOrderInput, oneLine, type IStandingOrderFile } from '@/lib/standing-orders';
import { addFleetOrderOnce, type IStandingOrderDeps } from '@/lib/standing-orders-service';
import { FLEET, measureAdd, readOrderFile } from '@/lib/standing-orders-store';
import { classifyWake } from '@/lib/wake-class';
import type { IMissionAnswer, IMissionSoProposalRecord, TSoProposalState } from '@/types/mission-control';
import type { IPortfolioSelection } from '@/types/portfolio';

// The runtime of a fleet standing-order proposal (ADR-0041 §1 amendment D7): the selected portfolio manager proposes,
// the server opens a `confirm` item of class `scope` with no default on the manager's own run, and the owner's Yes
// files the order as the server's admin caller. One step settles a record, from the answer route, the events route
// (a withdrawal) and the 60 s pass; the order files' host lock and a conditional record update make it file one
// order and write one audit row per outcome, whoever runs it.

const log = createLogger('so-proposal');

/** The server's admin caller, as the curator's strike uses it (ADR-0042 §2): the owner's answer is the authority. */
const SERVER: ICaller = {
  scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true,
};

export interface ISoProposalDeps {
  now: () => number;
  store: () => Pick<MissionControlStore,
    'openSoProposals' | 'soProposal' | 'attentionItem' | 'answerById' | 'settleSoProposal' | 'expireSoProposal' | 'listOpenRunBindings'>;
  /** The saved portfolio selection when the caller is its current launch tab (`selectedScrumMasterScope`), else null. */
  selection: (caller: ICaller) => Promise<IPortfolioSelection | null>;
  orchestratorTabId: (workspaceId: string) => Promise<string | null>;
  apply: (workspaceId: string, events: unknown[], opener: IMissionItemOpener | null,
    options: { serverPrefix: string; soProposals: ReadonlyMap<string, TMissionSoProposalInput> }) => Promise<unknown>;
  orders: IStandingOrderDeps;
  audit: (entry: Record<string, unknown>) => Promise<unknown>;
}

export interface IProposeInput {
  text: unknown;
  why: unknown;
  cites?: unknown;
  scope?: unknown;
  check?: unknown;
}

export interface IProposeResult {
  itemId: string;
  workspaceId: string;
  runId: string;
  workspaces: number;
  liveTabs: number;
  bytes: number;
}

const refused = (reason: 'duplicate' | 'open-proposal' | 'no-orchestrator-run', message: string): StandingOrderError =>
  new StandingOrderError('so-proposal-refused', `${reason}: ${message}`, reason);

const textSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const activeFleetTwin = (files: readonly IStandingOrderFile[], text: string): string | null => {
  const want = normalisedOrderText(text);
  return files.find((file) => file.owner === FLEET)?.orders.find((o) => o.state === 'active' && normalisedOrderText(o.text) === want)?.id ?? null;
};

const g = globalThis as unknown as { __ptSoProposeLock?: Promise<void> };

/** One propose at a time on the host: the open-proposal check and the open are one step. */
const withProposeLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptSoProposeLock ?? Promise.resolve();
  g.__ptSoProposeLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const optionalLine = (field: string, value: unknown, max: number): string | null =>
  (value === undefined || value === null || value === '' ? null : oneLine(field, value, max));

/**
 * `so propose` (D7 rules 1-4): only the selected portfolio manager's launch tab; every check before the item opens,
 * in the ADR's order; then one item on the manager's own bound run, with its record in the item's transaction.
 */
export const proposeStandingOrder = async (deps: ISoProposalDeps, caller: ICaller, input: IProposeInput): Promise<IProposeResult> => {
  const selection = caller.admin || !caller.tabId || !caller.workspaceId ? null : await deps.selection(caller);
  if (!selection || !caller.tabId || !caller.workspaceId) {
    throw new StandingOrderError('forbidden', caller.admin
      ? 'the admin token adds a fleet order with so add --fleet; only the selected portfolio manager proposes one'
      : 'only the launch tab of the selected portfolio manager proposes a fleet order');
  }
  const workspaceId = caller.workspaceId;
  const tabId = caller.tabId;
  const fields = checkOrderInput({ text: input.text, source: 'proposal', scope: input.scope, check: input.check }, FLEET);
  const why = oneLine('why', input.why, PROPOSAL_LIMITS.why);
  const cites = optionalLine('cites', input.cites, PROPOSAL_LIMITS.cites);
  return withProposeLock(async () => {
    const measure = await measureAdd(FLEET, fields, await deps.orders.workspaceIds(), deps.now());
    const twin = activeFleetTwin([await readOrderFile(FLEET)], fields.text);
    if (twin) throw refused('duplicate', `the active fleet order ${twin} already says this`);
    const want = normalisedOrderText(fields.text);
    const store = deps.store();
    const open = store.openSoProposals().find((record) => normalisedOrderText(record.text) === want);
    if (open) throw refused('open-proposal', `proposal ${open.itemId} of the same text is still open: wait for the owner's answer, or withdraw it`);
    const orchestratorTabId = await deps.orchestratorTabId(workspaceId);
    const run: IMissionOpenRunBinding | undefined = orchestratorTabId
      ? store.listOpenRunBindings(workspaceId).find((r) => r.binding.tabId === orchestratorTabId) : undefined;
    if (!orchestratorTabId || !run) {
      throw refused('no-orchestrator-run', `${workspaceId} has no open Mission Control run bound to its orchestrator: start or resume your Mission Control run, then propose again`);
    }
    const now = deps.now();
    const itemId = proposalItemId(fields.text, now);
    const liveTabs = deps.orders.liveAgentTabs(null).length;
    const eventId = `${SO_PROPOSAL_EVENT_PREFIX}open:${itemId}`;
    const event = {
      eventId,
      schemaVersion: 1,
      type: 'attention.opened',
      workspaceId,
      runId: run.runId,
      expectedRevision: 0,
      producerAt: now,
      bindingGeneration: run.binding.generation,
      payload: {
        itemId,
        ...buildProposalQuestion({ ...fields, why, cites, workspaceId, tabId },
          { workspaces: measure.workspaces, liveTabs, bytes: measure.bytes, bytesWorkspace: measure.workspaceId }),
        humanReview: {
          humanNeed: 'decision',
          humanReason: 'A fleet standing order reaches every Claude tab on this host; only your Yes files it.',
          handling: 'Proposed by the selected portfolio manager; the purplemux server opened the item and files the order on your Yes.',
          reviewerTabId: orchestratorTabId,
        },
      },
    };
    const record: TMissionSoProposalInput = { proposerTabId: tabId, text: fields.text, scope: fields.scope, checkName: fields.check, cites };
    // No opener: the item is the server's, so a NEEDS-DECISION line of the SM in the same turn opens its own item (§2).
    await deps.apply(workspaceId, [event], null, { serverPrefix: SO_PROPOSAL_EVENT_PREFIX, soProposals: new Map([[eventId, record]]) });
    await deps.audit({
      event: 'so-proposal-opened', itemId, workspaceId, tabId, identity: caller.identity, answerId: null, answerActor: null,
      orderId: null, reason: null, textSha256: textSha256(fields.text),
    });
    return { itemId, workspaceId, runId: run.runId, workspaces: measure.workspaces, liveTabs, bytes: measure.bytes };
  });
};

export type TSettleOutcome = Exclude<TSoProposalState, 'open'> | 'none';

interface IClose {
  state: Exclude<TSoProposalState, 'open'>;
  answer?: IMissionAnswer | null;
  orderId?: string | null;
  reason?: string | null;
}

/** Close the record once; only the step that closed it writes the audit row and the proposer's line. */
const close = async (deps: ISoProposalDeps, record: IMissionSoProposalRecord, outcome: IClose, now: number, closed?: boolean): Promise<TSettleOutcome> => {
  const won = closed ?? deps.store().settleSoProposal(record.itemId, {
    state: outcome.state, answerId: outcome.answer?.id ?? null, orderId: outcome.orderId ?? null, reason: outcome.reason ?? null, decidedAt: now,
  });
  if (!won) return 'none';
  await deps.audit({
    event: `so-proposal-${outcome.state}`, itemId: record.itemId, workspaceId: record.workspaceId, tabId: record.proposerTabId,
    // Only a launch-verified tab passes the selection check, so every proposer is a launch identity.
    identity: 'launch', answerId: outcome.answer?.id ?? null, answerActor: outcome.answer?.actor ?? null,
    orderId: outcome.orderId ?? null, reason: outcome.reason ?? null, textSha256: textSha256(record.text),
  });
  if (outcome.state === 'expired' || outcome.state === 'not-filed') {
    const text = proposalOutcomeLine(record.itemId, outcome.state === 'expired' ? { expired: true } : { notFiled: outcome.reason ?? 'refused' });
    await deps.orders.route({ workspaceId: record.workspaceId, tabId: record.proposerTabId, kind: 'standing-order', text, class: classifyWake('standing-order') })
      .catch((err: unknown) => log.warn({ itemId: record.itemId }, `proposal line not sent (${err instanceof Error ? err.message : String(err)})`));
  }
  return outcome.state;
};

const fileOnYes = async (deps: ISoProposalDeps, record: IMissionSoProposalRecord, answer: IMissionAnswer, now: number): Promise<TSettleOutcome> => {
  const source = proposalOrderSource(answer.id, record.itemId, answer.createdAt, record.workspaceId, record.proposerTabId);
  let orderId: string;
  try {
    const once = await addFleetOrderOnce(deps.orders, SERVER, { text: record.text, source, scope: record.scope, check: record.checkName }, (files) => {
      const filed = files.flatMap((file) => file.orders).find((order) => sourceNamesAnswer(order.source, answer.id));
      if (filed) return filed.id;
      const twin = activeFleetTwin(files, record.text);
      if (twin) throw refused('duplicate', `the active fleet order ${twin} already says this`);
      return null;
    });
    orderId = once.existing ?? once.result.order.id;
  } catch (err) {
    if (!(err instanceof StandingOrderError)) throw err;
    return close(deps, record, { state: 'not-filed', answer, reason: `${err.code}: ${err.message}`.slice(0, 300) }, now);
  }
  return close(deps, record, { state: 'filed', answer, orderId }, now);
};

/**
 * Settle one open proposal (D7 rules 6-7): Yes files the order; No or text alone declines; a cancel with no answer is a
 * withdrawal; an open item at 72 h expires. A transient failure throws and leaves the record open for the next pass.
 */
export const settleProposal = async (deps: ISoProposalDeps, itemId: string): Promise<TSettleOutcome> => {
  const store = deps.store();
  const record = store.soProposal(itemId);
  if (!record || record.state !== 'open') return 'none';
  const item = store.attentionItem(itemId);
  if (!item) return 'none';
  const now = deps.now();
  if (item.answerId) {
    // The owner's answer decides, also after the selection moved or the SM cancelled the item (rule 6).
    const answer = store.answerById(item.answerId);
    if (!answer) return 'none';
    if (answer.actor.startsWith('system:')) {
      return close(deps, record, { state: 'not-filed', answer, reason: `answer ${answer.id} came from ${answer.actor}, not the owner` }, now);
    }
    if (answer.optionIds.length === 1 && answer.optionIds[0] === YES) return fileOnYes(deps, record, answer, now);
    return close(deps, record, { state: 'declined', answer }, now);
  }
  if (item.state === 'cancelled') return close(deps, record, { state: 'withdrawn', reason: item.resolution }, now);
  if (item.state === 'open' && now - record.createdAt >= SO_PROPOSAL_TTL_MS) {
    return close(deps, record, { state: 'expired', reason: EXPIRED_REASON }, now, store.expireSoProposal(itemId, EXPIRED_REASON, now));
  }
  return 'none';
};

/** The 60 s pass in the ADR-0031 §6 tick: every open record, whatever the auto-answer key holds. */
export const runSoProposalPass = async (deps: ISoProposalDeps): Promise<Array<{ itemId: string; outcome: TSettleOutcome }>> => {
  const settled: Array<{ itemId: string; outcome: TSettleOutcome }> = [];
  for (const record of deps.store().openSoProposals()) {
    try {
      const outcome = await settleProposal(deps, record.itemId);
      if (outcome !== 'none') settled.push({ itemId: record.itemId, outcome });
    } catch (err) {
      log.warn({ itemId: record.itemId }, `proposal not settled this pass (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return settled;
};

export const soProposalDeps = async (): Promise<ISoProposalDeps> => {
  const [{ getMissionControlStore }, { applyMissionEventBatch }, { getWorkspaceById }, { selectedScrumMasterScope }, { standingOrderDeps }, { appendCoordinationAudit }] =
    await Promise.all([
      import('@/lib/mission-control-store'),
      import('@/lib/mission-control-events'),
      import('@/lib/workspace-store'),
      import('@/lib/scrum-master-access'),
      import('@/lib/standing-orders-http'),
      import('@/lib/coordination-audit'),
    ]);
  return {
    now: () => Date.now(),
    store: getMissionControlStore,
    selection: (caller) => selectedScrumMasterScope(caller.scope),
    orchestratorTabId: async (workspaceId) => (await getWorkspaceById(workspaceId))?.orchestration?.orchestratorTabId ?? null,
    apply: (workspaceId, events, opener, options) => applyMissionEventBatch(workspaceId, events, opener, options),
    orders: standingOrderDeps(),
    audit: appendCoordinationAudit,
  };
};

/** The answer route's and the events route's step for one item; never throws into the caller. */
export const settleProposalSoon = (itemId: string): void => {
  void soProposalDeps().then((deps) => settleProposal(deps, itemId))
    .catch((err: unknown) => log.warn({ itemId }, `proposal step failed; the 60 s pass retries (${err instanceof Error ? err.message : String(err)})`));
};
