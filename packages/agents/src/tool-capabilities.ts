import { z } from 'zod';

const sharedTools = [
  'schema.inspect',
  'schema.status',
  'rows.list',
  'rows.summarize',
  'rows.resolveReference',
  'rows.reverse',
  'rows.get',
  'tables.list',
  'skills.list',
  'skills.read',
  'web.fetch',
  'web.search',
  'slack.message.send',
  'slack.thread.reply',
  'slack.reaction.add',
] as const;

const taskOnlyTools = [
  'agents.task.start',
  'agents.task.read',
  'skills.execute',
  'skills.files.read',
  'github.personal.account',
  'github.personal.read',
  'github.personal.download',
  'github.personal.propose',
  'github.investigation.account',
  'github.investigation.repositories',
  'github.investigation.read',
  'mcp.call',
  'mcp.search',
  'mcp.describe',
  'knowledge.search',
  'knowledge.read',
  'knowledge.retrieve',
  'images.generate',
] as const;

const taskProposalTools = ['rows.create', 'rows.update', 'rows.delete'] as const;
const slackChannelOnlyTools = [
  'github.issue.read',
  'google.read',
  'google.propose',
  'google.status',
  'google.execute',
] as const;
const slackChannelToolNames = [...sharedTools, ...slackChannelOnlyTools] as const;

export const toolNameSchema = z.enum([
  ...sharedTools,
  ...taskOnlyTools,
  ...taskProposalTools,
  ...slackChannelOnlyTools,
]);

export const taskDirectToolNames = [...sharedTools, ...taskOnlyTools] as const;
const taskToolNames = [...taskDirectToolNames, ...taskProposalTools] as const;
export const agentRuntimeToolNames = {
  task: taskToolNames,
  schedule: taskToolNames,
  workflowStep: taskToolNames,
  slackChannel: slackChannelToolNames,
} as const;

const runtimeLabels = {
  task: 'private tasks',
  schedule: 'schedules',
  workflowStep: 'workflow steps',
  slackChannel: 'Slack channel agents',
} as const;

export function supportedAgentToolRuntimes(tool: string) {
  return (Object.keys(agentRuntimeToolNames) as (keyof typeof agentRuntimeToolNames)[]).filter(runtime =>
    (agentRuntimeToolNames[runtime] as readonly string[]).includes(tool),
  );
}

export function agentToolRuntimeDescription(tool: string) {
  const labels = supportedAgentToolRuntimes(tool).map(runtime => runtimeLabels[runtime]);
  return labels.length ? `Available to ${labels.join(', ')}.` : 'Unavailable to saved-agent runtimes.';
}
