import { SEAT_ROLES, type TSeatRole } from '@/lib/turn-end-row';
import { createHash } from 'crypto';
import type { ICaller } from '@/lib/caller';
import { createLogger } from '@/lib/logger';
import type { IEventNoteInput, ILiveTabs, NotesService } from '@/lib/notes-service';
import { isEpicSlug } from '@/lib/notes-store';
import { WorkerEventError, parseWorkerEvent } from '@/lib/worker-event-schema';
import {
  DEFAULT_VALIDATORS,
  validateWorkerEvent,
  type IEvidenceReader,
  type IEventValidator,
  type TPatchIdCommand,
} from '@/lib/worker-event-validators';
import type { INoteView } from '@/types/note';
import type { IEventScope, IEventScopesState, INoteEventRecord, TWorkerEvent, TWorkerEventType } from '@/types/worker-event';

// Typed worker-to-worker events (ADR-0043): a coordinator declares a worker tab's scope once per
// dispatch; the worker announces a result inside it; the server checks the evidence and hands the
// event to the notes service. Nothing here types into a tab or controls one.

const log = createLogger('worker-events');

export const SCOPE_DEPENDS_MAX = 16;
const TAB_ID = /^tab-[A-Za-z0-9_-]{1,32}$/;
const STORY_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/** Status changes reach the source coordinator; a step result goes to the task's owner only (ADR-0043 §4). */
export const STATUS_TYPES: ReadonlySet<TWorkerEventType> = new Set(['landed', 'blocked-on']);

export interface IWorkerEventsDeps {
  now: () => number;
  readScopes: () => Promise<IEventScopesState>;
  mutateScopes: <T>(fn: (state: IEventScopesState) => Promise<{ state: IEventScopesState; value: T }> | { state: IEventScopesState; value: T }) => Promise<T>;
  /** The workspace's orchestrator tab while orchestration is on; liveness is checked here. */
  orchestratorOf: (workspaceId: string) => Promise<string | null>;
  liveTabs: () => Promise<ILiveTabs>;
  /** The tab holding `epic:<slug>` while that tab is live; else null. */
  epicHolder: (slug: string) => Promise<{ workspaceId: string; tabId: string } | null>;
  /** The workspace's directories: the roots its evidence must lie under. */
  workspaceDirectories: (workspaceId: string) => Promise<string[]>;
  /** Further evidence roots for every workspace (`PMUX_EVENT_EVIDENCE_ROOTS`). */
  extraRoots: () => string[];
  reader: IEvidenceReader;
  patchIdCommand: TPatchIdCommand;
  /**
   * The ssh alias of the host that runs the tab (ADR-0022), null for this server's host, or
   * undefined when the layout cannot say. Only a tab known to be local may send: the server reads
   * evidence on its own host.
   */
  tabHost: (workspaceId: string, tabId: string) => Promise<string | null | undefined>;
  validators?: readonly IEventValidator[];
  notes: Pick<NotesService, 'sendEvent'>;
  audit?: (entry: Record<string, unknown>) => Promise<unknown>;
}

export interface IScopeInput {
  tabId?: unknown;
  epic?: unknown;
  story?: unknown;
  dependsOn?: unknown;
  attempt?: unknown;
  seat?: unknown;
}

export interface ISendEventInput {
  type?: unknown;
  toEpic?: unknown;
  payload?: unknown;
}

export interface IWorkerEventResult {
  event: {
    type: TWorkerEventType;
    toEpic: string;
    state: 'delivered';
    checks: string[];
    noteId: string;
    statusNoteId: string | null;
  };
  note: INoteView;
  status: INoteView | null;
}

const scopeError = (message: string) => new WorkerEventError('event-scope-invalid', message);

