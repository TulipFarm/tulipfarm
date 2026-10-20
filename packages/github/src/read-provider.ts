import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { createMcpSession } from '@tulipfarm/provider-mcp';
import { GitHubCredentialRejected, type GitHubCredential } from './accounts.ts';
import { githubReadSchema, GitHubReadError, type GitHubRead } from './read-contracts.ts';
import { githubReadMatrix, readDefinition, readRoute, mcpReadArguments } from './read-matrix.ts';
import { parseGraphqlRead } from './read-graphql.ts';
export { readRoute } from './read-matrix.ts';

export const githubReadBindingsSchema = z
  .array(
    z.strictObject({ operation: z.string(), name: z.string(), contractDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
  )
  .max(50)
  .superRefine((bindings, ctx) => {
    const seen = new Set<string>();
    for (const binding of bindings) {
      const entry = Object.entries(githubReadMatrix).find(([kind]) => kind === binding.operation)?.[1];
      if (!entry || !('mcp' in entry) || entry.mcp.name !== binding.name || seen.has(binding.operation))
        ctx.addIssue({ code: 'custom', message: 'Unmapped or duplicate GitHub MCP binding' });
      seen.add(binding.operation);
    }
  });
export function githubReadBindings(env: NodeJS.ProcessEnv = process.env) {
  if (env.GITHUB_MCP_READ_BINDINGS === undefined) return [];
  try {
    return githubReadBindingsSchema.parse(JSON.parse(env.GITHUB_MCP_READ_BINDINGS));
  } catch {
    throw new Error('Invalid GitHub reviewed MCP bindings');
  }
}
export type GitHubReadBinding = z.infer<typeof githubReadBindingsSchema>[number];

const login = z.object({ login: z.string() }).nullish();
const issueSearchPage = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z
    .array(
      z.object({
        url: z.string(),
        html_url: z.string(),
        number: z.number(),
        title: z.string(),
        state: z.string(),
        state_reason: z.string().nullish(),
        draft: z.boolean().optional(),
        user: login,
        labels: z.array(z.object({ name: z.string() })).default([]),
        assignees: z.array(login).nullish(),
        milestone: z.object({ title: z.string() }).nullish(),
        comments: z.number(),
        created_at: z.string(),
        updated_at: z.string(),
        closed_at: z.string().nullish(),
        pull_request: z.unknown().optional(),
        body: z.string().nullish(),
      }),
    )
    .max(30),
});
const searchBodyPreview = 1000;
// Search items repeat full user, label, reaction, and body payloads; a 30-item page routinely exceeds the result limit.
// Return a compact page and point the agent at issue.read or pull.read for the full body.
function compactIssueSearch(value: unknown) {
  const page = issueSearchPage.parse(value);
  return {
    total_count: page.total_count,
    incomplete_results: page.incomplete_results,
    items: page.items.map(({ user, labels, assignees, milestone, pull_request, body, ...item }) => ({
      ...item,
      user: user?.login ?? null,
      labels: labels.map(label => label.name),
      assignees: (assignees ?? []).flatMap(assignee => (assignee ? [assignee.login] : [])),
      milestone: milestone?.title ?? null,
      is_pull_request: pull_request !== undefined,
      body: body ? body.slice(0, searchBodyPreview) : null,
      body_truncated: (body?.length ?? 0) > searchBodyPreview,
    })),
  };
}

