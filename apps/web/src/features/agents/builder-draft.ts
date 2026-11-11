import {
  agentSetupSchema,
  tableAccessEnrollment,
  tableAccessProblem,
  type AgentSetup,
  type AgentSetupDraft,
} from '@tulipfarm/agents/setup-contracts';
import type { AgentAuthoringSource } from '@tulipfarm/agents/authoring-assistance-contracts';
import { defaultTaskLimits, limitDraft, parseLimits } from '../tasks/limits.ts';
import type { AgentContext, AgentInput } from './api';
import type { BuilderAccessDraft } from './builder-access';
import type { BuilderChannel } from './builder-slack';
import type { BuilderTrigger } from './builder-triggers';
import type { BuilderStep } from './builder-layout';

export type BuilderDraft = {
  definition: AgentInput['definition'];
  owningTeamId: string | null;
  access: BuilderAccessDraft;
  channels: BuilderChannel[];
  triggers: BuilderTrigger[];
  /** What each trigger asks the agent; set in chat, kept as is here. */
  prompt: string | undefined;
  runLimits: AgentSetup['runLimits'];
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
  | 'expectedWorkflowRevision'
  | 'expectedWorkflowGeneration'
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
    triggers: setup?.triggers ?? [],
    prompt: setup?.prompt,
    runLimits: setup?.runLimits,
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

export function nextBuilderStep(step: BuilderStep, draft: BuilderDraft): BuilderStep {
  const skills = !!draft.definition.skills?.length;
  const triggers = !!draft.triggers.length || !!draft.channels.length || !!draft.prompt;
  if (step === 'basics') {
    const tables = draft.access.limits.some(entry => entry.permissions.includes('table.row.read'));
    return tables && !skills && !triggers ? 'review' : 'access';
  }
  if (step === 'access' && skills) return 'skills';
  if ((step === 'access' || step === 'skills') && triggers) return 'triggers';
  return 'review';
}

export function updateBuilderLimits(
  access: BuilderAccessDraft,
  limits: BuilderAccessDraft['limits'],
  teams: AgentContext['teams'],
) {
  let scope = access.scope.filter(entry => limits.some(limit => limit.assetId === entry.assetId));
  let enrollment = access.enrollment;
  for (const limit of limits) {
    const previous = access.limits.find(entry => entry.assetId === limit.assetId);
    if (
      !previous ||
      previous.permissions.length !== limit.permissions.length ||
      previous.permissions.some(permission => !limit.permissions.includes(permission))
    ) {
      scope = [...scope.filter(entry => entry.assetId !== limit.assetId), limit];
      enrollment = tableAccessEnrollment(teams, limit, enrollment);
    }
  }
  return { limits, scope, enrollment };
}

export function parseBuilder(
  draft: BuilderDraft,
  membershipId: string,
  activating: boolean,
  agentId: string,
  access?: { teams: AgentContext['teams']; previous?: AgentSetup | undefined },
) {
  const problems: { step: BuilderStep; message: string }[] = [];
  const tableProblem =
    access && tableAccessProblem(access.teams, draft.access.scope, draft.access.enrollment, access.previous);
  if (tableProblem) problems.push({ step: 'access', message: tableProblem });
  if (!draft.definition.name.trim() || draft.definition.name.length > 120)
    problems.push({ step: 'basics', message: 'Use an agent name from 1 to 120 characters.' });
  if (!draft.definition.instructions.trim() || draft.definition.instructions.length > 32000)
    problems.push({ step: 'basics', message: 'Write instructions from 1 to 32,000 characters.' });
  if (draft.definition.tools.length > 20) problems.push({ step: 'access', message: 'Choose no more than 20 actions.' });
  if ((draft.definition.skills?.length ?? 0) > 16)
    problems.push({ step: 'skills', message: 'Choose no more than 16 skills.' });
  const limits = parseLimits(draft.access.taskLimits, { kind: 'start' });
  if (!limits.ok) problems.push({ step: 'access', message: 'Check the execution limits.' });
  if (activating) {
    if (
      draft.access.scope.some(entry => entry.permissions.includes('table.row.read')) &&
      !draft.definition.tools.some(tool => tool === 'rows.list' || tool === 'rows.get')
    )
      problems.push({
        step: 'access',
        message:
          'This agent has table access but no action that reads rows. Add Find rows or Read a row in the Access step, or remove its table access.',
      });
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
    triggers: draft.triggers,
    ...(draft.prompt === undefined ? {} : { prompt: draft.prompt }),
    ...(draft.runLimits === undefined ? {} : { runLimits: draft.runLimits }),
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
            : field === 'triggers' || field === 'slackChannels' || field === 'prompt' || field === 'runLimits'
              ? 'triggers'
              : 'access',
        message: issue.message,
      });
    }
  return { setup: parsed.success && !problems.length ? parsed.data : null, problems };
}
