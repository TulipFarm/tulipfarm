import { z } from 'zod';
import { googleToolActivity } from './google-tool-activity.ts';

export const workflowReferenceSchema = z.object({ workflowId: z.uuid(), revision: z.uuid(), name: z.string() });
export const legacyToolNames: Record<string, string> = {
  'resources.v2.list': 'tables.definitions',
  'records.v2.list': 'rows.page',
};
export function currentToolName(tool: string) {
  return legacyToolNames[tool] ?? tool;
}
export function renameLegacyToolCall(value: unknown) {
  return value &&
    typeof value === 'object' &&
    'tool' in value &&
    typeof value.tool === 'string' &&
    value.tool in legacyToolNames
    ? { ...value, tool: legacyToolNames[value.tool] }
    : value;
}
export const toolActivityLabels = {
  'bud.preference.ask': 'Asking about your preferences',
  'bud.preference.propose': 'Preparing a preference for review',
  'present.choice': 'Asking you to choose',
  'tables.list': 'Listing business tables',
  'tables.definitions': 'Listing business tables',
  'tables.propose': 'Preparing table changes for review',
  'tables.import.attachments': 'Listing attachments available for import',
  'tables.import.file': 'Preparing a file for import',
  'rows.list': 'Listing rows',
  'rows.page': 'Listing rows',
  'rows.summarize': 'Summarizing rows',
  'rows.resolveReference': 'Looking up linked rows',
  'rows.reverse': 'Reading reverse relationship links',
  'rows.get': 'Reading a row',
  'rows.create': 'Creating a row',
  'rows.create.batch': 'Creating rows',
  'rows.update': 'Updating a row',
  'rows.delete': 'Deleting a row',
  'schema.context': 'Checking table authoring permissions',
  'schema.inspect': 'Inspecting table fields',
  'schema.status': 'Checking table publication',
  'agents.list': 'Listing agents',
  'agents.read': 'Reading agent instructions',
  'agents.context': 'Checking agent authoring permissions',
  'agents.draft': 'Preparing agent instructions for review',
  'agents.status': 'Checking whether agent instructions were saved',
  'agents.task.start': 'Delegating work to an agent',
  'agents.task.read': 'Checking delegated task progress',
  'plans.create': 'Planning the work',
  'plans.read': 'Checking plan progress',
  'plans.update': 'Updating the plan',
  'plans.start': 'Starting the plan',
  'plans.claim': 'Starting a plan task',
  'plans.report': 'Recording checked plan results',
  'skills.list': 'Checking available procedures',
  'skills.read': 'Reading a procedure',
  'skills.workspace': 'Listing reviewed workspace skills',
  'skills.draft': 'Preparing a workspace skill for review',
  'skills.workspace.read': 'Reading a workspace skill',
  'skills.load': 'Loading a reviewed workspace skill',
  'skills.files.read': 'Reading a skill resource',
  'skills.execute': 'Running an isolated skill script',
  'skills.import': 'Preparing skill packages from a link',
  'skills.import.status': 'Checking a skill package review',
  'skills.import.select': 'Preparing selected skills for safety review',
  'workflows.list': 'Listing workflows',
  'workflows.read': 'Reading a workflow',
  'workflows.providers': 'Reading connected workflow sources',
  'workflows.draft': 'Preparing a workflow for review',
  'web.search': 'Searching the web',
  'knowledge.search': 'Searching knowledge',
  'knowledge.read': 'Reading a knowledge source',
  'knowledge.retrieve': 'Reading knowledge sources',
  'web.fetch': 'Reading a web page',
  'conversation.messages.read': 'Rereading an earlier message',
  'files.create': 'Saving a file to Files',
  'slack.resolve': 'Finding a Slack channel or person',
  'slack.message.send': 'Sending a Slack message',
  'slack.thread.reply': 'Replying to a Slack thread',
  'slack.reaction.add': 'Adding a Slack reaction',
  'github.issue.read': 'Reading a GitHub issue',
  'github.personal.account': 'Checking available GitHub accounts',
  'github.investigation.account': 'Choosing a private GitHub investigation source',
  'github.investigation.repositories': 'Finding permitted GitHub repositories',
  'github.investigation.read': 'Reading GitHub investigation evidence',
  'github.personal.read': 'Reading GitHub information',
  'github.personal.download': 'Preparing a GitHub download',
  'github.personal.propose': 'Preparing GitHub changes for review',
  'github.personal.execute': 'Executing approved GitHub changes',
  'google.read': 'Reading Google Workspace information',
  'google.propose': 'Preparing a Google action for review',
  'google.status': 'Checking a Google action approval and outcome',
  'google.execute': 'Executing an approved Google action',
  'atlassian.sources': 'Listing connected Jira, Confluence, and Trello sources',
  'atlassian.read': 'Reading a connected Atlassian source',
  'atlassian.propose': 'Preparing an Atlassian action for review',
  'atlassian.proposal': 'Checking an Atlassian action approval and outcome',
  'atlassian.execute': 'Executing an approved Atlassian action',
  'social.list.channels': 'Listing social channels',
  'social.prepare.post': 'Preparing a social post for review',
  'social.read.post': 'Checking a social post',
  'social.revise.post': 'Revising a social post for review',
  'mcp.search': 'Finding tools in connected apps',
  'mcp.describe': 'Inspecting a connected app tool',
  'mcp.call': 'Calling a connected app tool',
};