function checkedResult(value: unknown, token: string) {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > 131072) throw new GitHubReadError('read-limit');
  if (
    [token, Buffer.from(token).toString('base64'), Buffer.from(token).toString('base64url')].some(secret =>
      text.includes(secret),
    )
  )
    throw new GitHubReadError('read-unavailable');
  return z.json().parse(value);
}
async function boundedBody(response: Response, limit = 131072) {
  if (!response.body) throw new GitHubReadError('read-unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new GitHubReadError('read-limit');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
function utf8(bytes: Uint8Array) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new GitHubReadError('read-unavailable');
  return text;
}
async function jsonBody(response: Response, limit?: number) {
  if (!response.headers.get('content-type')?.includes('json')) throw new GitHubReadError('read-unavailable');
  return JSON.parse(utf8(await boundedBody(response, limit)));
}
export const githubRateLimited = (response: Response) =>
  response.status === 429 ||
  (response.status === 403 &&
    (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));

function status(response: Response) {
  if (response.status === 401) throw new GitHubCredentialRejected();
  if (githubRateLimited(response)) throw new GitHubReadError('read-rate-limited');
  if (response.status === 403 || response.status === 404) throw new GitHubReadError('read-forbidden');
  if (!response.ok) throw new GitHubReadError('read-unavailable');
}
const directoryEntry = z.object({
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  size: z.number().int().nonnegative(),
  type: z.enum(['file', 'dir', 'symlink', 'submodule']),
});

export async function dispatchGitHubRead(input: {
  operation: GitHubRead;
  credential: Pick<GitHubCredential, 'accessToken'>;
  bindings?: readonly GitHubReadBinding[];
  fetcher?: typeof fetch;
}) {
  const operation = githubReadSchema.parse(input.operation);
  const definition = readDefinition(operation);
  const fetcher = observeFetch('github', 'request', input.fetcher ?? fetch);
  const token = input.credential.accessToken;
  const binding = githubReadBindingsSchema.parse(input.bindings ?? []).find(item => item.operation === operation.kind);
  if (binding && definition.transport === 'rest' && definition.mcp) {
    const session = createMcpSession({
      endpoint: 'https://api.githubcopilot.com/mcp/',
      clientName: 'tulipfarm-github',
      token,
      timeoutMs: 10000,
      bindings: [binding],
      fetcher: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('X-MCP-Readonly', 'true');
        headers.set('X-MCP-Tools', binding.name);
        const response = await fetcher(url, { ...init, headers });
        if (response.status === 401) throw new GitHubCredentialRejected();
        if (githubRateLimited(response)) throw new GitHubReadError('read-rate-limited');
        return response;
      },
      error: () => new GitHubReadError('read-unqualified'),
      knownError: error =>
        error instanceof GitHubCredentialRejected ||
        (error instanceof GitHubReadError && error.code === 'read-rate-limited')
          ? error
          : null,
      isDefiniteRejection: error => error instanceof GitHubCredentialRejected,
      authorize: async () => true,
      result: result => checkedResult(result, token),
    });
    try {
      await session.discover();
      return {
        transport: 'official-mcp' as const,
        data: await session.execute(operation.kind, mcpReadArguments(operation, definition.mcp)),
      };
    } finally {
      await session.close();
    }
  }
  const signal = AbortSignal.timeout(10000);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'TulipFarm',
  };
  const request = (path: string, accept = headers.Accept) =>
    fetcher(`https://api.github.com${path}`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { ...headers, Accept: accept },
    });
  try {
    if (definition.transport === 'graphql') {
      const query =
        typeof definition.query === 'string'
          ? definition.query
          : 'ownerType' in operation
            ? definition.query[operation.ownerType]
            : undefined;
      if (!query) throw new GitHubReadError('read-unavailable');
      const { kind: _kind, ...variables } = operation;
      const response = await fetcher('https://api.github.com/graphql', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      status(response);
      return {
        transport: 'graphql' as const,
        data: checkedResult(parseGraphqlRead(await jsonBody(response), operation), token),
      };
    }
    const route = readRoute(operation);
    if (definition.format === 'logs') {
      let response = await fetcher(`https://api.github.com${route}`, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers,
      });
      if (response.status === 302) {
        const location = new URL(response.headers.get('location') ?? '');
        await response.body?.cancel();
        if (
          location.protocol !== 'https:' ||
          location.port ||
          location.username ||
          location.password ||
          location.hash ||
          !(
            /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(location.hostname) ||
            /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(location.hostname)
          )
        )
          throw new GitHubReadError('read-unavailable');
        response = await fetcher(location, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { Accept: 'text/plain' },
        });
        if (!response.ok) throw new GitHubReadError('read-unavailable');
      }
      status(response);
      return {
        transport: 'rest' as const,
        data: checkedResult({ text: utf8(await boundedBody(response, 65536)), complete: true }, token),
      };
    }
    if (definition.format === 'content') {
      const metadataResponse = await request(route);
      status(metadataResponse);
      const metadata = z
        .object({ type: z.literal('file'), size: z.number().int().nonnegative() })
        .parse(await jsonBody(metadataResponse));
      if (metadata.size > 65536) throw new GitHubReadError('read-limit');
    }
    const response = await request(
      route,
      definition.format === 'diff'
        ? 'application/vnd.github.diff'
        : definition.format === 'content'
          ? 'application/vnd.github.raw+json'
          : headers.Accept,
    );
    status(response);
    let data: unknown;
    if (definition.format === 'diff' || definition.format === 'content') {
      if (definition.format === 'diff' && response.headers.get('content-type')?.includes('json'))
        throw new GitHubReadError('read-unavailable');
      data = { text: utf8(await boundedBody(response, 65536)), complete: true };
    } else if (definition.format === 'directory' && operation.kind === 'file.list') {
      const entries = z
        .array(directoryEntry)
        .max(1000)
        .parse(await jsonBody(response, 1048576));
      const start = (operation.page - 1) * operation.perPage;
      data = {
        entries: entries.slice(start, start + operation.perPage),
        nextPage: start + operation.perPage < entries.length ? operation.page + 1 : null,
        directoryLimitReached: entries.length === 1000,
      };
    } else if (
      (definition.format === 'pull-checks' || definition.format === 'pull-status') &&
      (operation.kind === 'pull.checks' || operation.kind === 'pull.status')
    ) {
      const pull = z
        .object({ head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) })
        .parse(await jsonBody(response));
      const result = await request(
        `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}/commits/${pull.head.sha}/${definition.format === 'pull-checks' ? 'check-runs' : 'status'}?per_page=${operation.perPage}&page=${operation.page}`,
      );
      status(result);
      data = { headSha: pull.head.sha, result: await jsonBody(result) };
    } else if (operation.kind === 'issue.search' || operation.kind === 'pull.search')
      data = compactIssueSearch(await jsonBody(response, 8388608));
    else data = await jsonBody(response);
    return { transport: 'rest' as const, data: checkedResult(data, token) };
  } catch (error) {
    if (error instanceof GitHubCredentialRejected || error instanceof GitHubReadError) throw error;
    throw new GitHubReadError('read-unavailable');
  }
}
