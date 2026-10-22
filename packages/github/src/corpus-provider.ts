import { z } from 'zod';
import { observeFetch, type DependencyEndpoint } from '@tulipfarm/observability';
import { AccessDenied } from '@tulipfarm/access';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import {
  GitHubCorpusError,
  githubCorpusBindingSchema,
  githubCorpusCursorTokenSchema,
  githubCorpusLimits as limits,
  githubCorpusSelectionSchema,
  githubRepositoryIdSchema,
  githubRepositoryNameSchema,
  type GitHubCorpusBinding,
  type GitHubCorpusErrorCode,
  type GitHubCorpusProvider,
  type GitHubCorpusSelection,
  type GitHubItemObservation,
  type GitHubItemRead,
  type GitHubRepository,
} from '@tulipfarm/knowledge/github-contracts';
import {
  createGitHubAccounts,
  GitHubAccountError,
  GitHubCredentialRejected,
  githubConfiguration,
  type AccountRuntime,
  type GitHubCredential,
} from './accounts.ts';

type Accounts = Pick<ReturnType<typeof createGitHubAccounts>, 'withReadCredential'>;
const repositorySchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string().min(1).max(256),
  full_name: githubRepositoryNameSchema,
  private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  default_branch: z.string().min(1).max(255).optional(),
  description: z.string().max(4096).nullable().optional(),
  permissions: z.object({ pull: z.boolean() }).partial().optional(),
});
type RepositoryBody = z.infer<typeof repositorySchema>;
const userSchema = z
  .object({ login: z.string().max(100) })
  .nullable()
  .optional();
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  body: z.string().max(262144).nullable().optional(),
  user: userSchema,
  state: z.string().max(32),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int().nonnegative(),
  html_url: z.url(),
  pull_request: z.object({}).passthrough().optional(),
});
type Issue = z.infer<typeof issueSchema>;
const commentSchema = z.object({
  user: userSchema,
  body: z.string().max(262144).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z
    .array(
      z.object({
        path: z.string().max(4096),
        type: z.string(),
        sha: z.string().regex(/^[a-f0-9]{40,64}$/),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(200000),
});
const contentSchema = z.object({
  type: z.literal('file'),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  size: z.number().int().nonnegative(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});
const graphAuthor = z
  .object({ login: z.string().max(100) })
  .nullable()
  .optional();
const discussionNode = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  updatedAt: z.string(),
  url: z.url(),
  comments: z.object({ totalCount: z.number().int().nonnegative() }),
});
const replySchema = z.object({
  body: z.string().max(262144),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: graphAuthor,
});
const discussionSchema = discussionNode.extend({
  body: z.string().max(262144),
  createdAt: z.string(),
  author: graphAuthor,
  category: z
    .object({ name: z.string().max(256) })
    .nullable()
    .optional(),
  comments: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z
      .array(
        replySchema.extend({
          replies: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(replySchema).max(50) }),
        }),
      )
      .max(100),
  }),
});
const documentExtensions = /\.(?:md|markdown|mdx|mdown|txt|text|rst|adoc|asciidoc|org)$/i;
const documentNames = /(?:^|\/)(?:README|CHANGELOG|CHANGES|CONTRIBUTING|LICENSE|NOTICE|AUTHORS|CODEOWNERS|SECURITY)$/i;
export const isGitHubDocumentPath = (path: string) => documentExtensions.test(path) || documentNames.test(path);
const sensitivePath =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$|\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|kdbx|tfstate|tfvars)$/i;
const generatedPath =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|target|coverage|\.next|\.nuxt|__pycache__|\.venv|venv|bower_components|Pods|\.gradle|\.git|generated|__generated__)\/|\.min\.(?:js|css)$|\.(?:map|snap|lock)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|npm-shrinkwrap\.json)$|\.(?:generated|pb|g)\.[a-z0-9]+$|_pb2\.py$/i;
const binaryPath =
  /\.(?:png|jpe?g|gif|bmp|ico|icns|webp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|o|a|lib|bin|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|mkv|wav|flac|ogg|webm|psd|sketch|fig|sqlite3?|db|parquet|pyc|pyo|npy|pkl|onnx|pt|h5)$/i;
