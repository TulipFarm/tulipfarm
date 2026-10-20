import { agentSetupSchema, type AgentSetup, type AgentSetupDraft } from '@tulipfarm/agents/setup-contracts';
import type { AgentAuthoringSource } from '@tulipfarm/agents/authoring-assistance-contracts';
import { defaultTaskLimits, limitDraft, parseLimits } from '../tasks/limits.ts';
import { parseSchedule } from './administration.ts';
import type { AgentInput } from './api';
import type { BuilderAccessDraft } from './builder-access';
import type { BuilderChannel } from './builder-slack';
import type { BuilderSchedule } from './builder-schedules';
import type { BuilderStep } from './builder-layout';

export type BuilderDraft = {
  definition: AgentInput['definition'];
  owningTeamId: string | null;
  access: BuilderAccessDraft;
  channels: BuilderChannel[];
  schedules: BuilderSchedule[];
  source: AgentAuthoringSource;
};
export type BuilderInitial = Pick<
  AgentSetupDraft,
  | 'version'
  | 'setup'
  | 'expectedSoulRevision'
  | 'expectedSavedRevision'
  | 'expectedPolicyVersion'
  | 'expectedActivationIds'
  | 'commandId'
>;

export function builderDraft(initial?: BuilderInitial): BuilderDraft {
  const setup = initial?.setup;
  return {
    definition: setup?.definition ?? { name: '', instructions: '', tools: [], skills: [], responseRule: 'tag' },
    owningTeamId: setup?.owningTeamId ?? null,
    source: { version: initial?.version ?? 0, fingerprint: crypto.randomUUID() },
    access: {
      grants: setup?.policy.grants ?? [],
      personGrants: setup?.policy.personGrants ?? [],
      enrollment: setup?.enrollment ?? [],
      scope: setup?.scope ?? [],
      limits: setup?.limits ?? [],
      slackSender: setup?.slackSender ?? 'user',
      taskLimits: limitDraft(setup?.taskLimits ?? defaultTaskLimits),
      mcp: (setup?.definition.mcp ?? []).map(slot => ({
        slotId: slot.id,
        label: slot.id,
        serverIdentity: slot.serverIdentity,
        tools: slot.tools,
        binding: slot.integrationId ? { kind: 'shared', integrationId: slot.integrationId } : { kind: 'personal' },
      })),
    },
    channels: (setup?.slackChannels ?? []).map(channel => ({
      ...channel,
      name: channel.channel,
      channelResponses: null,
      replaceConsent: false,
    })),
    schedules: (setup?.schedules ?? []).map(schedule => ({
      id: schedule.id,
      kind: 'task',
      activationId: '',
      text: schedule.action.text,
      tableId: '',
      cadence: schedule.trigger.kind,
      minutes: {
        task: schedule.trigger.kind === 'interval' ? String(schedule.trigger.minutes) : '1440',
        inspect: '60',
      },
      cronExpression: schedule.trigger.kind === 'cron' ? schedule.trigger.expression : '0 9 * * 1',
      timezone:
        schedule.trigger.kind === 'cron' ? schedule.trigger.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
      limits: limitDraft(schedule.action.limits),
      sponsorConsent: false,
      sponsorMembershipId: schedule.sponsorMembershipId,
    })),
  };
}

export function builderDefinition(draft: BuilderDraft): BuilderDraft['definition'] {
  return {
    ...draft.definition,
    mcp: draft.access.mcp.map(slot => ({
      id: slot.slotId,
      serverIdentity: slot.serverIdentity,
      tools: slot.tools,
      ...(slot.binding.kind === 'shared' ? { integrationId: slot.binding.integrationId } : {}),
    })),
  };
}

export function parseBuilder(draft: BuilderDraft, membershipId: string, activating: boolean, agentId: string) {
  const problems: { step: BuilderStep; message: string }[] = [];
  if (!draft.definition.name.trim() || draft.definition.name.length > 120)
    problems.push({ step: 'basics', message: 'Use an agent name from 1 to 120 characters.' });
  if (!draft.definition.instructions.trim() || draft.definition.instructions.length > 32000)
    problems.push({ step: 'basics', message: 'Write instructions from 1 to 32,000 characters.' });
  if (draft.definition.tools.length > 20) problems.push({ step: 'access', message: 'Choose no more than 20 actions.' });
  if ((draft.definition.skills?.length ?? 0) > 16)
    problems.push({ step: 'skills', message: 'Choose no more than 16 skills.' });
  const limits = parseLimits(draft.access.taskLimits, { kind: 'start' });
  if (!limits.ok) problems.push({ step: 'access', message: 'Check the execution limits.' });
  const schedules: AgentSetup['schedules'] = [];
  for (const schedule of draft.schedules) {
    const parsed = parseSchedule({ ...schedule, sponsorConsent: !activating || schedule.sponsorConsent }, 0, false);
    if (
      Object.values(parsed.errors).some(Boolean) ||
      !parsed.action ||
      parsed.action.kind !== 'task' ||
      !parsed.trigger
    )
      problems.push({
        step: 'triggers',
        message: `Check schedule ${draft.schedules.indexOf(schedule) + 1}: ${Object.values(parsed.errors).filter(Boolean).join(' ')}`,
      });
    else
      schedules.push({
        id: schedule.id,
        action: parsed.action,
        trigger: parsed.trigger,
        sponsorMembershipId: schedule.sponsorConsent ? membershipId : (schedule.sponsorMembershipId ?? membershipId),
      });
  }
  if (activating) {
    if (draft.channels.some(channel => !channel.detach && !channel.channelResponses))
      problems.push({
        step: 'triggers',
        message: 'Recheck channel delivery before activation. DM-only channels cannot be activated here.',
      });
    if (
      draft.channels.some(
        channel => channel.replaceAgentId && channel.replaceAgentId !== agentId && !channel.replaceConsent,
      )
    )
      problems.push({ step: 'triggers', message: 'Confirm each existing Slack agent replacement.' });
  }
  const parsed = agentSetupSchema.safeParse({
    definition: builderDefinition(draft),
    owningTeamId: draft.owningTeamId,
    policy: { grants: draft.access.grants, personGrants: draft.access.personGrants },
    enrollment: draft.access.enrollment,
    scope: draft.access.scope,
    limits: draft.access.limits,
    taskLimits: limits.ok ? limits.limits : undefined,
    slackSender: draft.access.slackSender,
    slackChannels: draft.channels.map(({ channel, expectedVersion, replaceAgentId, detach }) => ({
      channel,
      expectedVersion,
      replaceAgentId,
      ...(detach === undefined ? {} : { detach }),
    })),
    schedules,
  });
  if (!parsed.success && !problems.length)
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      problems.push({
        step:
          field === 'definition'
            ? issue.path[1] === 'skills'
              ? 'skills'
              : issue.path[1] === 'tools' || issue.path[1] === 'mcp'
                ? 'access'
                : 'basics'
            : field === 'schedules' || field === 'slackChannels'
              ? 'triggers'
              : 'access',
        message: issue.message,
      });
    }
  return { setup: parsed.success && !problems.length ? parsed.data : null, problems };
}
