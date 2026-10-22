import type { z } from 'zod';
import type { executionPolicySchema } from '@tulipfarm/agents/contracts';
import type { agentPermissionSchema, agentPolicyDetailSchema } from '@tulipfarm/agents/saved-contracts';
import {
  scheduleTriggerSchema,
  taskScheduleMinimumMinutes,
  type ScheduleAction,
  type ScheduleTrigger,
} from '@tulipfarm/agents/schedule-contracts';
import { cronGapMinutes } from '../workflows/calendar-schedule.ts';
import { parseLimits, type LimitDraft } from '../tasks/limits.ts';

export type Policy = z.infer<typeof agentPolicyDetailSchema>;
export type TeamPermission = z.infer<typeof agentPermissionSchema>;
export type RecordPermission = 'table.row.read' | 'table.row.create' | 'table.row.update' | 'table.row.delete';
type ExecutionInput = z.infer<typeof executionPolicySchema>;

export function sameAccess<T extends { permissions: readonly string[] }>(
  a: readonly T[],
  b: readonly T[],
  key: (row: T) => string,
) {
  const canonical = (rows: readonly T[]) =>
    rows
      .filter(row => row.permissions.length)
      .map(row => `${key(row)}:${[...new Set(row.permissions)].sort().join(',')}`)
      .sort()
      .join(' ');
  return canonical(a) === canonical(b);
}

export function sameTeams(a: readonly string[], b: readonly string[]) {
  return [...new Set(a)].sort().join(' ') === [...new Set(b)].sort().join(' ');
}

export function enrollmentInput(base: Policy, teamIds: string[]): ExecutionInput {
  return { version: base.version, teamIds, limits: base.limits, taskLimits: base.taskLimits, enabled: base.enabled };
}

export function executionInput(
  base: Policy,
  draft: {
    enabled: boolean;
    limits: Policy['limits'];
    taskLimits: Policy['taskLimits'];
    slackSender: Policy['slackSender'];
    resource: string;
    tablePermissions: readonly RecordPermission[];
  },
): ExecutionInput {
  const limits = draft.limits.map(limit => ({ ...limit, permissions: [...limit.permissions] }));
  if (draft.resource) {
    const existing = limits.find(limit => limit.assetId === draft.resource);
    if (existing)
      existing.permissions.push(
        ...draft.tablePermissions.filter(permission => !existing.permissions.includes(permission)),
      );
    else limits.push({ assetId: draft.resource, permissions: [...draft.tablePermissions] });
  }
  return {
    version: base.version,
    teamIds: base.enrollment,
    limits,
    taskLimits: draft.taskLimits,
    enabled: draft.enabled,
    slackSender: draft.slackSender,
  };
}

export function destinationErrors(draft: { teamId: string; name: string; channel: string }) {
  return {
    team: draft.teamId ? undefined : 'Choose a team for this channel.',
    name: draft.name.trim() ? undefined : 'Enter a name for this destination.',
    channel: /^[CG][A-Z0-9]+$/.test(draft.channel) ? undefined : 'Enter a channel ID that starts with C or G.',
  };
}

export type ScheduleKind = ScheduleAction['kind'];
/** Holds both kinds' inputs so switching what runs keeps the other kind's draft. */
export type ScheduleDraft = {
  kind: ScheduleKind;
  cadence: ScheduleTrigger['kind'];
  text: string;
  tableId: string;
  limits: LimitDraft;
  activationId: string;
  minutes: Record<ScheduleKind, string>;
  cronExpression: string;
  timezone: string;
  sponsorConsent: boolean;
};
export const scheduleMinimumMinutes: Record<ScheduleKind, number> = { inspect: 1, task: taskScheduleMinimumMinutes };
const promptMaximum = 8000;

export function intervalError(kind: ScheduleKind, intervalMinutes: number) {
  const minimum = scheduleMinimumMinutes[kind];
  return Number.isInteger(intervalMinutes) && intervalMinutes >= minimum && intervalMinutes <= 10080
    ? undefined
    : `Enter whole minutes from ${minimum} to 10,080.`;
}

export function parseSchedule(
  draft: ScheduleDraft,
  activations: number,
  requireActivation = true,
): { errors: Record<string, string | undefined>; action: ScheduleAction | null; trigger: ScheduleTrigger | null } {
  const intervalMinutes = Number(draft.minutes[draft.kind]);
  const candidate =
    draft.cadence === 'interval'
      ? { kind: 'interval' as const, minutes: intervalMinutes }
      : { kind: 'cron' as const, expression: draft.cronExpression, timezone: draft.timezone };
  const parsedTrigger = scheduleTriggerSchema.safeParse(candidate);
  const common = {
    activation:
      !requireActivation || draft.activationId
        ? undefined
        : activations
          ? 'Choose the instructions to run.'
          : 'Activate the instructions in Execution first.',
    cadence:
      draft.cadence === 'interval'
        ? intervalError(draft.kind, intervalMinutes)
        : !parsedTrigger.success || parsedTrigger.data.kind !== 'cron'
          ? 'Enter a valid cron expression and IANA time zone.'
          : draft.kind === 'task' && (cronGapMinutes(parsedTrigger.data) ?? Infinity) < taskScheduleMinimumMinutes
            ? 'Prompt schedules run at most once an hour. Choose runs at least an hour apart.'
            : undefined,
    sponsor: draft.sponsorConsent ? undefined : 'Confirm that you sponsor this schedule.',
  };
  if (draft.kind === 'inspect') {
    const errors = { resource: draft.tableId ? undefined : 'Choose a table to inspect.', ...common };
    return {
      errors,
      action: Object.values(errors).some(Boolean) ? null : { kind: 'inspect', tableId: draft.tableId },
      trigger: parsedTrigger.success ? parsedTrigger.data : null,
    };
  }
  const text = draft.text.trim();
  const limits = parseLimits(draft.limits, { kind: 'start' });
  const errors = {
    prompt: !text
      ? 'Write the prompt each run starts with.'
      : text.length > promptMaximum
        ? 'Shorten the prompt to 8,000 characters or fewer.'
        : undefined,
    ...common,
    ...(limits.ok ? {} : limits.errors),
  };
  return {
    errors,
    action: limits.ok && !Object.values(errors).some(Boolean) ? { kind: 'task', text, limits: limits.limits } : null,
    trigger: parsedTrigger.success ? parsedTrigger.data : null,
  };
}

export function fixSummary(errors: Readonly<Record<string, string | undefined>>, goal: string) {
  const count = Object.values(errors).filter(Boolean).length;
  return count ? `Fix ${count} ${count === 1 ? 'field' : 'fields'} to ${goal}.` : undefined;
}

export function slackSenderLabel(sender: 'user' | 'app' | undefined) {
  return sender === 'app' ? 'TulipFarm app' : 'My Slack account';
}
