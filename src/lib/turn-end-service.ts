import path from 'path';
import type { ICaller } from '@/lib/caller';
import { brandCodedError } from '@/lib/coded-error';
import { TURN_VERDICTS, cleanReason, seatRoleOf, type ITurnEndRow, type TSeatRole, type TTurnVerdict } from '@/lib/turn-end-row';
import type { TurnEndsTable } from '@/lib/turn-ends-store';
import {
  gateTreeValidator,
  gateVerdictValidator,
  lastGateRun,
  rangeValidator,
  resolveEvidence,
  type IEvidenceReader,
  type IResolvedEvidence,
  type IValidationContext,
} from '@/lib/worker-event-validators';
import type { ICheckFailure, IEventScope, TWorkerEvent } from '@/types/worker-event';

// `purplemux done` (F6, folding in F10 step 2; design check (2) ruling, 2026-11-10): one typed turn-end row per worker
// turn, checked at write time with the ADR-0043 validators (range, gate-verdict, gate-tree; nothing else runs).

export type TTurnEndErrorCode = 'turn-end-invalid' | 'turn-end-refused' | 'turn-end-no-turn' | 'forbidden';

export class TurnEndError extends Error {
  constructor(readonly code: TTurnEndErrorCode, message: string, readonly details: { failures?: ICheckFailure[] } = {}) {
    super(message);
    brandCodedError(this, 'TurnEndError');
  }
}

const invalid = (message: string) => new TurnEndError('turn-end-invalid', message);

export interface ITurnEndTab {
  workspaceId: string;
  panelType: string | undefined;
  /** Set for a remote tab (ADR-0022): the server cannot read its evidence. */
  host: string | undefined;
  agentSessionId: string | null | undefined;
}

export interface ITurnEndDeps {
  now: () => number;
  table: () => TurnEndsTable;
  tab: (workspaceId: string, tabId: string) => ITurnEndTab | null;
  scopeOf: (workspaceId: string, tabId: string) => Promise<IEventScope | null>;
  roots: (workspaceId: string) => Promise<string[]>;
  reader: IEvidenceReader;
}

export interface IDoneInput {
  verdict?: unknown;
  story?: unknown;
  head?: unknown;
  gateLog?: unknown;
  reason?: unknown;
  /** The caller's working directory: the repo is its git top level. */
  cwd?: unknown;
}

/** The scope's story grammar (worker-events-service.ts). */
const STORY_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const NEEDS_GATE: ReadonlySet<TTurnVerdict> = new Set<TTurnVerdict>(['DONE', 'READY-TO-MERGE']);
const NEEDS_REASON: ReadonlySet<TTurnVerdict> = new Set<TTurnVerdict>(['BLOCKED', 'NEEDS-DECISION']);

const failureLines = (failures: readonly ICheckFailure[]): string =>
  failures.map((f) => `${f.check}: measured ${f.measured}; expected ${f.expected}`).join('\n');

export class TurnEndService {
  constructor(private readonly deps: ITurnEndDeps) {}

