import type { GitHubRead } from './read-contracts.ts';
import { githubGraphqlQueries } from './read-graphql.ts';

type McpRead = { name: string; method?: string; minimal?: boolean; pullNumber?: boolean };
type ReadDefinition =
  | {
      transport: 'rest';
      path: string;
      format?: 'diff' | 'content' | 'directory' | 'logs' | 'pull-checks' | 'pull-status';
      mcp?: McpRead;
    }
  | { transport: 'graphql'; query: string | { user: string; organization: string } };
const repository = '/repos/{owner}/{repo}';
const paging = '?per_page={perPage}&page={page}';
const pull = (method: string): McpRead => ({ name: 'pull_request_read', method, pullNumber: true });

export const githubReadMatrix = {
  'repository.read': { transport: 'rest', path: repository },
  'repository.search': {
    transport: 'rest',
    path: `/search/repositories${paging}&q={query}`,
    mcp: { name: 'search_repositories', minimal: true },
  },
  'file.search': { transport: 'rest', path: `/search/code${paging}&q={query}`, mcp: { name: 'search_code' } },
  'file.read': { transport: 'rest', path: `${repository}/contents/{path}`, mcp: { name: 'get_file_contents' } },
  'file.content': { transport: 'rest', path: `${repository}/contents/{path}`, format: 'content' },
  'file.list': { transport: 'rest', path: `${repository}/contents/{path}`, format: 'directory' },
  'branch.list': { transport: 'rest', path: `${repository}/branches${paging}`, mcp: { name: 'list_branches' } },
  'branch.read': { transport: 'rest', path: `${repository}/branches/{branch}` },
  'pull.list': { transport: 'rest', path: `${repository}/pulls${paging}&state={state}` },
  'pull.search': { transport: 'rest', path: `/search/issues${paging}&q={query}%20is%3Apr` },
  'pull.read': { transport: 'rest', path: `${repository}/pulls/{number}`, mcp: pull('get') },
  'pull.diff': { transport: 'rest', path: `${repository}/pulls/{number}`, format: 'diff', mcp: pull('get_diff') },
  'pull.files': { transport: 'rest', path: `${repository}/pulls/{number}/files${paging}`, mcp: pull('get_files') },
  'pull.reviews': {
    transport: 'rest',
    path: `${repository}/pulls/{number}/reviews${paging}`,
    mcp: pull('get_reviews'),
  },
  'pull.comments': {
    transport: 'rest',
    path: `${repository}/issues/{number}/comments${paging}`,
    mcp: pull('get_comments'),
  },
  'pull.review-comments': { transport: 'rest', path: `${repository}/pulls/{number}/comments${paging}` },
  'pull.commits': {
    transport: 'rest',
    path: `${repository}/pulls/{number}/commits${paging}`,
    mcp: pull('get_commits'),
  },
  'pull.checks': {
    transport: 'rest',
    path: `${repository}/pulls/{number}`,
    format: 'pull-checks',
    mcp: pull('get_check_runs'),
  },
  'pull.status': {
    transport: 'rest',
    path: `${repository}/pulls/{number}`,
    format: 'pull-status',
    mcp: pull('get_status'),
  },
  'commit.checks': { transport: 'rest', path: `${repository}/commits/{ref}/check-runs${paging}` },
  'commit.status': { transport: 'rest', path: `${repository}/commits/{ref}/status${paging}` },
  'issue.search': { transport: 'rest', path: `/search/issues${paging}&q={query}` },
  'issue.read': { transport: 'rest', path: `${repository}/issues/{number}` },
  'issue.comments': { transport: 'rest', path: `${repository}/issues/{number}/comments${paging}` },
  'release.list': { transport: 'rest', path: `${repository}/releases${paging}` },
  'release.read': { transport: 'rest', path: `${repository}/releases/{id}` },
  'release.assets': { transport: 'rest', path: `${repository}/releases/{id}/assets${paging}` },
  'release.asset': { transport: 'rest', path: `${repository}/releases/assets/{id}` },
  'actions.runs': { transport: 'rest', path: `${repository}/actions/runs${paging}` },
  'actions.workflows': { transport: 'rest', path: `${repository}/actions/workflows${paging}` },
  'actions.workflow': { transport: 'rest', path: `${repository}/actions/workflows/{id}` },
  'actions.run': { transport: 'rest', path: `${repository}/actions/runs/{id}` },
  'actions.jobs': { transport: 'rest', path: `${repository}/actions/runs/{id}/jobs${paging}` },
  'actions.artifacts': { transport: 'rest', path: `${repository}/actions/artifacts${paging}` },
  'actions.artifact': { transport: 'rest', path: `${repository}/actions/artifacts/{id}` },
  'actions.logs': { transport: 'rest', path: `${repository}/actions/jobs/{id}/logs`, format: 'logs' },
  'project.list': { transport: 'graphql', query: githubGraphqlQueries['project.list'] },
  'project.read': { transport: 'graphql', query: githubGraphqlQueries['project.read'] },
  'project.fields': { transport: 'graphql', query: githubGraphqlQueries['project.fields'] },
  'project.items': { transport: 'graphql', query: githubGraphqlQueries['project.items'] },
  'project.item': { transport: 'graphql', query: githubGraphqlQueries['project.item'] },
  'project.item-field': { transport: 'graphql', query: githubGraphqlQueries['project.item-field'] },
  'discussion.list': { transport: 'graphql', query: githubGraphqlQueries['discussion.list'] },
  'discussion.read': { transport: 'graphql', query: githubGraphqlQueries['discussion.read'] },
  'discussion.categories': { transport: 'graphql', query: githubGraphqlQueries['discussion.categories'] },
  'discussion.comments': { transport: 'graphql', query: githubGraphqlQueries['discussion.comments'] },
  'discussion.replies': { transport: 'graphql', query: githubGraphqlQueries['discussion.replies'] },
  'discussion.search': { transport: 'graphql', query: githubGraphqlQueries['discussion.search'] },
} satisfies Record<GitHubRead['kind'], ReadDefinition>;

export function readDefinition(operation: GitHubRead): ReadDefinition {
  return githubReadMatrix[operation.kind];
}
export function readRoute(operation: GitHubRead) {
  const definition = readDefinition(operation);
  if (definition.transport === 'graphql') return '/graphql';
  const values = new Map(Object.entries(operation));
  const path = definition.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = String(values.get(key));
    return key === 'path' ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);
  });
  return ['file.read', 'file.content', 'file.list'].includes(operation.kind) && 'ref' in operation && operation.ref
    ? `${path}?ref=${encodeURIComponent(operation.ref)}`
    : path;
}
export function mcpReadArguments(operation: GitHubRead, binding: McpRead) {
  const { kind: _kind, ...input } = operation;
  const args: Record<string, unknown> = { ...input };
  if (binding.pullNumber && 'number' in operation) {
    args.pullNumber = operation.number;
    delete args.number;
  }
  if (binding.method) args.method = binding.method;
  if (binding.minimal) args.minimal_output = true;
  return args;
}