const codeExtensions =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|fs|c|h|cc|cpp|cxx|hpp|hh|m|mm|swift|scala|sh|bash|zsh|fish|ps1|sql|ya?ml|json|jsonc|toml|ini|cfg|conf|css|scss|sass|less|html?|vue|svelte|astro|graphql|gql|proto|tf|hcl|lua|r|dart|ex|exs|erl|hrl|hs|clj|cljs|el|vim|gradle|xml|cmake|nix|zig|jl|pl|pm|groovy|bzl|bazel|prisma)$/i;
const codeNames =
  /(?:^|\/)(?:Dockerfile|Containerfile|Makefile|Rakefile|Gemfile|Procfile|Justfile|Vagrantfile|BUILD|WORKSPACE)$/;
/** Default-branch code coverage: `null` is not code; `excluded` is sensitive, generated, vendored or binary and is listed as a visible skip. */
export function githubCodeCoverage(path: string): 'supported' | 'excluded' | null {
  if (isGitHubDocumentPath(path) || path.length > 1024) return null;
  if (sensitivePath.test(path) || generatedPath.test(path) || binaryPath.test(path)) return 'excluded';
  return codeExtensions.test(path) || codeNames.test(path) ? 'supported' : null;
}
const fence = (content: string) =>
  '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(match => match[0].length + 1)));
const DISCUSSIONS = `query($id:ID!,$cursor:String){node(id:$id){... on Repository{discussions(first:20,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title updatedAt url comments{totalCount}}}}}}`;
const DISCUSSION = `query($id:ID!,$number:Int!){node(id:$id){... on Repository{discussion(number:$number){number title body url createdAt updatedAt author{login} category{name} comments(first:100){totalCount nodes{body createdAt updatedAt author{login} replies(first:50){totalCount nodes{body createdAt updatedAt author{login}}}}}}}}}`;

function parse<T>(schema: z.ZodType<T>, value: unknown, code: GitHubCorpusErrorCode = 'invalid-response'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitHubCorpusError(code);
  return result.data;
}
const iso = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
};
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const who = (user: { login: string } | null | undefined) => (user ? `@${user.login}` : 'a deleted user');
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
function repository(body: RepositoryBody): GitHubRepository {
  return {
    repositoryId: String(body.id),
    fullName: body.full_name,
    visibility: body.visibility ?? (body.private ? 'private' : 'public'),
    title: (body.description ? `${body.full_name} — ${oneLine(body.description)}` : body.full_name).slice(0, 512),
  };
}
type Phase = 'docs' | 'code' | 'issues' | 'discussions';
function phases(selection: GitHubCorpusSelection): Phase[] {
  return [
    ...(selection.kinds.includes('docs') ? ['docs' as const] : []),
    ...(selection.kinds.includes('code') ? ['code' as const] : []),
    ...(selection.kinds.includes('issues') || selection.kinds.includes('pulls') ? ['issues' as const] : []),
    ...(selection.kinds.includes('discussions') ? ['discussions' as const] : []),
  ];
}
function nextPhase(selection: GitHubCorpusSelection, current: Phase) {
  const order = phases(selection);
  const next = order[order.indexOf(current) + 1];
  return next ? `${next}:` : null;
}
function native(nativeId: string, repositoryId: string) {
  const match = /^(doc|code|issue|pull|discussion):([1-9][0-9]{0,19}):(.+)$/s.exec(nativeId);
  if (!match || match[2] !== repositoryId) throw new GitHubCorpusError('invalid-selection');
  const [, kind, , rest] = match as unknown as [
    string,
    'doc' | 'code' | 'issue' | 'pull' | 'discussion',
    string,
    string,
  ];
  if (kind !== 'doc' && kind !== 'code' && !/^[1-9][0-9]{0,9}$/.test(rest))
    throw new GitHubCorpusError('invalid-selection');
  return { kind, rest };
}
export function serializeGitHubIssue(full: string, issue: Issue, comments: readonly z.infer<typeof commentSchema>[]) {
  const kind = issue.pull_request ? 'pull request' : 'issue';
  const lines = [
    `# ${full}#${issue.number}: ${oneLine(issue.title)}`,
    '',
    `GitHub ${kind} ${full}#${issue.number} by ${who(issue.user)}, opened ${iso(issue.created_at)}, state ${issue.state}, last updated ${iso(issue.updated_at)}. ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}.`,
    '',
    `## Description by ${who(issue.user)} at ${iso(issue.created_at)}`,
    '',
    issue.body?.trim() || '_No description._',
  ];
  for (const comment of comments)
    lines.push(
      '',
      `## Comment by ${who(comment.user)} at ${iso(comment.created_at)}${comment.updated_at !== comment.created_at ? ` (edited ${iso(comment.updated_at)})` : ''}`,
      '',
      comment.body?.trim() || '_No text content._',
    );
  return `${lines.join('\n')}\n`;
}
export function serializeGitHubDiscussion(full: string, discussion: z.infer<typeof discussionSchema>) {
  const lines = [
    `# ${full} discussion #${discussion.number}: ${oneLine(discussion.title)}`,
    '',
    `GitHub discussion ${full}#${discussion.number}${discussion.category ? ` in ${discussion.category.name}` : ''} by ${who(discussion.author)}, opened ${iso(discussion.createdAt)}, last updated ${iso(discussion.updatedAt)}.`,
    '',
    `## Discussion by ${who(discussion.author)} at ${iso(discussion.createdAt)}`,
    '',
    discussion.body.trim() || '_No description._',
  ];
  for (const comment of discussion.comments.nodes) {
    lines.push(
      '',
      `## Comment by ${who(comment.author)} at ${iso(comment.createdAt)}`,
      '',
      comment.body.trim() || '_No text content._',
    );
    for (const reply of comment.replies.nodes)
      lines.push(
        '',
        `### Reply by ${who(reply.author)} at ${iso(reply.createdAt)}`,
        '',
        reply.body.trim() || '_No text content._',
      );
  }
  return `${lines.join('\n')}\n`;
}

