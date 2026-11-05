import type { TFinderStage, TFinderTrend } from '@/types/constraint';
import type { TLedgerIntervalReason } from '@/types/ledger';

// The one owning module of the board's words for the finder's tokens (ADR-0034). Same wording as
// the status push (engineering story 08), so the owner reads one vocabulary on every face.

const REASON_LABELS: Readonly<Record<TLedgerIntervalReason, string>> = {
  'review-queue': 'waiting for a reviewer',
  'review-findings': 'review findings open',
  rework: 'in rework',
  'receipt-rekey': 'receipt re-key',
  'not-armed': 'not armed to land',
  'pre-arm-gate': 'gate before arming',
  'fold-batch': 'waiting to fold into a batch',
  'own-lane-order': 'behind its own lane',
  'group-partner': 'waiting for a group partner',
  'guard-hold': 'held by a guard',
  'gate-slot': 'waiting for a gate slot',
  'pre-flight-gate': 'pre-flight gate',
  'land-queue/lock-busy': 'landing queue, lock busy',
  'land-queue/head-blocked': 'landing queue, head blocked',
  'lock-wait': 'waiting for the landing lock',
  'under-lock-gate': 'gate under the landing lock',
  'red-main': 'main is red',
  'chain-down': 'landing chain down',
  'deploy-queue': 'waiting to deploy',
  'deploy-run': 'deploy running',
  'deploy-auth': 'deploy needs a login',
  'external-team': 'waiting on another team',
  owner: 'waiting on you',
  'agent-idle': 'agent idle',
  'host-load': 'host at capacity',
  unknown: 'no recent event',
};

const STAGE_LABELS: Readonly<Record<TFinderStage, string>> = {
  'build-review': 'build and review', land: 'landing', deploy: 'deploy', people: 'people', hosts: 'hosts', unknown: 'stage not known',
};

const TREND_LABELS: Readonly<Record<TFinderTrend, string>> = {
  up: 'rising', down: 'falling', flat: 'steady', new: 'new in this window', unknown: 'trend not measured',
};

const own = <T extends string>(map: Readonly<Record<T, string>>, token: string, fallback: string): string =>
  Object.prototype.hasOwnProperty.call(map, token) ? map[token as T] : fallback;

export const reasonLabel = (token: string): string => own(REASON_LABELS, token, 'other wait (reason not in the label map)');
export const stageLabel = (token: string): string => own(STAGE_LABELS, token, 'other stage (not in the label map)');
export const trendLabel = (token: string): string => own(TREND_LABELS, token, 'trend not measured (not in the label map)');
