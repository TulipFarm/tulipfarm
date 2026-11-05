import { useId } from 'react';
import {
  CalendarClockIcon,
  ChevronRightIcon,
  ClockIcon,
  GitPullRequestIcon,
  PlayIcon,
  PlugIcon,
  RepeatIcon,
  Rows3Icon,
  TableIcon,
  WebhookIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import type { Definition, DisabledReason, workflowSchema } from '@tulipfarm/workflows/contracts';
import type { z } from 'zod';
import { cronSummary, ordinaryCron } from './calendar-schedule';
import { triggerTitles, workflowDuration } from './diagram-model';

type Workflow = z.infer<typeof workflowSchema>;
type Trigger = Definition['trigger'];
export type WorkflowState = { mark: StatusState; label: string; detail?: string | undefined };

const triggerIcons: Record<Trigger['kind'], LucideIcon> = {
  manual: PlayIcon,
  webhook: WebhookIcon,
  event: ZapIcon,
  provider: PlugIcon,
  github: GitPullRequestIcon,
  once: ClockIcon,
  interval: RepeatIcon,
  cron: CalendarClockIcon,
  record: TableIcon,
  row: Rows3Icon,
};

/** The trigger that starts runs now: the active revision's while enabled, otherwise the saved one. */
export const liveTrigger = (workflow: Workflow) =>
  workflow.enabled ? (workflow.activeTrigger ?? workflow.definition.trigger) : workflow.definition.trigger;

export function triggerLine(trigger: Trigger) {
  if (trigger.kind === 'interval') return `Every ${workflowDuration(trigger.minutes * 60)}`;
  if (trigger.kind === 'cron' && ordinaryCron(trigger.expression)) return cronSummary(trigger).replace(/\.$/, '');
  return triggerTitles[trigger.kind];
}

export function TriggerIcon({ trigger, size = 'md' }: { trigger: Trigger; size?: 'md' | 'lg' }) {
  const Icon = triggerIcons[trigger.kind];
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-lg border border-border bg-card text-foreground ${size === 'lg' ? 'size-12' : 'size-8'}`}
    >
      <Icon size={size === 'lg' ? 20 : 16} />
    </span>
  );
}

export function WorkflowRow({
  workflow,
  state,
  href,
  disabled,
  onOpen,
}: {
  workflow: Workflow;
  state: WorkflowState;
  href: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  const id = useId();
  const trigger = liveTrigger(workflow);
  return (
    <a
      href={href}
      aria-label={workflow.definition.name}
      aria-describedby={`${id}-trigger ${id}-status`}
      aria-disabled={disabled || undefined}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        if (!disabled) onOpen();
      }}
      className="flex min-h-16 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
    >
      <TriggerIcon trigger={trigger} />
      <span className="flex min-w-0 flex-1 flex-col gap-x-3 gap-y-1 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{workflow.definition.name}</span>
          <span id={`${id}-trigger`} className="block truncate text-sm text-muted-foreground">
            {triggerLine(trigger)}
          </span>
        </span>
        <span id={`${id}-status`} className="sm:w-56 sm:shrink-0">
          <StatusLine state={state} />
        </span>
      </span>
      <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function StatusLine({ state }: { state: WorkflowState }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Status state={state.mark} size="sm" aria-hidden="true" tooltip={false} />
        {state.label}
      </span>
      {state.detail && <span className="truncate ps-4.5 text-xs text-muted-foreground">{state.detail}</span>}
    </span>
  );
}

const formatTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const nextRun = (workflow: Workflow) => (workflow.nextRunAt ? `Next run ${formatTime(workflow.nextRunAt)}` : undefined);
const sponsorSource: Partial<Record<Definition['trigger']['kind'], string>> = {
  record: ' or to read the table its record trigger watches',
  row: ' or to read the table its row trigger watches',
  provider: ' or to use the connected app its trigger polls',
};
export const disabledReasons: Record<
  DisabledReason,
  { status: string; explanation: (workflow: Workflow) => string; recovery: string }
> = {
  'sponsor-access-lost': {
    status: 'sponsor lost access',
    explanation: workflow =>
      `its sponsor lost access needed to run it${sponsorSource[(workflow.activeTrigger ?? workflow.definition.trigger).kind] ?? ''}`,
    recovery: 'Restore that access or choose a sponsor who has it, then activate the saved revision.',
  },
  'record-field-unavailable': {
    status: 'record field unavailable',
    explanation: () => 'the table, watched fields, or filter its trigger uses is no longer available',
    recovery: 'Edit the trigger in chat. Once its sponsor accepts the new revision, activate it.',
  },
  'provider-backlog': {
    status: 'connected app backlog',
    explanation: () => 'too many connected-app events waited to start runs',
    recovery: 'Activate the saved revision to discard the waiting events and collect only new ones.',
  },
};
export function workflowState(workflow: Workflow): WorkflowState {
  if (workflow.archivedAt) return { mark: 'stopped', label: 'Archived', detail: formatTime(workflow.archivedAt) };
  if (workflow.enabled && workflow.activeRevision !== workflow.revision)
    return { mark: 'warning', label: 'Saved changes not active', detail: nextRun(workflow) };
  if (workflow.enabled) return { mark: 'success', label: 'Active', detail: nextRun(workflow) };
  if (workflow.disabledReason)
    return { mark: 'error', label: `Disabled: ${disabledReasons[workflow.disabledReason].status}` };
  return { mark: 'stopped', label: 'Disabled' };
}