const internalTools = new Set([
  'skills.list',
  'skills.read',
  'skills.workspace',
  'skills.workspace.read',
  'skills.load',
  'skills.files.read',
  'skills.import.status',
  'schema.context',
  'schema.inspect',
  'schema.status',
  'agents.context',
  'agents.status',
  'google.status',
  'atlassian.proposal',
  'tables.list',
  'tables.definitions',
  'agents.list',
  'agents.read',
  'agents.task.read',
  'plans.read',
  'conversation.messages.read',
  'mcp.search',
  'mcp.describe',
]);
export function isInternalTool(tool: string) {
  return internalTools.has(currentToolName(tool));
}

const toolAreaNames: Record<string, string> = {
  tables: 'Tables',
  rows: 'Tables',
  schema: 'Tables',
  knowledge: 'Knowledge',
  web: 'Web search',
  files: 'Files',
  skills: 'Skills',
  agents: 'Agents',
  plans: 'Plans',
  workflows: 'Workflows',
  conversation: 'Chat history',
  bud: 'Preferences',
  present: 'Choices',
  slack: 'Slack',
  github: 'GitHub',
  google: 'Google Workspace',
  atlassian: 'Atlassian',
  mcp: 'Connected apps',
};
/** A short product name for a tool, without its arguments, such as "Knowledge" or "Slack". */
export function toolDisplayName(tool: string) {
  return toolAreaNames[currentToolName(tool).split('.')[0] ?? ''] ?? 'a tool';
}

export const toolBrandSchema = z.enum([
  'google',
  'gmail',
  'google-calendar',
  'google-drive',
  'google-sheets',
  'google-docs',
  'google-slides',
  'slack',
  'github',
  'jira',
  'confluence',
  'trello',
]);
export const toolPresentationSchema = z.object({
  label: z.string().min(1).max(240),
  brand: toolBrandSchema.nullable(),
});
export type ToolPresentation = z.infer<typeof toolPresentationSchema>;
export const activityStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'unknown',
]);
export const activityReceiptSchema = z.object({
  id: z.uuid(),
  tool: z.string(),
  status: activityStatusSchema,
  presentation: toolPresentationSchema,
  detail: z.string().optional(),
});

