import { useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, Check, ChevronDown, ChevronUp, CircleHelp, Clock3, ExternalLink, RefreshCw, Send, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { MISSION_AUTO_ANSWER_ACTOR } from '@/lib/attention-class';
import { AttentionClassBadge, statedDefaultLabel } from '@/components/features/mission-control/attention-class-view';
import {
  deliveryStatus,
  formatMissionAge,
} from '@/components/features/mission-control/mission-control-utils';
import QuestionMarkdown from '@/components/features/mission-control/question-markdown';
import {
  answerTypeHint,
  changedFields,
  hasVisibleRevision,
  noticeOptionLabel,
  isContextCollapsible,
  missionSubmitState,
  questionView,
  selectOption,
} from '@/components/features/mission-control/question-card-model';
import type { IQuestionOptionView, IQuestionView } from '@/components/features/mission-control/question-card-model';
import type { IMissionDraft, IMissionDraftPatch } from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAnswer,
  IMissionAttentionItem,
  IMissionBlockedCost,
  IMissionQuestionChanges,
  IMissionAutoAnsweredItem,
  IMissionDelivery,
  TMissionItemState,
} from '@/types/mission-control';

interface IMissionAnswerCardProps {
  draft: IMissionDraft;
  workspaceName: string;
  onChange: (patch: IMissionDraftPatch) => void;
  onAdoptCurrent: () => void;
  onSubmit: () => void;
}