  /** Write the caller tab's row for its current turn, or refuse with every measured defect. */
  async done(caller: ICaller, input: IDoneInput): Promise<ITurnEndRow> {
    const { workspaceId, tabId } = caller;
    if (!workspaceId || !tabId || caller.admin) throw new TurnEndError('forbidden', 'purplemux done runs in an agent tab: the caller has no tab identity');
    const tab = this.deps.tab(workspaceId, tabId);
    if (!tab || !tab.panelType || tab.panelType === 'terminal' || tab.panelType === 'web-browser' || tab.panelType === 'diff') {
      throw new TurnEndError('forbidden', `tab ${tabId} is not an agent tab this server knows`);
    }
    if (tab.host) throw new TurnEndError('forbidden', `tab ${tabId} runs on ${tab.host}: the server cannot read a remote tab's evidence (ADR-0043 §5)`);
    const sessionId = tab.agentSessionId ?? null;
    if (!sessionId) throw new TurnEndError('turn-end-no-turn', `tab ${tabId} has no bound agent session yet`);
    const turn = this.deps.table().currentTurn(sessionId);
    if (!turn) throw new TurnEndError('turn-end-no-turn', `session ${sessionId} has no turn yet (no prompt-submit recorded)`);

    const verdict = input.verdict;
    if (typeof verdict !== 'string' || !(TURN_VERDICTS as readonly string[]).includes(verdict)) {
      throw invalid(`verdict: measured ${JSON.stringify(verdict)}; expected one of ${TURN_VERDICTS.join(', ')}`);
    }
    const v = verdict as TTurnVerdict;
    const cleaned = cleanReason(input.reason);
    if (!cleaned.ok) throw invalid(`reason: ${cleaned.error}`);
    if (NEEDS_REASON.has(v) && !cleaned.reason) throw invalid(`reason: measured none; expected the reason for ${v} (--reason TEXT)`);

    const scope = await this.deps.scopeOf(workspaceId, tabId);
    const seat: TSeatRole | null = seatRoleOf(scope);
    const story = this.story(input.story, scope);
    const gateLog = this.absolute('gateLog', input.gateLog);
    if (seat === 'builder' && NEEDS_GATE.has(v) && !gateLog) {
      throw invalid(`gateLog: measured none; expected --gate-log ABS for ${v} from a builder seat (story ${story ?? '?'})`);
    }
    const head = input.head === undefined || input.head === null || input.head === '' ? null : input.head;
    if (head !== null && (typeof head !== 'string' || !FULL_SHA.test(head))) throw invalid(`head: measured ${JSON.stringify(head)}; expected a full 40-hex commit id`);

    const checked = gateLog || head ? await this.check(workspaceId, input.cwd, head as string | null, gateLog) : null;
    const row: ITurnEndRow = {
      sessionId, turnId: turn.turnId, workspaceId, tabId, seatRole: seat, story, attempt: scope?.attempt ?? null,
      verdict: v, head: checked?.head ?? null, gateLog: checked?.gateLog ?? null, gateVerdict: checked?.gateVerdict ?? null,
      reason: cleaned.reason, source: 'done', unreportedReason: null, at: this.deps.now(), consumedAt: null,
    };
    if (!this.deps.table().put(row)) {
      throw new TurnEndError('turn-end-refused', `turn ${turn.turnId} of session ${sessionId} already ended: its row was used by its stop`);
    }
    return row;
  }

  private story(given: unknown, scope: IEventScope | null): string | null {
    if (given === undefined || given === null || given === '') return scope?.story ?? null;
    if (typeof given !== 'string' || !STORY_KEY.test(given)) throw invalid(`story: measured ${JSON.stringify(given)}; expected a story key`);
    if (scope?.story && scope.story !== given) throw invalid(`story: measured ${given}; expected ${scope.story} (this tab's declared scope)`);
    return given;
  }

  private absolute(field: string, value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw invalid(`${field}: measured ${JSON.stringify(value)}; expected an absolute path`);
    return value;
  }

