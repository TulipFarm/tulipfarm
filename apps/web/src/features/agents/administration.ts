import type { z } from 'zod';
import type { executionPolicySchema } from '@tulipfarm/agents/contracts';
import type { agentPermissionSchema, agentPolicyDetailSchema } from '@tulipfarm/agents/saved-contracts';

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

export function fixSummary(errors: Readonly<Record<string, string | undefined>>, goal: string) {
  const count = Object.values(errors).filter(Boolean).length;
  return count ? `Fix ${count} ${count === 1 ? 'field' : 'fields'} to ${goal}.` : undefined;
}

export function slackSenderLabel(sender: 'user' | 'app' | undefined) {
  return sender === 'app' ? 'TulipFarm app' : 'My Slack account';
}