const confidenceLabel = (item: IMissionAttentionItem): string => {
  const labels = {
    confirmed: 'Confirmed',
    provisional: 'Provisional',
    unknown: 'Unknown source',
  } as const;
  return `${labels[item.evidence.confidence]} · ${item.evidence.source}`;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const BlockedCost = ({ blocked }: { blocked: IMissionBlockedCost }) => (
  <p className="rounded-md border border-ui-amber/20 bg-ui-amber/5 px-3 py-2 text-sm" data-blocked-cost>
    <span className="font-medium text-ui-amber">Blocking {plural(blocked.items, 'item')}</span>
    <span className="text-foreground/80"> · {blocked.hours.toFixed(1)} h waiting</span>
    {blocked.critical && <span className="text-foreground/80"> · on the critical path</span>}
  </p>
);

const labelList = (draft: IMissionDraft, optionIds: string[]): string =>
  optionIds.length ? optionIds.map((optionId) => noticeOptionLabel(draft, optionId)).join(', ') : 'none';

const needsTextNote = (entry: IMissionQuestionChanges['options']['relabelled'][number]): string =>
  !entry.needsText ? '' : entry.needsText.to ? ' (now needs text)' : ' (no longer needs text)';

const RevisionNotice = ({ draft }: { draft: IMissionDraft }) => {
  const notice = draft.notice;
  if (!notice || !hasVisibleRevision(draft)) return null;
  const { changes, cleared, moved } = notice;
  const fields = changedFields(draft);
  return (
    <div
      role="status"
      aria-live="polite"
      data-revision-notice={notice.compatible ? 'compatible' : 'incompatible'}
      className={cn(
        'space-y-1.5 rounded-md border px-3 py-2 text-sm',
        notice.compatible ? 'border-ui-blue/25 bg-ui-blue/5' : 'border-ui-amber/30 bg-ui-amber/5',
      )}
    >
      {fields.length > 0 && (
        <p className={cn('flex items-start gap-2 font-medium', notice.compatible ? 'text-ui-blue' : 'text-ui-amber')}>
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {notice.compatible
              ? `Updated while you answered: ${fields.join(', ')}. Your choices and text are kept.`
              : `Changed: ${fields.join(', ')}. Your text is kept; review your choices.`}
          </span>
        </p>
      )}
      {changes.decision && (
        <p className="break-words"><span className="text-muted-foreground">Was: </span><span className="line-through decoration-foreground/30">{changes.decision.from}</span><br />
          <span className="text-muted-foreground">Now: </span>{changes.decision.to}</p>
      )}
      {changes.answerType && (
        <p>Answer type: {answerTypeHint(changes.answerType.from)} → {answerTypeHint(changes.answerType.to)}</p>
      )}
      {changes.options.removed.length > 0 && (
        <p className="break-words">Removed: {labelList(draft, changes.options.removed)}</p>
      )}
      {changes.options.relabelled.map((entry) => (
        <p key={entry.id} className="break-words">
          {entry.from === entry.to
            ? <>“{entry.to}”{needsTextNote(entry)}</>
            : <>Reworded: <span className="line-through decoration-foreground/30">{entry.from}</span> → {entry.to}{needsTextNote(entry)}</>}
        </p>
      ))}
      {changes.recommended && (
        <p className="break-words">Recommended: {labelList(draft, changes.recommended.from)} → {labelList(draft, changes.recommended.to)}</p>
      )}
      {cleared.length > 0 && (
        <p className="break-words font-medium">
          Cleared your choice {labelList(draft, cleared)}: it was removed or reworded.
        </p>
      )}
      {moved.length > 0 && (
        <p className="break-words font-medium" data-moved-text>
          Moved your text for {labelList(draft, moved)} into Other: the option no longer takes it.
        </p>
      )}
    </div>
  );
};

const OriginalWording = ({ source }: { source: Record<string, unknown> }) => {
  const text = (key: string): string | null => (typeof source[key] === 'string' ? source[key] as string : null);
  const options = Array.isArray(source.options)
    ? source.options.flatMap((option) => (option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string'
      ? [(option as { label: string }).label]
      : []))
    : [];
  return (
    <details className="rounded-md border border-foreground/10 px-3 py-2 text-sm" data-original-wording>
      <summary className="cursor-pointer text-muted-foreground">Original wording</summary>
      <div className="mt-2 space-y-2 select-text">
        {(text('decision') ?? text('title')) && <p className="break-words font-medium">{text('decision') ?? text('title')}</p>}
        {text('context') && <p className="whitespace-pre-wrap break-words text-muted-foreground">{text('context')}</p>}
        {options.length > 0 && (
          <ul className="list-disc pl-5">{options.map((label, index) => <li key={index} className="break-words">{label}</li>)}</ul>
        )}
      </div>
    </details>
  );
};

/** Owner messages the curator read as an answer (story 23): a pointer to answer here, never an answer. */
const SuggestedAnswers = ({ suggestions }: { suggestions: NonNullable<IMissionAttentionItem['suggestedAnswers']> }) => (
  <div className="space-y-1 rounded-md border border-dashed border-foreground/15 px-3 py-2 text-sm" data-suggested-answers>
    {suggestions.map((suggestion) => (
      <p key={suggestion.entryId} className="break-words text-muted-foreground select-text">
        Your message {formatMissionAge(suggestion.at)} may answer this
        {suggestion.span ? <>: <q className="text-foreground">{suggestion.span}</q></> : null}. It is not an answer: choose below.
      </p>
    ))}
  </div>
);

const QuestionContext = ({ context }: { context: string }) => {
  const [expanded, setExpanded] = useState(false);
  const collapsible = isContextCollapsible(context);
  const collapsed = collapsible && !expanded;
  return (
    <div className="space-y-1">
      <div className={cn('relative', collapsed && 'max-h-72 overflow-hidden')} data-context-collapsed={collapsed ? 'true' : 'false'}>
        <QuestionMarkdown text={context} />
        {collapsed && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {collapsible && (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </div>
  );
};

interface IOptionCardProps {
  option: IQuestionOptionView;
  control: ReactNode;
  controlId: string;
  selected: boolean;
  mark: 'new' | 'changed' | null;
}

const OptionCard = ({ option, control, controlId, selected, mark }: IOptionCardProps) => (
  <label
    htmlFor={controlId}
    data-option={option.id}
    className={cn(
      'flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-md border border-foreground/10 px-3 py-2.5 text-left',
      selected && 'border-ui-blue/50 bg-ui-blue/10',
      mark && 'ring-1 ring-ui-amber/40',
    )}
  >
    <span className="mt-0.5 shrink-0">{control}</span>
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="break-words font-medium">{option.label}</span>
        {option.recommended && (
          <span className="inline-flex items-center gap-1 rounded bg-ui-blue/10 px-1.5 py-0.5 text-xs text-ui-blue">
            <Star className="h-3 w-3" />Recommended
          </span>
        )}
        {option.needsText && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Needs text</span>}
        {mark && (
          <span className="rounded bg-ui-amber/10 px-1.5 py-0.5 text-xs text-ui-amber">{mark === 'new' ? 'New' : 'Changed'}</span>
        )}
      </span>
      {option.consequence && (
        <span id={`${controlId}-consequence`} className="mt-0.5 block break-words text-xs text-muted-foreground">
          {option.consequence}
        </span>
      )}
    </span>
  </label>
);

interface IAnswerChoicesProps {
  draft: IMissionDraft;
  view: IQuestionView;
  headingId: string;
  disabled: boolean;
  onChange: (patch: IMissionDraftPatch) => void;
}

const AnswerChoices = ({ draft, view, headingId, disabled, onChange }: IAnswerChoicesProps) => {
  const added = new Set(draft.notice?.step.options.added ?? []);
  const changed = new Set(draft.notice?.step.options.relabelled.map((entry) => entry.id) ?? []);
  const markOf = (optionId: string) => (added.has(optionId) ? 'new' : changed.has(optionId) ? 'changed' : null);
  const select = (optionId: string) => onChange({ optionIds: selectOption(draft, optionId) });
  const controlId = (optionId: string) => `${draft.item.id}-option-${optionId}`;
  const needsTextFields = view.options.filter((option) => option.needsText && draft.optionIds.includes(option.id)).map((option) => (
    <div key={option.id} className="space-y-1 pl-7">
      <label htmlFor={`${controlId(option.id)}-text`} className="text-xs font-medium">Required for “{option.label}”</label>
      <Textarea
        id={`${controlId(option.id)}-text`}
        required
        aria-required="true"
        value={draft.optionTexts[option.id] ?? ''}
        maxLength={4000}
        disabled={disabled}
        onChange={(event) => onChange({ optionTexts: { ...draft.optionTexts, [option.id]: event.target.value } })}
        className="min-h-16 resize-y"
      />
    </div>
  ));

  if (view.answerType === 'confirm') {
    return (
      <div className="space-y-2" role="group" aria-labelledby={headingId}>
        <div className="grid gap-2 sm:grid-cols-2">
          {view.options.map((option) => {
            const selected = draft.optionIds.includes(option.id);
            return (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                data-option={option.id}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => select(option.id)}
                className={cn('h-auto w-full flex-col items-start whitespace-normal px-3 py-3 text-left', selected && 'border-ui-blue/50 bg-ui-blue/10')}
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {selected && <Check className="h-4 w-4" />}{option.label}
                  {option.recommended && <span className="inline-flex items-center gap-1 text-xs font-normal text-ui-blue"><Star className="h-3 w-3" />Recommended</span>}
                </span>
                {option.consequence && <span className="text-xs font-normal text-muted-foreground">{option.consequence}</span>}
              </Button>
            );
          })}
        </div>
        {needsTextFields}
      </div>
    );
  }

  if (view.answerType === 'single') {
    return (
      <RadioGroup
        aria-labelledby={headingId}
        value={draft.optionIds[0] ?? ''}
        onValueChange={(value) => select(String(value))}
        disabled={disabled}
        className="gap-2"
      >
        {view.options.map((option) => (
          <div key={option.id} className="space-y-2">
            <OptionCard
              option={option}
              controlId={controlId(option.id)}
              selected={draft.optionIds.includes(option.id)}
              mark={markOf(option.id)}
              control={<RadioGroupItem id={controlId(option.id)} value={option.id} aria-describedby={option.consequence ? `${controlId(option.id)}-consequence` : undefined} />}
            />
            {needsTextFields.find((field) => field.key === option.id)}
          </div>
        ))}
      </RadioGroup>
    );
  }

  if (view.answerType === 'multi') {
    return (
      <div role="group" aria-labelledby={headingId} className="grid gap-2">
        {view.options.map((option) => (
          <div key={option.id} className="space-y-2">
            <OptionCard
              option={option}
              controlId={controlId(option.id)}
              selected={draft.optionIds.includes(option.id)}
              mark={markOf(option.id)}
              control={(
                <Checkbox
                  id={controlId(option.id)}
                  checked={draft.optionIds.includes(option.id)}
                  disabled={disabled}
                  onCheckedChange={() => select(option.id)}
                  aria-describedby={option.consequence ? `${controlId(option.id)}-consequence` : undefined}
                />
              )}
            />
            {needsTextFields.find((field) => field.key === option.id)}
          </div>
        ))}
      </div>
    );
  }

  if (view.answerType === 'action-done') {
    return (
      <Button
        type="button"
        variant="outline"
        className={cn(
          'h-auto w-full justify-start whitespace-normal px-3 py-2 text-left',
          draft.actionCompleted && 'border-ui-teal/50 bg-ui-teal/10 text-foreground',
        )}
        aria-pressed={draft.actionCompleted}
        disabled={disabled}
        onClick={() => onChange({ actionCompleted: !draft.actionCompleted })}
      >
        <Check className="h-4 w-4 shrink-0" />
        I&apos;ve completed this action
      </Button>
    );
  }
  return null;
};

const OTHER_LABELS: Readonly<Record<IQuestionView['answerType'], { label: string; placeholder: string }>> = {
  single: { label: 'Other (always available)', placeholder: 'Answer in your own words instead, or add context' },
  multi: { label: 'Other (always available)', placeholder: 'Answer in your own words instead, or add context' },
  confirm: { label: 'Other (always available)', placeholder: 'Answer in your own words instead, or add context' },
  text: { label: 'Your answer', placeholder: 'Type your answer' },
  'action-done': { label: 'Add a note (optional)', placeholder: 'What you did, or why you could not' },
};

const MissionControlAnswerCard = ({
  draft,
  workspaceName,
  onChange,
  onAdoptCurrent,
  onSubmit,
}: IMissionAnswerCardProps) => {
  const { item } = draft;
  const view = questionView(item);
  const defaultLabel = statedDefaultLabel(item);
  const submit = missionSubmitState(draft);
  const submitting = draft.status === 'submitting';
  const headingId = `${item.id}-decision`;
  const reasonId = `${item.id}-submit-reason`;
  const other = OTHER_LABELS[view.answerType];

  return (
    <Card className="min-w-0 border-foreground/10 shadow-none" data-question-card={item.id} data-format-version={view.formatVersion}>
      <CardHeader className="gap-3 px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-2 py-1 font-medium text-foreground">{workspaceName}</span>
          <AttentionClassBadge value={item.class} />
          <span>{item.kind === 'action' ? 'Action' : 'Decision'}</span>
          <span>·</span>
          <span>{formatMissionAge(item.createdAt)}</span>
          <span>·</span>
          <span>{confidenceLabel(item)}</span>
        </div>
        <CardTitle id={headingId} className="select-text break-words text-lg font-semibold leading-7">{view.heading}</CardTitle>
        {view.subtitle && <p className="select-text break-words text-xs text-muted-foreground">{view.subtitle}</p>}
        {view.whyNow && <p className="select-text break-words text-sm text-foreground/80" data-why-now>{view.whyNow}</p>}
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
        {view.blocked && <BlockedCost blocked={view.blocked} />}
        <RevisionNotice draft={draft} />

        {item.humanReview?.humanNeed !== 'none' && item.humanReview?.humanReason && (
          <div className="rounded-md border border-ui-amber/20 bg-ui-amber/5 px-3 py-2 text-sm">
            <p className="font-medium text-ui-amber">Why you&apos;re needed</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-foreground/80">
              {item.humanReview.humanReason}
            </p>
          </div>
        )}

        {view.evidence.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-evidence-links>
            <span className="text-muted-foreground">Evidence:</span>
            {view.evidence.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui-blue underline-offset-2 hover:underline">
                {link.label}<ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}

        {view.context && <QuestionContext context={view.context} />}
        {view.source && <OriginalWording source={view.source} />}
        {item.suggestedAnswers && item.suggestedAnswers.length > 0 && <SuggestedAnswers suggestions={item.suggestedAnswers} />}

        {item.storyIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.storyIds.map((storyId) => (
              <span key={storyId} className="rounded bg-ui-blue/10 px-2 py-1 text-xs text-ui-blue">
                {storyId}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{item.canContinue ? 'Other work can continue' : 'Work is waiting for this answer'}</span>
          {item.blockingScope !== 'none' && <span>· Blocks {item.blockingScope}</span>}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{answerTypeHint(view.answerType)}</p>
          <AnswerChoices draft={draft} view={view} headingId={headingId} disabled={submitting} onChange={onChange} />
        </div>

        {view.recommendation && (
          <div className="rounded-md border border-ui-blue/20 bg-ui-blue/5 px-3 py-2 text-sm">
            <span className="font-medium text-ui-blue">{view.recommendation.label}: </span>
            <span className="break-words text-foreground/80">{view.recommendation.text}</span>
          </div>
        )}

        {defaultLabel !== null && (
          <p className="break-words text-sm">
            <span className="font-medium">Default: {defaultLabel}</span>
            <span className="text-muted-foreground"> · not selected; choose it above if it is your answer</span>
          </p>
        )}

        <div className="space-y-1" data-other-text>
          <label htmlFor={`${item.id}-other`} className="text-xs font-medium">{other.label}</label>
          <Textarea
            id={`${item.id}-other`}
            value={draft.text}
            maxLength={8000}
            disabled={submitting}
            onChange={(event) => onChange({ text: event.target.value })}
            placeholder={other.placeholder}
            className="min-h-24 resize-y"
          />
        </div>

        {draft.status === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-ui-red/25 bg-ui-red/5 px-3 py-2 text-sm text-ui-red">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">
              {draft.error}. Your draft is saved here. You can retry safely.
            </span>
          </div>
        )}

        {draft.status === 'conflict' && draft.currentItem && (
          <div className="space-y-3 rounded-md border border-ui-amber/30 bg-ui-amber/5 p-3">
            <div className="flex items-start gap-2 text-sm text-ui-amber">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {draft.currentItem.state === 'open'
                  ? 'The question changed before this answer was saved. Your draft remains above.'
                  : `This item is now ${draft.currentItem.state} on the server. Your unsaved draft remains above.`}
              </span>
            </div>
            {draft.currentItem.state === 'open' && (
              <Button type="button" variant="outline" size="sm" onClick={onAdoptCurrent}>
                Update draft for current question
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span id={reasonId} className="text-xs text-muted-foreground" data-submit-reason>
            {submit.reason ?? (draft.status === 'error' ? 'Saved locally in this page' : 'Saved only after the server confirms')}
          </span>
          <Button
            type="button"
            disabled={submit.disabled}
            aria-describedby={reasonId}
            onClick={onSubmit}
            className="w-full sm:w-auto"
          >
            {submitting ? <Clock3 className="h-4 w-4 animate-pulse" /> : <Send className="h-4 w-4" />}
            {submit.label}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

interface IMissionDeliveryCardProps {
  item: IMissionAttentionItem;
  answer: IMissionAnswer | undefined;
  delivery: IMissionDelivery | undefined;
  workspaceName: string;
}

const toneClass = {
  neutral: 'text-muted-foreground bg-muted',
  positive: 'text-ui-teal bg-ui-teal/10',
  warning: 'text-ui-amber bg-ui-amber/10',
  negative: 'text-ui-red bg-ui-red/10',
} as const;

export const AnsweredByRuleBadge = () => (
  <span className="inline-flex items-center gap-1 rounded bg-ui-teal/10 px-2 py-1 text-xs font-medium text-ui-teal">
    <Bot className="h-3.5 w-3.5" />Answered by rule
  </span>
);

const ITEM_STATE_LABELS: Readonly<Record<TMissionItemState, string>> = {
  candidate: 'Candidate',
  open: 'Open',
  answered: 'Answered, waiting for the agent',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

const itemStateLabel = (state: string): { label: string; served: string | null } =>
  Object.hasOwn(ITEM_STATE_LABELS, state)
    ? { label: ITEM_STATE_LABELS[state as TMissionItemState], served: null }
    : { label: 'Unknown state', served: state };

/** One item the bookkeeping rule answered (ADR-0031): the default it applied and the rule's note. */
export const MissionControlAutoAnswerCard = ({
  entry,
  workspaceName,
}: {
  entry: IMissionAutoAnsweredItem;
  workspaceName: string;
}) => {
  const state = itemStateLabel(entry.itemState);
  return (
    <Card className="min-w-0 border-foreground/10 shadow-none" data-auto-answered-item={entry.itemId}>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-2 py-1 font-medium text-foreground">{workspaceName}</span>
          <AttentionClassBadge value={entry.class} />
          <AnsweredByRuleBadge />
          <span title={state.served ? `Served state: ${state.served}` : undefined}>{state.label}</span>
          <span>·</span>
          <span>{formatMissionAge(entry.at)}</span>
        </div>
        <p className="break-words text-sm font-medium">{entry.title}</p>
        <p className="break-words text-sm">
          <span className="font-medium">Applied default: </span>
          {entry.appliedOptionLabel}
        </p>
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-auto-answer-note>
          {entry.note}
        </p>
      </CardContent>
    </Card>
  );
};

export const MissionControlDeliveryCard = ({
  item,
  answer,
  delivery,
  workspaceName,
}: IMissionDeliveryCardProps) => {
  const status = deliveryStatus(delivery);
  return (
    <Card className="min-w-0 border-foreground/10 shadow-none">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-2 py-1 text-xs font-medium">{workspaceName}</span>
          <span className={cn('rounded px-2 py-1 text-xs font-medium', toneClass[status.tone])}>
            {status.label}
          </span>
          {(item.autoAnswer !== null || answer?.actor === MISSION_AUTO_ANSWER_ACTOR) && <AnsweredByRuleBadge />}
        </div>
        <div>
          <p className="break-words text-sm font-medium">{item.title}</p>
          {answer && (
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {answer.text || (answer.actionCompleted ? 'Action marked complete' : `${answer.optionIds.length} option selected`)}
            </p>
          )}
        </div>
        {delivery?.state === 'queued' && delivery.lastError?.startsWith('inbox:') && (
          <p className="text-xs text-muted-foreground">Waiting in the orchestrator&apos;s inbox until its composer is free</p>
        )}
        {delivery?.lastError && !delivery.lastError.startsWith('inbox:') && (
          <div className="flex items-start gap-2 text-xs text-ui-red">
            <CircleHelp className="h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{delivery.lastError}</span>
          </div>
        )}
        {delivery?.nextAttemptAt && delivery.state === 'queued' && (
          <p className="text-xs text-muted-foreground">
            Next readiness check {formatMissionAge(delivery.nextAttemptAt)}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default MissionControlAnswerCard;