const googleBrands = {
  gmail: 'gmail',
  calendar: 'google-calendar',
  drive: 'google-drive',
  sheets: 'google-sheets',
  docs: 'google-docs',
  slides: 'google-slides',
} satisfies Record<string, z.infer<typeof toolBrandSchema>>;
const shape = z.object({
  tool: z.string(),
  operation: z.object({ kind: z.string() }).optional(),
  actions: z.array(z.object({ kind: z.string() })).optional(),
});
const operations: Record<string, string> = {
  'jira.search': 'Search Jira issues',
  'jira.read': 'Read a Jira issue',
  'jira.create': 'Create a Jira issue',
  'jira.update': 'Update a Jira issue',
  'jira.delete': 'Delete a Jira issue',
  'confluence.search': 'Search Confluence pages',
  'confluence.read': 'Read a Confluence page',
  'confluence.create': 'Create a Confluence page',
  'confluence.update': 'Update a Confluence page',
  'confluence.trash': 'Move a Confluence page to trash',
  'card.search': 'Search Trello cards',
  'card.read': 'Read a Trello card',
  'card.create': 'Create a Trello card',
  'card.update': 'Update a Trello card',
  'card.delete': 'Delete a Trello card',
};
const githubObjects: Record<string, string> = {
  repository: 'repository',
  file: 'file',
  files: 'files',
  branch: 'branch',
  release: 'release',
  pull: 'pull request',
  issue: 'issue',
  commit: 'commit',
  project: 'project',
  discussion: 'discussion',
};
const githubActions: Record<string, string> = {
  read: 'Read',
  content: 'Read the contents of a',
  list: 'List',
  search: 'Search',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  close: 'Close',
  reopen: 'Reopen',
  comment: 'Comment on a',
  review: 'Review a',
  merge: 'Merge a',
  rename: 'Rename a',
  archive: 'Change archive status of a',
  settings: 'Update settings for a',
  diff: 'Read changes in a',
  files: 'List files in a',
  reviews: 'List reviews on a',
  comments: 'Read comments on a',
  'review-comments': 'Read review comments on a',
  commits: 'List commits in a',
  checks: 'Read checks for a',
  status: 'Check status of a',
  download: 'Download an asset from a',
  assets: 'List assets in a',
  asset: 'Read an asset in a',
  publish: 'Publish a',
  'asset-upload': 'Upload an asset to a',
  'asset-update': 'Update an asset in a',
  'asset-delete': 'Delete an asset from a',
  'create-fork': 'Create a cross-repository',
  'request-reviewers': 'Request reviewers for a',
  commit: 'Commit changes to',
  fields: 'List fields in a',
  items: 'List items in a',
  item: 'Read an item in a',
  'item-field': 'Read an item field in a',
  categories: 'List categories in a',
  replies: 'Read replies in a',
  'field-create': 'Create a field in a',
  'field-update': 'Update a field in a',
  'field-delete': 'Delete a field from a',
  'item-add': 'Add an item to a',
  'item-delete': 'Delete an item from a',
  'item-archive': 'Archive an item in a',
  'item-unarchive': 'Unarchive an item in a',
  'item-update': 'Update an item in a',
  'comment-create': 'Add a comment to a',
  'comment-update': 'Update a comment in a',
  'comment-delete': 'Delete a comment from a',
  'answer-mark': 'Mark an answer in a',
  'answer-unmark': 'Unmark an answer in a',
  'draft-create': 'Create a draft item in a',
  'draft-update': 'Update a draft item in a',
  'value-set': 'Set a field value in a',
  'value-clear': 'Clear a field value in a',
};
const githubWorkflowActions: Record<string, string> = {
  workflows: 'List GitHub Actions workflows',
  runs: 'List GitHub Actions runs',
  artifacts: 'List GitHub Actions artifacts',
  workflow: 'Read a GitHub Actions workflow',
  run: 'Read a GitHub Actions run',
  artifact: 'Read a GitHub Actions artifact',
  logs: 'Read GitHub Actions logs',
  jobs: 'List GitHub Actions jobs',
  dispatch: 'Start a GitHub Actions workflow',
  rerun: 'Rerun GitHub Actions jobs',
  cancel: 'Cancel a GitHub Actions run',
  'artifact-delete': 'Delete a GitHub Actions artifact',
  'artifact-download': 'Download a GitHub Actions artifact',
  'run-logs-download': 'Download GitHub Actions logs',
};

export function githubOperationLabel(kind: string): string | null {
  const [object, action] = kind.split('.');
  if (!object || !action) return null;
  if (object === 'actions') return githubWorkflowActions[action] ?? null;
  const noun = githubObjects[object],
    verb = githubActions[action];
  const plural =
    object === 'repository'
      ? 'repositories'
      : object === 'branch'
        ? 'branches'
        : object === 'files'
          ? 'files'
          : `${noun}s`;
  return noun && verb ? `${verb} GitHub ${['list', 'search', 'commit'].includes(action) ? plural : noun}` : null;
}

function storedPresentation(tool: string, activity: string | null | undefined): ToolPresentation | null {
  if (!activity) return null;
  if (tool.startsWith('atlassian.'))
    for (const [kind, label] of Object.entries(operations)) {
      const prefix =
        tool === 'atlassian.propose'
          ? 'Preparing: '
          : tool === 'atlassian.execute'
            ? 'Executing approved action: '
            : tool === 'atlassian.proposal'
              ? 'Checking approval and outcome: '
              : '';
      if (`${prefix}${label}` === activity)
        return {
          label: activity,
          brand: kind.startsWith('jira.') ? 'jira' : kind.startsWith('confluence.') ? 'confluence' : 'trello',
        };
    }
  if (tool.startsWith('github.')) {
    const labels = [
      ...Object.values(githubWorkflowActions),
      ...Object.keys(githubObjects).flatMap(object =>
        Object.keys(githubActions).map(action => githubOperationLabel(`${object}.${action}`)),
      ),
    ];
    const prefix =
      tool === 'github.personal.propose'
        ? 'Preparing: '
        : tool === 'github.personal.execute'
          ? 'Executing approved batch: '
          : '';
    if (labels.some(label => label && `${prefix}${label}` === activity)) return { label: activity, brand: 'github' };
  }
  return null;
}

