import {
  isScheduleTrigger,
  onceTriggerName,
  type Trigger,
  type TriggerKind,
  type WorkflowTrigger,
  type workflowSchema,
} from '@tulipfarm/workflows/contracts';
import type { z } from 'zod';
import { cronSummary, ordinaryCron } from './calendar-schedule.ts';
import { githubShortSummary } from './definition-description.ts';
import { rowTriggerLine, workflowDuration } from './diagram-model.ts';

type Workflow = z.infer<typeof workflowSchema>;
/** A trigger's settings without its identity, as the per-kind controls edit them. */
export type TriggerBody<T extends Trigger = Trigger> = T extends Trigger ? Omit<T, 'id' | 'label'> : never;

export const triggerKindNames: Record<TriggerKind, string> = {
  cron: 'Schedule',
  interval: 'Repeat',
  once: 'One time',
  webhook: 'Webhook',
  github: 'GitHub',
  record: 'Record date',
  row: 'Row change',
  provider: 'Connected app',
  event: 'App event',
};

/** A short description of a trigger's settings, such as "Every day at 09:00 in UTC" or "GitHub push". */
export function triggerLine(trigger: TriggerBody | Trigger, tableNames?: ReadonlyMap<string, string>): string {
  switch (trigger.kind) {
    case 'interval':
      return `Every ${workflowDuration(trigger.minutes * 60)}`;
    case 'cron':
      return ordinaryCron(trigger.expression)
        ? cronSummary(trigger).replace(/\.$/, '')
        : `Schedule ${trigger.expression} in ${trigger.timezone.replaceAll('_', ' ')}`;
    case 'once':
      return Number.isFinite(Date.parse(trigger.at)) ? onceTriggerName(trigger.at, trigger.timezone) : 'One time';
    case 'github':
      return githubShortSummary(trigger);
    case 'event':
      return `App event ${trigger.name}`;
    case 'row':
      return rowTriggerLine(trigger, tableNames?.get(trigger.tableId));
    case 'provider':
      return trigger.event === 'updated' ? 'Connected app updates' : 'Connected app items';
    default:
      return triggerKindNames[trigger.kind];
  }
}

/** The trigger's label, or a summary of its settings when it has none. */
export const triggerName = (trigger: Trigger, tableNames?: ReadonlyMap<string, string>) =>
  trigger.label ?? triggerLine(trigger, tableNames);

/** "Started by hand", one trigger's name, or "3 triggers: Every day at 09:00, Webhook, GitHub push". */
export function triggersLine(triggers: readonly Trigger[], tableNames?: ReadonlyMap<string, string>) {
  if (!triggers.length) return 'Started by hand';
  if (triggers.length === 1) return triggerName(triggers[0]!, tableNames);
  return `${triggers.length} triggers: ${triggers.map(trigger => triggerName(trigger, tableNames)).join(', ')}`;
}

/** The triggers that start runs now: the active revision's while enabled, otherwise the saved ones. */
export const liveTriggers = (workflow: Workflow): Trigger[] =>
  workflow.enabled ? (workflow.activeTriggers ?? workflow.definition.triggers) : workflow.definition.triggers;

/** The view state of a live trigger, when the active revision has it. */
export const triggerState = (workflow: Workflow, id: string): WorkflowTrigger | undefined =>
  workflow.triggers.find(item => item.id === id);

/** A new trigger ID unique in this definition; random so it never reuses an ID from earlier revisions. */
export function newTriggerId(kind: TriggerKind, taken: Iterable<string>) {
  const used = new Set(taken);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const id = `${kind}_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    if (!used.has(id)) return id;
  }
}

/** Names a run's trigger by its ID, using the definition the run used when it still has it. */
export function runTriggerName(
  id: string | null,
  triggers: readonly Trigger[],
  tableNames?: ReadonlyMap<string, string>,
) {
  if (id === null) return 'Started by hand';
  const trigger = triggers.find(item => item.id === id);
  return trigger ? triggerName(trigger, tableNames) : `Removed trigger ${id}`;
}

export const scheduleTriggers = (triggers: readonly Trigger[]) => triggers.filter(isScheduleTrigger);

/** True when nobody but the person starting a run acts in it: no triggers, or only app events. */
export const startedByPerson = (triggers: readonly Trigger[]) => triggers.every(trigger => trigger.kind === 'event');

/** Every trigger the saved or active revision has, saved order first, each listed once by ID. */
export function knownTriggers(workflow: Workflow): Trigger[] {
  const saved = workflow.definition.triggers;
  return [...saved, ...(workflow.activeTriggers ?? []).filter(item => !saved.some(other => other.id === item.id))];
}