// Runs one operation with the caller's own personal GitHub account. Every corpus request is made with this identity only.
// `codeBound` lets fixtures exercise the code-file bound at a small scale; production uses the documented limits.
export function createGitHubCorpusProvider(options: {
  accounts: Accounts;
  fetcher?: typeof fetch;
  codeBound?: { files: number; skipped: number };
}): GitHubCorpusProvider {
  const fetcher = options.fetcher ?? fetch;
  const codeFiles = options.codeBound?.files ?? limits.codeFilesPerRepository;
  const skippedCodeFiles = options.codeBound?.skipped ?? limits.skippedCodeFilesPerRepository;
  async function withAccount<T>(
    workspaceId: string,
    userId: string,
    accountId: string,
    expected: GitHubCorpusBinding | null,
    operation: (credential: GitHubCredential, binding: GitHubCorpusBinding) => Promise<T>,
  ) {
    try {
      return await options.accounts.withReadCredential(
        workspaceId,
        userId,
        accountId,
        async credential => {
          const binding = parse(githubCorpusBindingSchema, {
            accountId: credential.accountId,
            accountGeneration: credential.generation,
            githubUserId: credential.identity.id,
            login: credential.identity.login,
          });
          if (
            expected &&
            (expected.githubUserId !== binding.githubUserId || expected.accountGeneration !== binding.accountGeneration)
          )
            throw new GitHubCorpusError('stale-integration');
          return operation(credential, binding);
        },
        expected?.accountGeneration,
      );
    } catch (error) {
      if (error instanceof GitHubCorpusError) throw error;
      if (error instanceof AccessDenied) throw new GitHubCorpusError('not-linked');
      if (error instanceof GitHubAccountError)
        throw new GitHubCorpusError(
          error.code === 'account-disabled'
            ? 'not-configured'
            : error.code === 'account-reconnect-required'
              ? 'reconnect-required'
              : 'transient',
        );
      throw new GitHubCorpusError('transient');
    }
  }
  async function call(
    token: string,
    endpoint: DependencyEndpoint,
    path: string,
    init: { accept?: string; body?: unknown } = {},
  ) {
    const signal = AbortSignal.timeout(limits.requestTimeoutMs);
    let response: Response;
    try {
      response = await observeFetch('github', 'request', fetcher, { endpoint })(`https://api.github.com${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: init.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TulipFarm',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new GitHubCorpusError('transient');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > limits.responseBytes)
        throw new GitHubCorpusError('response-too-large');
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limits.responseBytes) throw new GitHubCorpusError('response-too-large');
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof GitHubCorpusError) throw error;
      throw new GitHubCorpusError('transient');
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
    const retry = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const retryAfterMs =
      Number.isFinite(retry) && response.headers.has('retry-after') && retry >= 0
        ? Math.min(3_600_000, Math.ceil(retry * 1000))
        : Number.isFinite(reset) && reset > 0
          ? Math.min(3_600_000, Math.max(1000, reset * 1000 - Date.now()))
          : null;
    if (response.status === 401) throw new GitHubCredentialRejected();
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
    )
      throw new GitHubCorpusError('rate-limited', retryAfterMs);
    if (response.status >= 500) throw new GitHubCorpusError('transient', retryAfterMs);
    const text = () => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new GitHubCorpusError('invalid-response');
      }
    };
    const json = () => {
      try {
        return JSON.parse(text()) as unknown;
      } catch {
        throw new GitHubCorpusError('invalid-response');
      }
    };
    return { status: response.status, text, json };
  }
  async function graphql(token: string, query: string, variables: Record<string, unknown>) {
    const response = await call(token, 'github-graphql', '/graphql', { body: { query, variables } });
    if (response.status === 403 || response.status === 404) throw new GitHubCorpusError('forbidden');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const body = parse(
      z.object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ type: z.string().optional() }).passthrough()).optional(),
      }),
      response.json(),
    );
    const types = (body.errors ?? []).map(error => error.type);
    if (types.includes('RATE_LIMITED')) throw new GitHubCorpusError('rate-limited', 60000);
    if (types.includes('NOT_FOUND') || types.includes('FORBIDDEN')) throw new GitHubCorpusError('forbidden');
    if (types.length) throw new GitHubCorpusError('invalid-response');
    return body.data;
  }
  function scoped(credential: GitHubCredential, repo: GitHubRepository) {
    if (repo.visibility !== 'public' && !credential.scopes.includes('repo'))
      throw new GitHubCorpusError('insufficient-scope');
  }
  async function byId(token: string, repositoryId: string) {
    const response = await call(
      token,
      'github-repository',
      `/repositories/${parse(githubRepositoryIdSchema, repositoryId, 'invalid-selection')}`,
    );
    if ([301, 302, 307, 403, 404, 410, 451].includes(response.status)) throw new GitHubCorpusError('forbidden');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const body = parse(repositorySchema, response.json());
    if (String(body.id) !== repositoryId) throw new GitHubCorpusError('invalid-response');
    if (body.permissions?.pull === false) throw new GitHubCorpusError('forbidden');
    return body;
  }
  async function headCommit(token: string, body: RepositoryBody) {
    if (!body.default_branch) return null;
    const response = await call(
      token,
      'github-head',
      `/repositories/${body.id}/commits/${encodeURIComponent(body.default_branch)}`,
      { accept: 'application/vnd.github.sha' },
    );
    if (response.status === 409 || response.status === 404 || response.status === 422) return null;
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    return parse(z.string().regex(/^[a-f0-9]{40,64}$/), response.text().trim());
  }
  function observation(
    repositoryId: string,
    kind: GitHubItemObservation['kind'],
    rest: string,
    title: string,
    canonicalURL: string,
    sourceRevision: string,
    accessedAt: string,
    coverage: GitHubItemObservation['coverage'] = 'supported',
  ): GitHubItemObservation {
    return {
      nativeId: `${kind}:${repositoryId}:${rest}`,
      repositoryId,
      kind,
      title: title.slice(0, 512),
      canonicalURL,
      sourceRevision,
      accessedAt,
      coverage,
    };
  }
  // GitHub omits entries from very large trees. The omission is a visible skip, so partial coverage never reads as complete.
  function truncation(
    body: RepositoryBody,
    kind: 'doc' | 'code',
    commit: string,
    accessedAt: string,
    truncated: boolean | undefined,
    offset: number,
  ) {
    return truncated && offset === 0
      ? [
          observation(
            String(body.id),
            kind,
            '/truncated-tree',
            `${body.full_name}: more files than GitHub lists (repository tree truncated)`,
            `https://github.com/${body.full_name}/tree/${commit}`,
            `tree:${commit}`,
            accessedAt,
            'excluded',
          ),
        ]
      : [];
  }
  const after = (selection: GitHubCorpusSelection) => `${selection.after}T00:00:00Z`;
  const inWindow = (selection: GitHubCorpusSelection, time: string) => Date.parse(time) >= Date.parse(after(selection));
  async function listDocs(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ) {
    const [pinned = '', offsetText = '0'] = state.split(':');
    const commit = pinned || (await headCommit(token, body));
    if (!commit || !/^[a-f0-9]{40,64}$/.test(commit) || !/^\d{1,6}$/.test(offsetText)) {
      if (commit) throw new GitHubCorpusError('invalid-cursor');
      return { observations: [], nextCursor: nextPhase(selection, 'docs') };
    }
    const response = await call(token, 'github-tree', `/repositories/${body.id}/git/trees/${commit}?recursive=1`);
    if (response.status === 404 || response.status === 409) throw new GitHubCorpusError('invalid-cursor');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const tree = parse(treeSchema, response.json());
    const files = tree.tree
      .filter(entry => entry.type === 'blob' && isGitHubDocumentPath(entry.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, limits.documentsPerRepository);
    const offset = Number(offsetText);
    const observations = [
      ...truncation(body, 'doc', commit, accessedAt, tree.truncated, offset),
      ...files
        .slice(offset, offset + limits.listPageSize)
        .map(entry =>
          observation(
            String(body.id),
            'doc',
            entry.path,
            `${body.full_name}: ${entry.path}`,
            `https://github.com/${body.full_name}/blob/${commit}/${encodePath(entry.path)}`,
            `blob:${entry.sha}`,
            accessedAt,
            (entry.size ?? 0) > limits.documentBytes ? 'too-large' : 'supported',
          ),
        ),
    ];
    return {
      observations,
      nextCursor:
        offset + limits.listPageSize < files.length
          ? `docs:${commit}:${offset + limits.listPageSize}`
          : nextPhase(selection, 'docs'),
    };
  }
  async function codeTree(token: string, body: RepositoryBody, commit: string) {
    const response = await call(token, 'github-tree', `/repositories/${body.id}/git/trees/${commit}?recursive=1`);
    if (response.status === 404 || response.status === 409) throw new GitHubCorpusError('invalid-cursor');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const tree = parse(treeSchema, response.json());
    const blobs = tree.tree
      .filter(entry => entry.type === 'blob')
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const code = blobs.flatMap(entry => {
      const coverage = githubCodeCoverage(entry.path);
      return coverage ? [{ ...entry, coverage }] : [];
    });
    return { tree, code, supported: code.filter(entry => entry.coverage === 'supported') };
  }
  async function listCode(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ) {
    const [pinned = '', offsetText = '0'] = state.split(':');
    const commit = pinned || (await headCommit(token, body));
    if (!commit || !/^[a-f0-9]{40,64}$/.test(commit) || !/^\d{1,6}$/.test(offsetText)) {
      if (commit) throw new GitHubCorpusError('invalid-cursor');
      return { observations: [], nextCursor: nextPhase(selection, 'code') };
    }
    const { tree, code, supported } = await codeTree(token, body, commit);
    // Bounded: the first files by path are indexed; skipped files beyond the count bound are listed up to a fixed limit.
    const skipped = [
      ...code.filter(entry => entry.coverage === 'excluded'),
      ...supported.slice(codeFiles).map(entry => ({ ...entry, coverage: 'excluded' as const })),
    ].slice(0, skippedCodeFiles);
    const files = [...supported.slice(0, codeFiles), ...skipped].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const offset = Number(offsetText);
    const observations = [
      ...truncation(body, 'code', commit, accessedAt, tree.truncated, offset),
      ...files
        .slice(offset, offset + limits.listPageSize)
        .map(entry =>
          observation(
            String(body.id),
            'code',
            entry.path,
            `${body.full_name}: ${entry.path}`,
            `https://github.com/${body.full_name}/blob/${commit}/${encodePath(entry.path)}`,
            `blob:${entry.sha}`,
            accessedAt,
            entry.coverage === 'excluded'
              ? 'excluded'
              : (entry.size ?? 0) > limits.documentBytes
                ? 'too-large'
                : 'supported',
          ),
        ),
    ];
    return {
      observations,
      nextCursor:
        offset + limits.listPageSize < files.length
          ? `code:${commit}:${offset + limits.listPageSize}`
          : nextPhase(selection, 'code'),
    };
  }
  async function listIssues(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ) {
    const page = state ? Number(state) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 500) throw new GitHubCorpusError('invalid-cursor');
    const response = await call(
      token,
      'github-issues',
      `/repositories/${body.id}/issues?${new URLSearchParams({ state: 'all', sort: 'updated', direction: 'asc', since: after(selection), per_page: String(limits.issuePageSize), page: String(page) })}`,
    );
    if (response.status === 410 || response.status === 404)
      return { observations: [], nextCursor: nextPhase(selection, 'issues') };
    if (response.status !== 200)
      throw new GitHubCorpusError(response.status === 403 ? 'forbidden' : 'invalid-response');
    const issues = parse(z.array(issueSchema).max(100), response.json());
    const observations = issues
      .filter(
        issue =>
          selection.kinds.includes(issue.pull_request ? 'pulls' : 'issues') && inWindow(selection, issue.updated_at),
      )
      .map(issue =>
        observation(
          String(body.id),
          issue.pull_request ? 'pull' : 'issue',
          String(issue.number),
          `${body.full_name}#${issue.number}: ${oneLine(issue.title)}`,
          issue.html_url,
          `issue:${issue.updated_at}:${issue.comments}`,
          accessedAt,
          issue.comments > limits.comments ? 'too-large' : 'supported',
        ),
      );
    return {
      observations,
      nextCursor: issues.length === limits.issuePageSize ? `issues:${page + 1}` : nextPhase(selection, 'issues'),
    };
  }
  async function listDiscussions(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ) {
    const data = parse(
      z.object({
        node: z
          .object({
            discussions: z
              .object({
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(1024).nullable() }),
                nodes: z.array(discussionNode).max(20),
              })
              .optional(),
          })
          .nullable(),
      }),
      await graphql(token, DISCUSSIONS, { id: body.node_id, cursor: state || null }),
    );
    const connection = data.node?.discussions;
    if (!connection) return { observations: [], nextCursor: null };
    const fresh = connection.nodes.filter(node => inWindow(selection, node.updatedAt));
    const observations = fresh.map(node =>
      observation(
        String(body.id),
        'discussion',
        String(node.number),
        `${body.full_name} discussion #${node.number}: ${oneLine(node.title)}`,
        node.url,
        `discussion:${node.updatedAt}:${node.comments.totalCount}`,
        accessedAt,
        node.comments.totalCount > 100 ? 'too-large' : 'supported',
      ),
    );
    const more =
      connection.pageInfo.hasNextPage && fresh.length === connection.nodes.length && connection.pageInfo.endCursor;
    return { observations, nextCursor: more ? `discussions:${connection.pageInfo.endCursor}` : null };
  }
  async function comments(token: string, repositoryId: string, issue: Issue) {
    if (issue.comments > limits.comments) throw new GitHubCorpusError('too-large');
    const all: z.infer<typeof commentSchema>[] = [];
    for (let page = 1; page <= Math.ceil(limits.comments / 100) && all.length < issue.comments; page++) {
      const response = await call(
        token,
        'github-comments',
        `/repositories/${repositoryId}/issues/${issue.number}/comments?per_page=100&page=${page}`,
      );
      if (response.status !== 200)
        throw new GitHubCorpusError(
          response.status === 404 || response.status === 410 ? 'not-found' : 'invalid-response',
        );
      const batch = parse(z.array(commentSchema).max(100), response.json());
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }
  return {
    async discover(workspaceId, userId, accountId, cursor) {
      const page = cursor === undefined ? 1 : Number(parse(githubCorpusCursorTokenSchema, cursor, 'invalid-cursor'));
      if (!Number.isInteger(page) || page < 1 || page > 100) throw new GitHubCorpusError('invalid-cursor');
      return withAccount(workspaceId, userId, accountId, null, async (credential, binding) => {
        const response = await call(
          credential.accessToken,
          'github-repositories',
          `/user/repos?${new URLSearchParams({ per_page: '50', page: String(page), sort: 'full_name', affiliation: 'owner,collaborator,organization_member' })}`,
        );
        if (response.status !== 200)
          throw new GitHubCorpusError(response.status === 403 ? 'forbidden' : 'invalid-response');
        const items = parse(z.array(z.unknown()).max(100), response.json());
        const repositories = items.flatMap(item => {
          const parsed = repositorySchema.safeParse(item);
          return parsed.success && parsed.data.permissions?.pull !== false ? [repository(parsed.data)] : [];
        });
        return {
          binding,
          items: repositories.filter(repo => repo.visibility === 'public' || credential.scopes.includes('repo')),
          nextCursor: items.length === 50 ? String(page + 1) : null,
        };
      });
    },
    async inspectSelection(workspaceId, userId, accountId, input) {
      const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
      return withAccount(workspaceId, userId, accountId, null, async (credential, binding) => {
        const repositories: GitHubRepository[] = [];
        for (const name of selection.repositories) {
          const [owner = '', repo = ''] = name.split('/');
          const response = await call(
            credential.accessToken,
            'github-repository-selection',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          );
          // A redirect means the repository was renamed or transferred; the caller must select its current name.
          if ([301, 302, 307].includes(response.status)) throw new GitHubCorpusError('invalid-selection');
          if ([403, 404, 410, 451].includes(response.status)) throw new GitHubCorpusError('forbidden');
          if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
          const body = parse(repositorySchema, response.json());
          if (body.full_name.toLowerCase() !== name.toLowerCase()) throw new GitHubCorpusError('invalid-selection');
          if (body.permissions?.pull === false) throw new GitHubCorpusError('forbidden');
          const value = repository(body);
          scoped(credential, value);
          repositories.push(value);
        }
        const [first] = repositories;
        if (!first) throw new GitHubCorpusError('invalid-selection');
        return {
          binding,
          repositories,
          title: repositories.length === 1 ? first.fullName : `${first.fullName} and ${repositories.length - 1} more`,
        };
      });
    },
    async access(workspaceId, userId, expected, repositoryId) {
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const accessedAt = new Date().toISOString();
        let body: RepositoryBody;
        try {
          body = await byId(credential.accessToken, repositoryId);
        } catch (error) {
          if (error instanceof GitHubCorpusError && error.code === 'forbidden')
            return {
              repositoryId,
              fullName: 'unknown/unknown',
              visibility: 'private' as const,
              title: repositoryId,
              accessedAt,
              readable: false,
            };
          throw error;
        }
        const value = repository(body);
        scoped(credential, value);
        return { ...value, accessedAt, readable: true };
      });
    },
    async list(workspaceId, userId, expected, repositoryId, input, cursor) {
      const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
      if (cursor !== null) cursor = parse(githubCorpusCursorTokenSchema, cursor, 'invalid-cursor');
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const body = await byId(credential.accessToken, repositoryId);
        scoped(credential, repository(body));
        const accessedAt = new Date().toISOString();
        const value = cursor ?? `${phases(selection)[0] ?? 'docs'}:`;
        const split = value.indexOf(':');
        const phase = value.slice(0, split);
        const state = value.slice(split + 1);
        if (split < 0 || !(phases(selection) as string[]).includes(phase))
          throw new GitHubCorpusError('invalid-cursor');
        const page =
          phase === 'docs'
            ? await listDocs(credential.accessToken, body, state, accessedAt, selection)
            : phase === 'code'
              ? await listCode(credential.accessToken, body, state, accessedAt, selection)
              : phase === 'issues'
                ? await listIssues(credential.accessToken, body, state, accessedAt, selection)
                : await listDiscussions(credential.accessToken, body, state, accessedAt, selection);
        return {
          observations: page.observations,
          nextCursor: page.nextCursor ? parse(githubCorpusCursorTokenSchema, page.nextCursor) : null,
        };
      });
    },
    async displacedCode(workspaceId, userId, expected, repositoryId, input, nativeIds) {
      const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
      if (!selection.kinds.includes('code')) throw new GitHubCorpusError('outside-selection');
      const ids = parse(z.array(z.string().max(1200)).max(limits.listPageSize), nativeIds, 'invalid-selection');
      const paths = new Map(
        ids.map(id => {
          const { kind, rest } = native(id, repositoryId);
          if (kind !== 'code') throw new GitHubCorpusError('invalid-selection');
          return [rest, id] as const;
        }),
      );
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const token = credential.accessToken;
        const body = await byId(token, repositoryId);
        scoped(credential, repository(body));
        const commit = await headCommit(token, body);
        if (!commit || !paths.size) return [];
        let selected;
        try {
          selected = await codeTree(token, body, commit);
        } catch (error) {
          if (error instanceof GitHubCorpusError && error.code === 'invalid-cursor') return [];
          throw error;
        }
        // A truncated tree cannot prove which files are beyond the bound, so nothing is reported displaced.
        if (selected.tree.truncated) return [];
        return selected.supported.slice(codeFiles).flatMap(entry => {
          const id = paths.get(entry.path);
          return id ? [id] : [];
        });
      });
    },
    async read(workspaceId, userId, expected, repositoryId, nativeId, input): Promise<GitHubItemRead> {
      const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
      const { kind, rest } = native(nativeId, repositoryId);
      if (
        !selection.kinds.includes(
          kind === 'doc'
            ? 'docs'
            : kind === 'code'
              ? 'code'
              : kind === 'issue'
                ? 'issues'
                : kind === 'pull'
                  ? 'pulls'
                  : 'discussions',
        )
      )
        throw new GitHubCorpusError('outside-selection');
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const token = credential.accessToken;
        const accessedAt = new Date().toISOString();
        const body = await byId(token, repositoryId);
        scoped(credential, repository(body));
        if (kind === 'doc' || kind === 'code') {
          if (
            kind === 'doc'
              ? !isGitHubDocumentPath(rest) || rest.length > 1024
              : githubCodeCoverage(rest) !== 'supported'
          )
            throw new GitHubCorpusError('outside-selection');
          const commit = await headCommit(token, body);
          if (!commit) throw new GitHubCorpusError('not-found');
          const response = await call(
            token,
            'github-content',
            `/repositories/${body.id}/contents/${encodePath(rest)}?ref=${commit}`,
          );
          if ([404, 410].includes(response.status)) throw new GitHubCorpusError('not-found');
          if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
          const file = parse(contentSchema, response.json(), 'not-found');
          const base = observation(
            repositoryId,
            kind,
            rest,
            `${body.full_name}: ${rest}`,
            `https://github.com/${body.full_name}/blob/${commit}/${encodePath(rest)}`,
            `blob:${file.sha}`,
            accessedAt,
          );
          if (file.size > limits.documentBytes || file.encoding !== 'base64' || file.content === undefined)
            throw new GitHubCorpusError('too-large');
          const bytes = Buffer.from(file.content, 'base64');
          if (bytes.byteLength !== file.size) throw new GitHubCorpusError('invalid-response');
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            throw new GitHubCorpusError('unsupported');
          }
          if (content.includes('\0')) throw new GitHubCorpusError('unsupported');
          const text = content
            .replace(/^\uFEFF/, '')
            .replace(/\r\n?/g, '\n')
            .trim();
          const body_ = kind === 'code' ? `${fence(text)}\n${text}\n${fence(text)}` : text;
          const markdown = `# ${body.full_name}: ${rest}\n\nGitHub repository ${body.full_name} (ID ${body.id}), file \`${rest.replaceAll('`', '')}\` at commit ${commit} (blob ${file.sha}).\n\n---\n\n${body_}\n`;
          if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new GitHubCorpusError('too-large');
          return { ...base, markdown };
        }
        if (kind === 'discussion') {
          const data = parse(
            z.object({ node: z.object({ discussion: discussionSchema.nullable().optional() }).nullable() }),
            await graphql(token, DISCUSSION, { id: body.node_id, number: Number(rest) }),
          );
          const discussion = data.node?.discussion;
          if (!discussion) throw new GitHubCorpusError('not-found');
          if (!inWindow(selection, discussion.updatedAt)) throw new GitHubCorpusError('outside-selection');
          if (
            discussion.comments.totalCount > 100 ||
            discussion.comments.nodes.some(comment => comment.replies.totalCount > 50)
          )
            throw new GitHubCorpusError('too-large');
          const markdown = serializeGitHubDiscussion(body.full_name, discussion);
          if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new GitHubCorpusError('too-large');
          return {
            ...observation(
              repositoryId,
              'discussion',
              rest,
              `${body.full_name} discussion #${discussion.number}: ${oneLine(discussion.title)}`,
              discussion.url,
              `discussion:${discussion.updatedAt}:${discussion.comments.totalCount}`,
              accessedAt,
            ),
            markdown,
          };
        }
        const response = await call(token, 'github-issue', `/repositories/${body.id}/issues/${rest}`);
        // Deleted (410), missing (404) and transferred (301) issues no longer belong to this repository.
        if ([301, 302, 307, 404, 410].includes(response.status)) throw new GitHubCorpusError('not-found');
        if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
        const issue = parse(issueSchema, response.json());
        if ((issue.pull_request ? 'pull' : 'issue') !== kind || String(issue.number) !== rest)
          throw new GitHubCorpusError('not-found');
        if (!inWindow(selection, issue.updated_at)) throw new GitHubCorpusError('outside-selection');
        const markdown = serializeGitHubIssue(body.full_name, issue, await comments(token, repositoryId, issue));
        if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new GitHubCorpusError('too-large');
        return {
          ...observation(
            repositoryId,
            kind,
            rest,
            `${body.full_name}#${issue.number}: ${oneLine(issue.title)}`,
            issue.html_url,
            `issue:${issue.updated_at}:${issue.comments}`,
            accessedAt,
          ),
          markdown,
        };
      });
    },
  };
}

const unconfigured = async (): Promise<never> => {
  throw new GitHubCorpusError('not-configured');
};
export const unconfiguredGitHubCorpusProvider: GitHubCorpusProvider = {
  discover: unconfigured,
  inspectSelection: unconfigured,
  access: unconfigured,
  list: unconfigured,
  read: unconfigured,
  displacedCode: unconfigured,
};

// Reuses the personal GitHub OAuth configuration and integration credential keys. Missing configuration reports not-configured instead of blocking startup.
export function githubCorpusFromEnvironment(options: {
  runtime: AccountRuntime;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
}): GitHubCorpusProvider {
  const env = options.env ?? process.env;
  try {
    const configuration = githubConfiguration(env);
    if (!configuration) return unconfiguredGitHubCorpusProvider;
    const accounts = createGitHubAccounts({
      runtime: options.runtime,
      configuration,
      keyring: integrationCredentialKeyring(env),
    });
    return createGitHubCorpusProvider({ accounts, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  } catch {
    return unconfiguredGitHubCorpusProvider;
  }
}