export function toolPresentation(storedTool: string, call?: unknown, storedActivity?: string | null): ToolPresentation {
  const tool = currentToolName(storedTool);
  const parsed = shape.safeParse(call);
  const operation =
    parsed.success && currentToolName(parsed.data.tool) === tool ? parsed.data.operation?.kind : undefined;
  if (!operation && storedActivity) {
    const stored = storedPresentation(tool, storedActivity);
    if (stored) return stored;
  }
  let label =
    Object.entries(toolActivityLabels).find(([name]) => name === tool)?.[1] ?? `Run ${tool.replaceAll('.', ' ')}`;
  let brand: ToolPresentation['brand'] = tool.startsWith('google.')
    ? 'google'
    : tool.startsWith('github.')
      ? 'github'
      : tool.startsWith('slack.')
        ? 'slack'
        : null;
  if (tool.startsWith('google.')) {
    label = googleToolActivity(tool, call, storedActivity) ?? label;
    brand =
      Object.entries(googleBrands).find(([service]) => operation?.startsWith(`${service}.`))?.[1] ??
      Object.entries(googleBrands).find(([service]) =>
        label.toLowerCase().includes(service === 'gmail' ? 'gmail' : `google ${service}`),
      )?.[1] ??
      'google';
  }
  if (tool.startsWith('atlassian.') && operation) {
    const action = operations[operation];
    if (action) label = `${tool === 'atlassian.propose' ? 'Preparing: ' : ''}${action}`;
    brand = operation.startsWith('jira.')
      ? 'jira'
      : operation.startsWith('confluence.')
        ? 'confluence'
        : operation.startsWith('card.')
          ? 'trello'
          : null;
  }
  if (tool.startsWith('github.personal.') && operation) {
    const action = githubOperationLabel(operation);
    if (action) label = `${tool === 'github.personal.propose' ? 'Preparing: ' : ''}${action}`;
  }
  if (tool === 'github.personal.propose' && parsed.success && parsed.data.actions?.length) {
    const actions = [
      ...new Set(
        parsed.data.actions.map(action => githubOperationLabel(action.kind)).filter(action => action !== null),
      ),
    ];
    if (actions.length === 1) label = `Preparing: ${actions[0]}`;
    else if (actions.length > 1) label = `Preparing ${parsed.data.actions.length} GitHub changes for review`;
  }
  return { label: [...label].slice(0, 240).join(''), brand };
}

const outputSchema = z.object({
  error: z.unknown().optional(),
  code: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  data: z.object({ status: z.string().optional() }).nullish(),
  actions: z.array(z.object({ status: z.string() })).optional(),
});
export function toolOutcomeStatus(output: unknown): z.infer<typeof activityStatusSchema> {
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) return 'completed';
  const value = parsed.data;
  if (value.status === 'pending') return value.error === 'execution-outcome-unknown' ? 'unknown' : 'waiting';
  if (value.error != null || value.code === 'access-denied' || value.code === 'tool-failed')
    return value.error === 'access-denied' || value.code === 'access-denied' ? 'blocked' : 'failed';
  const statuses = [
    value.status,
    value.state,
    value.data?.status,
    ...(value.actions?.map(action => action.status) ?? []),
  ];
  if (statuses.some(status => status === 'unknown' || status === 'outcome-unknown' || status === 'unresolved'))
    return 'unknown';
  if (statuses.some(status => status === 'failed' || status === 'rejected')) return 'failed';
  if (statuses.includes('cancelled')) return 'cancelled';
  if (
    statuses.some(
      status => status === 'waiting-approval' || status === 'awaiting-approval' || status === 'selection-required',
    )
  )
    return 'waiting';
  if (statuses.some(status => status === 'executing' || status === 'dispatched' || status === 'sending'))
    return 'running';
  return 'completed';
}
