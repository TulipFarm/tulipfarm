import { useId } from 'react';
import {
  CalendarClockIcon,
  ChevronRightIcon,
  ClockIcon,
  GitPullRequestIcon,
  LayersIcon,
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
import type { DisabledReason, TriggerKind, workflowSchema } from '@tulipfarm/workflows/contracts';
import type { z } from 'zod';
import { liveTriggers, triggersLine } from './triggers';

export { triggerLine } from './triggers';

type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowState = { mark: StatusState; label: string; detail?: string | undefined };

export const triggerIcons: Record<TriggerKind, LucideIcon> = {
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

/** One trigger's icon, a play icon for a Workflow started only by hand, or a stack for several triggers. */
export function TriggerIcon({
  trigger,
  triggers = trigger ? [trigger] : [],
  size = 'md',
}: {
  trigger?: { kind: string };
  triggers?: readonly { kind: string }[];
  size?: 'md' | 'lg';
}) {
  const Icon =
    triggers.length > 1 ? LayersIcon : ((triggers[0] && triggerIcons[triggers[0].kind as TriggerKind]) ?? PlayIcon);
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
  tableNames,
  onOpen,
}: {
  workflow: Workflow;
  state: WorkflowState;
  href: string;
  disabled: boolean;
  tableNames?: ReadonlyMap<string, string>;
  onOpen: () => void;
}) {
  const id = useId();
  const triggers = liveTriggers(workflow);
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
      <TriggerIcon triggers={triggers} />
      <span className="flex min-w-0 flex-1 flex-col gap-x-3 gap-y-1 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{workflow.definition.name}</span>
          <span id={`${id}-trigger`} className="block truncate text-sm text-muted-foreground">
            {triggersLine(triggers, tableNames)}
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
const sponsorSource: Partial<Record<TriggerKind, string>> = {
  record: 'to read the table a record trigger watches',
  row: 'to read the table a row trigger watches',
  provider: 'to use the connected app a trigger polls',
};
const sponsorNeeds = (workflow: Workflow) => {
  const needs = [...new Set(liveTriggers(workflow).flatMap(trigger => sponsorSource[trigger.kind] ?? []))];
  return needs.length ? ` or ${needs.join(' or ')}` : '';
};
export const disabledReasons: Record<
  DisabledReason,
  { status: string; explanation: (workflow: Workflow) => string; recovery: string }
> = {
  'sponsor-access-lost': {
    status: 'access lost',
    explanation: workflow => `the person who turned it on lost access needed to run it${sponsorNeeds(workflow)}`,
    recovery: 'Restore that access, or have someone with it activate the saved revision.',
  },
  'record-field-unavailable': {
    status: 'record field unavailable',
    explanation: () => 'the table, watched fields, or filter its trigger uses is no longer available',
    recovery: 'Edit the trigger in chat, then activate the new revision.',
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
