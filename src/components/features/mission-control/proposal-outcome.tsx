import { cn } from '@/lib/utils';
import type { IMissionSoProposalView, TSoProposalState } from '@/types/mission-control';

// The outcome of a fleet standing-order proposal on its card (ADR-0041 §1 amendment D7): "Filed as SO-n" or
// "Not filed: <reason>", and the other states in words. The served state reaches the face only through this map.

type TTone = 'neutral' | 'positive' | 'negative';

const LABELS: Readonly<Record<TSoProposalState, { text: (proposal: IMissionSoProposalView) => string; tone: TTone }>> = {
  open: { text: () => 'Proposed fleet standing order: Yes files it exactly as quoted', tone: 'neutral' },
  filed: { text: (p) => (p.orderId ? `Filed as ${p.orderId}` : 'Filed; the order id is not available'), tone: 'positive' },
  declined: { text: () => 'Declined: nothing filed', tone: 'neutral' },
  expired: { text: () => 'Expired after 72 h with no answer: nothing filed', tone: 'neutral' },
  withdrawn: { text: () => 'Withdrawn by the proposer: nothing filed', tone: 'neutral' },
  'not-filed': { text: (p) => `Not filed: ${p.reason ?? 'no reason was recorded'}`, tone: 'negative' },
};

const TONE = {
  neutral: 'border-foreground/10 text-muted-foreground',
  positive: 'border-ui-teal/25 bg-ui-teal/5 text-ui-teal',
  negative: 'border-ui-red/25 bg-ui-red/5 text-ui-red',
} as const;

/** The sentence a proposal's state shows; a state this release does not know is said, never shown as its token. */
export const proposalOutcomeText = (proposal: IMissionSoProposalView): { text: string; tone: TTone; served: string | null } => {
  if (Object.hasOwn(LABELS, proposal.state)) {
    const entry = LABELS[proposal.state];
    return { text: entry.text(proposal), tone: entry.tone, served: null };
  }
  return { text: 'Proposal state not recognised by this page: reload it', tone: 'neutral', served: String(proposal.state) };
};

export const ProposalOutcome = ({ proposal }: { proposal: IMissionSoProposalView | null | undefined }) => {
  if (!proposal) return null;
  const outcome = proposalOutcomeText(proposal);
  return (
    <p
      className={cn('break-words rounded-md border px-3 py-2 text-sm font-medium', TONE[outcome.tone])}
      data-proposal-state={outcome.served === null ? proposal.state : 'unknown'}
      title={outcome.served ? `Served state: ${outcome.served}` : undefined}
    >
      {outcome.text}
    </p>
  );
};
