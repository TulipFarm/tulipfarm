import type { toolNameSchema } from '@tulipfarm/agents/contracts';
import type { AgentDetail } from './api';

export const toolLabels: Record<ReturnType<typeof toolNameSchema.parse>, string> = {
  'github.personal.account': 'Request a private GitHub account',
  'github.personal.read': 'Read private GitHub data',
  'github.personal.download': 'Prepare private GitHub downloads',
  'github.personal.propose': 'Propose exact GitHub changes',
  'github.investigation.account': 'Choose a private investigation source',
  'github.investigation.repositories': 'Find permitted GitHub repositories',
  'github.investigation.read': 'Read GitHub investigation evidence',
  'mcp.call': 'Call selected MCP tools',
  'mcp.search': 'Find selected MCP tools',
  'mcp.describe': 'Inspect selected MCP tool contracts',
  'slack.message.send': 'Send Slack messages',
  'slack.thread.reply': 'Reply in Slack threads',
  'slack.reaction.add': 'Add Slack reactions',
  'schema.inspect': 'Inspect table fields',
  'schema.status': 'Check field changes',
  'rows.list': 'Find rows',
  'rows.summarize': 'Count and total rows',
  'rows.resolveReference': 'Look up linked rows',
  'rows.get': 'Read a row',
  'skills.execute': 'Run skill scripts',
  'skills.files.read': 'Read skill resources',
  'rows.create': 'Create rows',
  'rows.update': 'Update rows',
  'rows.delete': 'Delete rows',
  'rows.reverse': 'Read incoming links',
  'tables.list': 'Find tables',
  'github.issue.read': 'Read GitHub issues',
  'agents.task.start': 'Start agent tasks',
  'agents.task.read': 'Read agent tasks',
  'google.read': 'Read Google Workspace data',
  'google.propose': 'Propose Google Workspace changes',
  'google.status': 'Check Google Workspace actions',
  'google.execute': 'Carry out approved Google Workspace changes',
  'skills.list': 'Find procedures',
  'skills.read': 'Read a procedure',
  'web.fetch': 'Read a web page',
  'web.search': 'Search the web',
  'knowledge.search': 'Search knowledge',
  'knowledge.read': 'Read knowledge sources',
  'knowledge.retrieve': 'Search and read grouped knowledge',
  'images.generate': 'Generate images',
};

const permissionWords: Record<string, string> = {
  'table.row.read': 'read rows',
  'table.row.create': 'add rows',
  'table.row.update': 'update rows',
  'table.row.delete': 'delete rows',
  'table.schema.manage': 'change columns',
  'table.create': 'create tables',
};

export function permissionText(permissions: readonly string[]) {
  return permissions.map(permission => permissionWords[permission] ?? permission).join(', ');
}

export function scopeText(
  scope: AgentDetail['activations'][number]['scope'],
  tableNames: ReadonlyMap<string, string> = new Map(),
) {
  return scope.length
    ? scope
        .map(
          entry =>
            `${tableNames.get(entry.assetId) ?? `Table ${entry.assetId.slice(0, 8)}`}: ${permissionText(entry.permissions)}`,
        )
        .join('; ')
    : 'No table access';
}

export function activationLabel(detail: AgentDetail, activation: AgentDetail['activations'][number]) {
  return `${detail.name} · ${activation.revision === detail.definitionRevision ? 'Current saved instructions' : 'Earlier instructions'} · ${activation.revision.slice(0, 8)} · ${activation.id.slice(0, 8)}`;
}