  /**
   * The repo is the git top level of the caller's cwd; the branch is its current branch; `head` defaults to that
   * branch's tip, so the range check cannot be skipped by leaving `--head` out (ruling (8), AC3).
   */
  private async check(workspaceId: string, cwd: unknown, head: string | null, gateLog: string | null) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw invalid(`cwd: measured ${JSON.stringify(cwd)}; expected the caller's absolute working directory`);
    const { reader } = this.deps;
    const top = await reader.run(['git', 'rev-parse', '--show-toplevel'], cwd);
    const repo = top.code === 0 ? top.stdout.trim() : '';
    if (!repo) throw new TurnEndError('turn-end-refused', `repo: measured ${cwd} is not inside a git work tree; expected the story worktree`);
    const branchRun = await reader.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
    const branch = branchRun.code === 0 ? branchRun.stdout.trim() : '';
    if (!branch) throw new TurnEndError('turn-end-refused', `branch: measured a detached HEAD in ${repo}; expected a named branch`);
    const tip = await reader.revParse(repo, `refs/heads/${branch}`);
    const wanted = head ?? tip;
    if (!wanted) throw new TurnEndError('turn-end-refused', `head: measured no commit on ${branch}; expected the branch tip`);
    const ctx: IValidationContext = { reader, roots: await this.deps.roots(workspaceId), patchIdCommand: { unavailable: 'not used by done' } };
    const event = {
      type: 'review-ready',
      payload: { repo, branch, head: wanted, base: wanted, attempt: 1, key: '', gateLog: gateLog ?? repo, reviewDir: repo },
    } as unknown as TWorkerEvent;
    const resolved = gateLog ? await resolveEvidence({ type: 'landed', payload: { repo, gateLog } } as unknown as TWorkerEvent, ctx)
      : await resolveEvidence({ type: 'blocked-on', payload: { repo } } as unknown as TWorkerEvent, ctx);
    if (!resolved.evidence) throw new TurnEndError('turn-end-refused', failureLines(resolved.failures), { failures: resolved.failures });
    const evidence: IResolvedEvidence = resolved.evidence;
    const validators = gateLog ? [rangeValidator, gateVerdictValidator, gateTreeValidator] : [rangeValidator];
    const failures = (await Promise.all(validators.map((validator) => validator.check(event, evidence, ctx)))).flat();
    if (failures.length) throw new TurnEndError('turn-end-refused', failureLines(failures), { failures });
    let gateVerdict: string | null = null;
    if (gateLog) {
      const read = await reader.readText(evidence.gateLog!, 32 * 1024 * 1024);
      gateVerdict = 'text' in read ? lastGateRun(read.text).verdict : null;
    }
    return { head: wanted, gateLog: evidence.gateLog ?? null, gateVerdict };
  }
}

// ─── the server's instance ────────────────────────────────────────────────

const g = globalThis as unknown as { __ptTurnEndService?: TurnEndService };

export const getTurnEndService = async (): Promise<TurnEndService> => {
  if (g.__ptTurnEndService) return g.__ptTurnEndService;
  const [{ getLedgerStore }, { getStatusManager }, scopeStore, workspaceStore, validators] = await Promise.all([
    import('@/lib/ledger-store'),
    import('@/lib/status-manager'),
    import('@/lib/event-scope-store'),
    import('@/lib/workspace-store'),
    import('@/lib/worker-event-validators'),
  ]);
  const extra = (process.env.PMUX_EVENT_EVIDENCE_ROOTS ?? '').split(':').map((dir) => dir.trim()).filter((dir) => dir.startsWith('/'));
  g.__ptTurnEndService = new TurnEndService({
    now: () => Date.now(),
    table: () => getLedgerStore().turnEnds,
    tab: (workspaceId, tabId) => getStatusManager().turnEndTab(workspaceId, tabId),
    scopeOf: async (workspaceId, tabId) =>
      (await scopeStore.readEventScopes()).scopes.find((s) => s.workspaceId === workspaceId && s.tabId === tabId) ?? null,
    roots: async (workspaceId) => {
      const given = [...((await workspaceStore.getWorkspaceById(workspaceId))?.directories ?? []), ...extra];
      const real = await Promise.all(given.map((dir) => validators.fsEvidenceReader.realpath(dir)));
      return [...new Set(real.filter((dir): dir is string => dir !== null))];
    },
    reader: validators.fsEvidenceReader,
  });
  return g.__ptTurnEndService;
};

export const turnEndErrorStatus: Record<TTurnEndErrorCode, number> = {
  'turn-end-invalid': 400,
  'turn-end-refused': 422,
  'turn-end-no-turn': 409,
  forbidden: 403,
};