const parseDependsOn = (raw: unknown, epic: string): string[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw scopeError('dependsOn must be a list of epic slugs');
  if (raw.length > SCOPE_DEPENDS_MAX) throw scopeError(`dependsOn names ${raw.length} epics; at most ${SCOPE_DEPENDS_MAX}`);
  const bad = raw.filter((slug) => !isEpicSlug(slug));
  if (bad.length) throw scopeError(`dependsOn holds values that are not epic slugs: ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
  const slugs = raw as string[];
  if (new Set(slugs).size !== slugs.length) throw scopeError('dependsOn names an epic twice');
  if (slugs.includes(epic)) throw scopeError(`dependsOn names the served epic ${epic}`);
  return slugs;
};

const short = (id: string): string => id.slice(0, 12);

const describe = (event: TWorkerEvent): string => (event.type === 'blocked-on' ? event.payload.reason : `key ${short(event.payload.key)}`);

export class WorkerEventsService {
  constructor(private readonly deps: IWorkerEventsDeps) {}

  private async isLive(workspaceId: string, tabId: string): Promise<boolean> {
    const { tabs } = await this.deps.liveTabs();
    return tabs.some((t) => t.workspaceId === workspaceId && t.tabId === tabId);
  }

  /** The verified tab that is its workspace's designated, live coordinator; else `forbidden`. */
  private async requireCoordinator(caller: ICaller): Promise<{ workspaceId: string; tabId: string }> {
    const { workspaceId, tabId } = caller;
    if (!caller.admin && caller.verified && workspaceId && tabId
      && (await this.deps.orchestratorOf(workspaceId)) === tabId && (await this.isLive(workspaceId, tabId))) {
      return { workspaceId, tabId };
    }
    throw new WorkerEventError('forbidden', 'only the verified, designated live coordinator of a workspace declares or clears its event scopes');
  }

  async declareScope(caller: ICaller, input: IScopeInput): Promise<IEventScope> {
    const coordinator = await this.requireCoordinator(caller);
    const { tabId } = input;
    if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw scopeError(`tabId must be a tab id, got ${JSON.stringify(tabId)}`);
    if (!(await this.isLive(coordinator.workspaceId, tabId))) throw scopeError(`${tabId} is not a live tab of ${coordinator.workspaceId}`);
    const { epic } = input;
    if (!isEpicSlug(epic)) throw scopeError(`epic must be an epic slug, got ${JSON.stringify(epic)}`);
    const holder = await this.deps.epicHolder(epic);
    if (!holder || holder.workspaceId !== coordinator.workspaceId) {
      throw scopeError(`epic:${epic} is not held by a live tab of ${coordinator.workspaceId} (holder: ${holder ? `${holder.workspaceId}/${holder.tabId}` : 'none'})`);
    }
    const story = input.story === undefined || input.story === null || input.story === '' ? null : input.story;
    if (story !== null && (typeof story !== 'string' || !STORY_KEY.test(story))) throw scopeError(`story must match ${STORY_KEY.source}`);
    const dependsOn = parseDependsOn(input.dependsOn, epic);
    if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || (input.attempt as number) < 1)) {
      throw scopeError('attempt must be a whole number of at least 1');
    }
    const seat = input.seat === undefined || input.seat === null || input.seat === '' ? undefined : input.seat;
    if (seat !== undefined && !(SEAT_ROLES as readonly unknown[]).includes(seat)) {
      throw scopeError(`seat must be one of ${SEAT_ROLES.join(', ')}, got ${JSON.stringify(seat)}`);
    }
    const { tabs, uncertainWorkspaceIds } = await this.deps.liveTabs();
    const gone = (s: IEventScope) => !uncertainWorkspaceIds.has(s.workspaceId) && !tabs.some((t) => t.workspaceId === s.workspaceId && t.tabId === s.tabId);
    return this.deps.mutateScopes((state) => {
      const previous = state.scopes.find((s) => s.workspaceId === coordinator.workspaceId && s.tabId === tabId);
      const attempt = (input.attempt as number | undefined) ?? previous?.attempt ?? 1;
      if (previous && attempt < previous.attempt) {
        throw scopeError(`attempt ${attempt} is below the current attempt ${previous.attempt}; an attempt never goes back`);
      }
      const scope: IEventScope = {
        workspaceId: coordinator.workspaceId, tabId, epic, story: story as string | null, dependsOn, attempt,
        ...(seat !== undefined ? { seat: seat as TSeatRole } : {}),
        declaredBy: coordinator, declaredAt: this.deps.now(),
      };
      const kept = state.scopes.filter((s) => s !== previous && !gone(s));
      return { state: { scopes: [...kept, scope] }, value: scope };
    });
  }

  async clearScope(caller: ICaller, tabId: unknown): Promise<boolean> {
    const coordinator = await this.requireCoordinator(caller);
    if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw scopeError(`tabId must be a tab id, got ${JSON.stringify(tabId)}`);
    return this.deps.mutateScopes((state) => {
      const scopes = state.scopes.filter((s) => !(s.workspaceId === coordinator.workspaceId && s.tabId === tabId));
      return scopes.length === state.scopes.length ? { state, value: false } : { state: { scopes }, value: true };
    });
  }

  /** The scopes of the caller's workspace; the admin token reads every workspace's. */
  async listScopes(caller: ICaller): Promise<IEventScope[]> {
    const { scopes } = await this.deps.readScopes();
    return caller.admin ? scopes : scopes.filter((s) => s.workspaceId === caller.workspaceId);
  }

  async send(caller: ICaller, input: ISendEventInput): Promise<IWorkerEventResult> {
    try {
      return await this.sendChecked(caller, input);
    } catch (err) {
      const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
      if (typeof code === 'string') {
        await this.audit({
          event: 'typed-event-refused', code, type: input.type, toEpic: input.toEpic,
          from: { workspaceId: caller.workspaceId, tabId: caller.tabId }, reason: (err as Error).message,
        });
      }
      throw err;
    }
  }

  private async sendChecked(caller: ICaller, input: ISendEventInput): Promise<IWorkerEventResult> {
    const { workspaceId, tabId } = caller;
    if (caller.admin || !caller.verified || !workspaceId || !tabId) {
      throw new WorkerEventError('forbidden', 'a typed event is sent from a verified tab, never from a workspace or admin token');
    }
    const host = await this.deps.tabHost(workspaceId, tabId);
    if (host !== null) {
      throw new WorkerEventError('event-check-unavailable', host === undefined
        ? `the host of ${workspaceId}/${tabId} cannot be read from its layout, so its evidence cannot be checked here; report through the coordinator`
        : `${workspaceId}/${tabId} runs on host ${host} (ADR-0022); the server reads evidence on its own host only, so a remote tab reports through the coordinator`);
    }
    const { toEpic } = input;
    if (!isEpicSlug(toEpic)) throw new WorkerEventError('event-invalid', `toEpic must be an epic slug, got ${JSON.stringify(toEpic)}`);
    const scope = (await this.deps.readScopes()).scopes.find((s) => s.workspaceId === workspaceId && s.tabId === tabId);
    if (!scope) {
      throw new WorkerEventError('event-out-of-scope',
        `${workspaceId}/${tabId} has no event scope; the workspace coordinator declares one with: purplemux event scope set --tab ${tabId} --epic <slug>`);
    }
    const holder = await this.deps.epicHolder(scope.epic);
    if (!holder || holder.workspaceId !== workspaceId) {
      throw new WorkerEventError('event-out-of-scope', `the scope's epic ${scope.epic} is no longer held by a live tab of ${workspaceId}`);
    }
    const allowed = [scope.epic, ...scope.dependsOn];
    if (!allowed.includes(toEpic)) {
      throw new WorkerEventError('event-out-of-scope', `epic:${toEpic} is outside this tab's scope (allowed: ${allowed.join(', ')})`, { allowed });
    }
    const event = parseWorkerEvent(input.type, input.payload);
    if (event.payload.attempt !== scope.attempt) {
      throw new WorkerEventError('event-stale',
        `attempt ${event.payload.attempt} is not the current attempt ${scope.attempt} of this tab's scope; an old attempt's result is not delivered`);
    }
    const roots = await this.roots(workspaceId);
    const { passed, failures } = await validateWorkerEvent(event, {
      reader: this.deps.reader, roots, patchIdCommand: this.deps.patchIdCommand,
    }, this.deps.validators ?? DEFAULT_VALIDATORS);
    const unavailable = failures.filter((f) => f.unavailable);
    if (unavailable.length) {
      throw new WorkerEventError('event-check-unavailable',
        `${event.type} cannot be checked on this server: ${unavailable.map((f) => `${f.check}: ${f.measured}; expected ${f.expected}`).join(' | ')}`,
        { failures: unavailable });
    }
    if (failures.length) {
      const lines = failures.map((f) => `${f.check}: measured ${f.measured}; expected ${f.expected}`);
      throw new WorkerEventError('event-refused', `${event.type} refused by ${failures.length} check(s): ${lines.join(' | ')}`, { failures });
    }
    const noteInput = this.noteInput(caller, scope, event, toEpic, passed);
    const sent = await this.deps.notes.sendEvent(caller, { ...noteInput, recheck: () => this.recheckScope(scope, workspaceId, tabId, toEpic) });
    await this.audit({
      event: 'typed-event-delivered', type: event.type, toEpic, noteId: sent.note.id, statusNoteId: sent.status?.id ?? null,
      from: { workspaceId, tabId }, checks: passed,
    });
    return {
      event: { type: event.type, toEpic, state: 'delivered', checks: passed, noteId: sent.note.id, statusNoteId: sent.status?.id ?? null },
      note: sent.note,
      status: sent.status,
    };
  }

  /**
   * Inside the notes lock, after the slow checks: a re-dispatch (a new attempt), a cleared scope or
   * a changed epic during validation makes the result stale (ruling R1-5).
   */
  private async recheckScope(checked: IEventScope, workspaceId: string, tabId: string, toEpic: string): Promise<void> {
    const now = (await this.deps.readScopes()).scopes.find((s) => s.workspaceId === workspaceId && s.tabId === tabId);
    if (!now || now.attempt !== checked.attempt || now.epic !== checked.epic) {
      throw new WorkerEventError('event-stale', now
        ? `the scope changed while the evidence was checked (attempt ${checked.attempt} → ${now.attempt}, epic ${checked.epic} → ${now.epic}); the old attempt's result is not delivered`
        : 'the scope was cleared while the evidence was checked; the result is not delivered');
    }
    if (toEpic !== now.epic && !now.dependsOn.includes(toEpic)) {
      throw new WorkerEventError('event-out-of-scope', `epic:${toEpic} left this tab's scope while the evidence was checked`);
    }
  }

  private async roots(workspaceId: string): Promise<string[]> {
    const given = [...(await this.deps.workspaceDirectories(workspaceId)), ...this.deps.extraRoots()];
    const real = await Promise.all(given.map((dir) => this.deps.reader.realpath(dir)));
    return [...new Set(real.filter((dir): dir is string => dir !== null))];
  }

  private noteInput(caller: ICaller, scope: IEventScope, event: TWorkerEvent, toEpic: string, checks: string[]): IEventNoteInput {
    const from = `${caller.workspaceId}/${caller.tabId}`;
    const scopeRecord = { epic: scope.epic, story: scope.story, dependsOn: scope.dependsOn, attempt: scope.attempt };
    const dedupeKey = createHash('sha256')
      .update(JSON.stringify([event.type, toEpic, caller.workspaceId, scope.story ?? caller.tabId, event.payload]))
      .digest('hex');
    const record: INoteEventRecord = { type: event.type, role: 'delivery', payload: event.payload, scope: scopeRecord, checks, dedupeKey };
    const body = [
      `Typed event ${event.type} from ${from} (epic ${scope.epic}${scope.story ? `, story ${scope.story}` : ''}, attempt ${scope.attempt}).`,
      `The server checked: ${checks.join(', ')}.`,
      '',
      JSON.stringify(event.payload, null, 2),
      '',
    ].join('\n');
    const status = STATUS_TYPES.has(event.type) ? {
      subject: `status ${event.type} from ${from} for epic:${toEpic}`,
      body: `Status ${event.type} from ${from} for epic:${toEpic}: ${describe(event)}. The delivery note is event.deliveryNoteId; read it with note show.\n`,
      record: { ...record, role: 'status' as const },
    } : undefined;
    return { toEpic, subject: `${event.type} ${describe(event)} for epic:${toEpic}`, body, record, status };
  }

  private async audit(entry: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.audit?.(entry);
    } catch (err) {
      log.warn(`typed event audit failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ─── the server's instance ────────────────────────────────────────────────

const g = globalThis as unknown as { __ptWorkerEventsService?: WorkerEventsService };

const evidenceRoots = (): string[] =>
  (process.env.PMUX_EVENT_EVIDENCE_ROOTS ?? '').split(':').map((dir) => dir.trim()).filter((dir) => dir.startsWith('/'));

export const getWorkerEventsService = async (): Promise<WorkerEventsService> => {
  if (g.__ptWorkerEventsService) return g.__ptWorkerEventsService;
  const [scopeStore, workspaceStore, tabLifecycle, notesService, leaseStore, leaseHttp, validators, audit, layoutStore] = await Promise.all([
    import('@/lib/event-scope-store'),
    import('@/lib/workspace-store'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/notes-service'),
    import('@/lib/lease-store'),
    import('@/lib/lease-http'),
    import('@/lib/worker-event-validators'),
    import('@/lib/coordination-audit'),
    import('@/lib/layout-store'),
  ]);
  const notes = await notesService.getNotesService();
  g.__ptWorkerEventsService = new WorkerEventsService({
    now: () => Date.now(),
    readScopes: scopeStore.readEventScopes,
    mutateScopes: scopeStore.mutateEventScopes,
    orchestratorOf: async (workspaceId) => {
      const orchestration = (await workspaceStore.getWorkspaceById(workspaceId))?.orchestration;
      return (orchestration?.enabled ? orchestration.orchestratorTabId : null) ?? null;
    },
    liveTabs: tabLifecycle.readLiveTabs,
    epicHolder: async (slug) => {
      const { state } = leaseStore.pruneExpired(await leaseStore.readLeaseState(), Date.now());
      const lease = state.leases.find((l) => l.name === `epic:${slug}`);
      if (!lease?.holder.tabId || !lease.holder.workspaceId) return null;
      return (await leaseHttp.viewOf(lease)).holderState === 'live' ? { workspaceId: lease.holder.workspaceId, tabId: lease.holder.tabId } : null;
    },
    workspaceDirectories: async (workspaceId) => (await workspaceStore.getWorkspaceById(workspaceId))?.directories ?? [],
    extraRoots: evidenceRoots,
    reader: validators.fsEvidenceReader,
    patchIdCommand: validators.patchIdCommandFrom(process.env[validators.PATCH_ID_ENV]),
    tabHost: async (workspaceId, tabId) => {
      try {
        const layout = await layoutStore.readLayoutFile(layoutStore.resolveLayoutFile(workspaceId));
        const tab = layout ? layoutStore.collectAllTabs(layout.root).find((t) => t.id === tabId) : undefined;
        return tab ? tab.host ?? null : undefined;
      } catch {
        return undefined;
      }
    },
    notes,
    audit: audit.appendCoordinationAudit,
  });
  return g.__ptWorkerEventsService;
};
