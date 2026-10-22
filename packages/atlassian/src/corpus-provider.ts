import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { AccessDenied } from '@tulipfarm/access';
import { integrationCredentialKeyring } from '@tulipfarm/integrations/credentials';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import {
  AtlassianCorpusError,
  atlassianCorpusBindingSchema,
  atlassianCorpusLimits as limits,
  atlassianCorpusSelectionSchema,
  atlassianCursorTokenSchema,
  atlassianNumericIdSchema,
  atlassianProductSchema,
  type AtlassianCorpusBinding,
  type AtlassianCorpusErrorCode,
  type AtlassianCorpusProvider,
  type AtlassianCorpusSelection,
  type AtlassianDiscoverKind,
  type AtlassianItemObservation,
  type AtlassianProduct,
  type AtlassianSelectedTarget,
  type AtlassianTarget,
} from '@tulipfarm/knowledge/atlassian-contracts';
import { AccountError } from './account-contracts.ts';
import { accountConfigurations } from './account-provider.ts';
import { createAtlassianAccounts, type AccountRuntime } from './accounts.ts';
import { adfToMarkdown, escapeMarkdownText } from './adf-markdown.ts';

type Accounts = Pick<ReturnType<typeof createAtlassianAccounts>, 'list' | 'withAccessToken'>;
type Account = Awaited<ReturnType<Accounts['list']>>['accounts'][number];
type Credential = { binding: AtlassianCorpusBinding; site: string; scopes: string[] };
type Request = (path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<unknown>;
/** Minimum read scope per product. Absent scopes block the selection with `insufficient-scope`. */
export const atlassianCorpusScopes: Record<AtlassianProduct, readonly string[]> = {
  confluence: ['read:page:confluence'],
  jira: ['read:jira-work'],
};
const id = atlassianNumericIdSchema;
const nextSchema = z.object({ next: z.string().max(8192).optional() }).optional();
const versionSchema = z.object({
  number: z.number().int().positive(),
  authorId: z.string().max(256).optional(),
  createdAt: z.string().max(64).optional(),
});
const pageSchema = z.object({
  id,
  title: z.string().max(512),
  status: z.string().max(64),
  spaceId: id.optional(),
  version: versionSchema.optional(),
  authorId: z.string().max(256).optional(),
  createdAt: z.string().max(64).optional(),
  _links: z.object({ webui: z.string().max(4096).optional() }).optional(),
  body: z.object({ atlas_doc_format: z.object({ value: z.string() }).optional() }).optional(),
});
const userSchema = z
  .object({ accountId: z.string().max(256).optional(), displayName: z.string().max(256).optional() })
  .nullable()
  .optional();
const issueSummarySchema = z.object({
  id,
  key: z.string().max(64),
  fields: z.object({ summary: z.string().max(4096).optional(), updated: z.string().max(64) }),
});
const commentSchema = z.object({
  id: z.string().max(64),
  author: userSchema,
  updateAuthor: userSchema,
  body: z.unknown(),
  created: z.string().max(64),
  updated: z.string().max(64).optional(),
  visibility: z.object({ type: z.string(), value: z.string().optional() }).optional(),
  jsdPublic: z.boolean().optional(),
});
const unavailableTargetCodes: readonly AtlassianCorpusErrorCode[] = [
  'forbidden',
  'not-found',
  'invalid-selection',
  'invalid-response',
];
const statusCodes: Record<number, AtlassianCorpusErrorCode> = {
  400: 'invalid-selection',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not-found',
  410: 'not-found',
  413: 'response-too-large',
};

function parse<T>(schema: z.ZodType<T>, value: unknown, code: AtlassianCorpusErrorCode = 'invalid-response'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AtlassianCorpusError(code);
  return result.data;
}
function cursorFrom(next: string | undefined) {
  if (!next) return null;
  try {
    const value = new URL(next, 'https://api.atlassian.com').searchParams.get('cursor');
    return value ? parse(atlassianCursorTokenSchema, value) : null;
  } catch (error) {
    if (error instanceof AtlassianCorpusError) throw error;
    throw new AtlassianCorpusError('invalid-response');
  }
}
function person(user: z.infer<typeof userSchema>) {
  if (!user) return 'an unknown author';
  const name = user.displayName ? escapeMarkdownText(user.displayName) : 'unknown name';
  return user.accountId ? `${name} (${user.accountId})` : name;
}
const when = (value: string | undefined) => {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? new Date(time).toISOString() : 'an unknown time';
};
function bounded(markdown: string) {
  if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new AtlassianCorpusError('item-too-large');
  return markdown;
}
export function serializeConfluencePage(page: z.infer<typeof pageSchema>, space: string) {
  const lines = [
    `# ${escapeMarkdownText(page.title).replaceAll('\n', ' ')}`,
    '',
    `Confluence page ${page.id} in space ${space}, version ${page.version?.number ?? 'unknown'}. Created by ${page.authorId ?? 'an unknown author'} at ${when(page.createdAt)}. Last edited by ${page.version?.authorId ?? 'an unknown author'} at ${when(page.version?.createdAt)}.`,
    '',
  ];
  let body: unknown = null;
  try {
    body = JSON.parse(page.body?.atlas_doc_format?.value ?? 'null');
  } catch {
    throw new AtlassianCorpusError('invalid-response');
  }
  lines.push(adfToMarkdown(body) || '_No text content._');
  return bounded(`${lines.join('\n')}\n`);
}
export function serializeJiraIssue(
  issue: { id: string; key: string; fields: Record<string, unknown> },
  comments: z.infer<typeof commentSchema>[],
) {
  const fields = issue.fields;
  const name = (value: unknown) => {
    const v = z
      .object({ name: z.string().max(256) })
      .nullable()
      .optional()
      .safeParse(value);
    return v.success && v.data ? escapeMarkdownText(v.data.name) : 'unknown';
  };
  const reporter = userSchema.safeParse(fields.reporter);
  const lines = [
    `# ${issue.key}: ${escapeMarkdownText(String(fields.summary ?? '')).replaceAll('\n', ' ')}`,
    '',
    `Jira issue ${issue.key} (${issue.id}) in project ${name(fields.project)}. Type: ${name(fields.issuetype)}. Status: ${name(fields.status)}. Reported by ${person(reporter.success ? reporter.data : null)} at ${when(String(fields.created ?? ''))}. Updated ${when(String(fields.updated ?? ''))}.`,
    '',
    '## Description',
    '',
    adfToMarkdown(fields.description) || '_No description._',
  ];
  for (const comment of comments) {
    const edited = comment.updated && comment.updated !== comment.created ? ` (edited ${when(comment.updated)})` : '';
    lines.push(
      '',
      `## Comment by ${person(comment.author)} at ${when(comment.created)}${edited}`,
      '',
      adfToMarkdown(comment.body) || '_No text content._',
    );
  }
  return bounded(`${lines.join('\n')}\n`);
}
const allowedComment = (comment: z.infer<typeof commentSchema>) => !comment.visibility && comment.jsdPublic !== false;

export function createAtlassianCorpusProvider(options: {
  accounts: Accounts;
  fetcher?: typeof fetch;
}): AtlassianCorpusProvider {
  const fetcher = observeFetch('atlassian', 'request', options.fetcher ?? fetch);
  async function eligible(workspaceId: string, userId: string, only?: string) {
    let listed;
    try {
      listed = await options.accounts.list(workspaceId, userId);
    } catch (error) {
      throw mapped(error);
    }
    const accounts = listed.accounts.filter(
      account =>
        account.protocol === 'atlassian-rest' &&
        account.ownership === 'personal' &&
        account.state === 'active' &&
        account.capabilities.use &&
        account.identity?.qualification === 'verified',
    );
    if (only === undefined) return accounts;
    const pinned = accounts.filter(account => account.id === only);
    if (!pinned.length) throw new AtlassianCorpusError('stale-integration');
    return pinned;
  }
  function mapped(error: unknown) {
    if (error instanceof AtlassianCorpusError) return error;
    if (error instanceof AccessDenied) return new AtlassianCorpusError('not-linked');
    if (error instanceof AccountError)
      return new AtlassianCorpusError(
        error.code === 'account-disabled'
          ? 'not-configured'
          : error.code === 'account-refresh-in-progress' || error.code === 'account-unavailable'
            ? 'transient'
            : 'reconnect-required',
      );
    return new AtlassianCorpusError('transient');
  }
  async function credential(
    workspaceId: string,
    userId: string,
    cloudId: string,
    expected?: AtlassianCorpusBinding,
    only?: string,
  ): Promise<Credential> {
    const accounts = await eligible(workspaceId, userId, only);
    const matches = (account: Account) => account.resources.find(resource => resource.id === cloudId);
    const account = expected ? accounts.find(item => item.id === expected.accountId) : accounts.find(matches);
    if (!account || !account.identity) throw new AtlassianCorpusError(expected ? 'stale-integration' : 'not-linked');
    const site = matches(account);
    if (!site) throw new AtlassianCorpusError(expected ? 'stale-integration' : 'not-linked');
    const binding = parse(atlassianCorpusBindingSchema, {
      accountId: account.id,
      atlassianAccountId: account.identity.id,
      cloudId,
    });
    if (
      expected &&
      JSON.stringify(parse(atlassianCorpusBindingSchema, expected, 'stale-integration')) !== JSON.stringify(binding)
    )
      throw new AtlassianCorpusError('stale-integration');
    return { binding, site: site.url.replace(/\/$/, ''), scopes: [...new Set([...account.scopes, ...site.scopes])] };
  }
  function requireScopes(current: Credential, product: AtlassianProduct) {
    if (!atlassianCorpusScopes[product].every(scope => current.scopes.includes(scope)))
      throw new AtlassianCorpusError('insufficient-scope');
  }
  // Runs one request sequence with the account's current access token. The account generation is the token incarnation.
  async function withToken<T>(
    workspaceId: string,
    userId: string,
    current: Credential,
    product: AtlassianProduct,
    operation: (request: Request, generation: number) => Promise<T>,
  ): Promise<T> {
    requireScopes(current, product);
    try {
      return await options.accounts.withAccessToken(workspaceId, userId, current.binding.accountId, async token => {
        const base = `https://api.atlassian.com/ex/${product}/${current.binding.cloudId}`;
        const request: Request = (path, init = {}) =>
          call(token.accessToken, new URL(`${base}${path}`), init.method ?? 'GET', init.body);
        return operation(request, token.generation);
      });
    } catch (error) {
      throw mapped(error);
    }
  }
  async function call(token: string, url: URL, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AtlassianCorpusError('transient');
    }
    const retry = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retry) && retry >= 0 ? Math.min(3_600_000, Math.ceil(retry * 1000)) : null;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > limits.responseBytes)
        throw new AtlassianCorpusError('response-too-large');
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limits.responseBytes) throw new AtlassianCorpusError('response-too-large');
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof AtlassianCorpusError) throw error;
      throw new AtlassianCorpusError('transient');
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
    if (response.status === 429) throw new AtlassianCorpusError('rate-limited', retryAfterMs);
    if (response.status >= 500) throw new AtlassianCorpusError('transient', retryAfterMs);
    if (response.status !== 200) throw new AtlassianCorpusError(statusCodes[response.status] ?? 'invalid-response');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new AtlassianCorpusError('invalid-response');
    }
  }
  const observedNow = () => new Date().toISOString();
  async function pagesById(request: Request, ids: string[]) {
    if (!ids.length) return [];
    const params = new URLSearchParams({ id: ids.join(','), limit: '250', status: 'current' });
    const body = parse(
      z.object({ results: z.array(pageSchema).max(250) }),
      await request(`/wiki/api/v2/pages?${params}`),
    );
    return body.results.filter(page => ids.includes(page.id) && page.status === 'current');
  }
  function pageObservation(site: string, page: z.infer<typeof pageSchema>): AtlassianItemObservation {
    if (!page.version) throw new AtlassianCorpusError('invalid-response');
    return {
      nativeId: `page:${page.id}`,
      itemId: page.id,
      title: (page.title || `Page ${page.id}`).slice(0, 512),
      canonicalURL: page._links?.webui?.startsWith('/')
        ? `${site}/wiki${page._links.webui}`
        : `${site}/wiki/pages/viewpage.action?pageId=${page.id}`,
      sourceRevision: String(page.version.number),
      coverage: 'supported',
    };
  }
  function issueObservation(site: string, issue: z.infer<typeof issueSummarySchema>): AtlassianItemObservation {
    return {
      nativeId: `issue:${issue.id}`,
      itemId: issue.id,
      title: `${issue.key}: ${issue.fields.summary ?? ''}`.slice(0, 512),
      canonicalURL: `${site}/browse/${encodeURIComponent(issue.key)}`,
      sourceRevision: issue.fields.updated.slice(0, 128),
      coverage: 'supported',
    };
  }
  const productOf = (kind: AtlassianTarget['kind']): AtlassianProduct => (kind === 'project' ? 'jira' : 'confluence');
  async function target(request: Request, kind: AtlassianTarget['kind'], targetId: string): Promise<AtlassianTarget> {
    if (kind === 'space') {
      const space = parse(
        z.object({ id, key: z.string().max(255), name: z.string().max(512) }),
        await request(`/wiki/api/v2/spaces/${targetId}`),
      );
      return { kind, id: space.id, key: space.key, title: space.name || space.key };
    }
    if (kind === 'page') {
      const page = parse(pageSchema, await request(`/wiki/api/v2/pages/${targetId}`));
      if (page.status !== 'current') throw new AtlassianCorpusError('not-found');
      return { kind, id: page.id, key: null, title: page.title || `Page ${page.id}` };
    }
    const project = parse(
      z.object({ id, key: z.string().max(255), name: z.string().max(512) }),
      await request(`/rest/api/3/project/${targetId}`),
    );
    return { kind, id: project.id, key: project.key, title: project.name || project.key };
  }
  return {
    async sites(workspaceId, userId, scope?: { account?: string }) {
      const seen = new Map<string, { cloudId: string; name: string; url: string }>();
      for (const account of await eligible(workspaceId, userId, scope?.account))
        for (const site of account.resources)
          if (z.uuid().safeParse(site.id).success && !seen.has(site.id))
            seen.set(site.id, { cloudId: site.id, name: site.name || site.url, url: site.url });
      return { items: [...seen.values()] };
    },
    async discover(
      workspaceId,
      userId,
      cloudId,
      kind: AtlassianDiscoverKind,
      within,
      cursor,
      scope?: { account?: string },
    ) {
      if (cursor !== undefined) cursor = parse(atlassianCursorTokenSchema, cursor, 'invalid-cursor');
      const current = await credential(
        workspaceId,
        userId,
        parse(z.uuid(), cloudId, 'invalid-selection'),
        undefined,
        scope?.account,
      );
      const product = kind === 'projects' ? 'jira' : 'confluence';
      return withToken(workspaceId, userId, current, product, async request => {
        if (kind === 'projects') {
          const startAt =
            cursor === undefined ? 0 : parse(z.coerce.number().int().min(0).max(100000), cursor, 'invalid-cursor');
          const body = parse(
            z.object({
              values: z.array(z.object({ id, key: z.string().max(255), name: z.string().max(512) })).max(100),
              isLast: z.boolean().optional(),
            }),
            await request(
              `/rest/api/3/project/search?${new URLSearchParams({ startAt: String(startAt), maxResults: '50', orderBy: 'name' })}`,
            ),
          );
          return {
            binding: current.binding,
            items: body.values.map(item => ({
              kind: 'project' as const,
              id: item.id,
              key: item.key,
              title: item.name || item.key,
            })),
            nextCursor: body.isLast === false && body.values.length ? String(startAt + body.values.length) : null,
          };
        }
        if (kind === 'pages') {
          const space = parse(id, within, 'invalid-selection');
          const body = parse(
            z.object({ results: z.array(pageSchema).max(250), _links: nextSchema }),
            await request(
              `/wiki/api/v2/spaces/${space}/pages?${new URLSearchParams({ limit: '50', status: 'current', ...(cursor ? { cursor } : {}) })}`,
            ),
          );
          return {
            binding: current.binding,
            items: body.results.map(page => ({
              kind: 'page' as const,
              id: page.id,
              key: null,
              title: page.title || `Page ${page.id}`,
            })),
            nextCursor: cursorFrom(body._links?.next),
          };
        }
        const body = parse(
          z.object({
            results: z
              .array(
                z.object({ id, key: z.string().max(255), name: z.string().max(512), status: z.string().optional() }),
              )
              .max(250),
            _links: nextSchema,
          }),
          await request(
            `/wiki/api/v2/spaces?${new URLSearchParams({ limit: '50', status: 'current', ...(cursor ? { cursor } : {}) })}`,
          ),
        );
        return {
          binding: current.binding,
          items: body.results.map(space => ({
            kind: 'space' as const,
            id: space.id,
            key: space.key,
            title: space.name || space.key,
          })),
          nextCursor: cursorFrom(body._links?.next),
        };
      });
    },
    async inspectSelection(
      workspaceId,
      userId,
      input: AtlassianCorpusSelection,
      options?: { skipUnavailable?: boolean; account?: string },
    ) {
      const selection = parse(atlassianCorpusSelectionSchema, input, 'invalid-selection');
      const current = await credential(workspaceId, userId, selection.cloudId, undefined, options?.account);
      const targets = await withToken(workspaceId, userId, current, selection.product, async request => {
        const found: AtlassianTarget[] = [];
        for (const item of selection.targets) {
          try {
            found.push(await target(request, item.kind, item.id));
          } catch (error) {
            if (
              !options?.skipUnavailable ||
              !(error instanceof AtlassianCorpusError) ||
              !unavailableTargetCodes.includes(error.code)
            )
              throw error;
          }
        }
        return found;
      });
      const [first] = targets;
      if (!first && !options?.skipUnavailable) throw new AtlassianCorpusError('invalid-selection');
      return {
        binding: current.binding,
        targets,
        title: !first
          ? 'Unavailable selection'
          : targets.length === 1
            ? first.title
            : `${first.title} and ${targets.length - 1} more`,
      };
    },
    async access(workspaceId, userId, expected, product, itemIds) {
      product = parse(atlassianProductSchema, product, 'invalid-selection');
      const ids = parse(z.array(id).min(1).max(limits.accessBatch), itemIds, 'invalid-selection');
      const current = await credential(workspaceId, userId, expected.cloudId, expected);
      return withToken(workspaceId, userId, current, product, async (request, accountGeneration) => {
        const accessedAt = observedNow();
        if (product === 'confluence')
          return { accessedAt, accountGeneration, visible: (await pagesById(request, ids)).map(page => page.id) };
        const body = parse(
          z.object({ issues: z.array(z.object({ id })).max(100) }),
          await request('/rest/api/3/issue/bulkfetch', {
            method: 'POST',
            body: { issueIdsOrKeys: ids, fields: ['updated'] },
          }),
        );
        return {
          accessedAt,
          accountGeneration,
          visible: body.issues.map(issue => issue.id).filter(item => ids.includes(item)),
        };
      });
    },
    async list(workspaceId, userId, expected, selected: AtlassianSelectedTarget, cursor) {
      if (cursor !== null) cursor = parse(atlassianCursorTokenSchema, cursor, 'invalid-cursor');
      const current = await credential(workspaceId, userId, expected.cloudId, expected);
      const product = productOf(selected.kind);
      return withToken(workspaceId, userId, current, product, async (request, accountGeneration) => {
        const accessedAt = observedNow();
        if (selected.kind === 'project') {
          const body = parse(
            z.object({
              issues: z.array(issueSummarySchema).max(100),
              nextPageToken: z.string().max(4096).optional(),
              isLast: z.boolean().optional(),
            }),
            await request('/rest/api/3/search/jql', {
              method: 'POST',
              body: {
                jql: `project = ${parse(id, selected.id, 'invalid-selection')} ORDER BY id ASC`,
                fields: ['summary', 'updated'],
                maxResults: limits.listPageSize,
                ...(cursor ? { nextPageToken: cursor } : {}),
              },
            }),
          );
          const next =
            body.isLast === false || (body.isLast === undefined && body.nextPageToken)
              ? parse(atlassianCursorTokenSchema, body.nextPageToken)
              : null;
          return {
            accessedAt,
            accountGeneration,
            observations: body.issues.map(issue => issueObservation(current.site, issue)),
            nextCursor: next,
          };
        }
        if (selected.kind === 'space') {
          const body = parse(
            z.object({ results: z.array(pageSchema).max(250), _links: nextSchema }),
            await request(
              `/wiki/api/v2/spaces/${selected.id}/pages?${new URLSearchParams({ limit: String(limits.listPageSize), status: 'current', ...(cursor ? { cursor } : {}) })}`,
            ),
          );
          return {
            accessedAt,
            accountGeneration,
            observations: body.results
              .filter(page => page.status === 'current')
              .map(page => pageObservation(current.site, page)),
            nextCursor: cursorFrom(body._links?.next),
          };
        }
        if (!selected.descendants)
          return {
            accessedAt,
            accountGeneration,
            observations: (await pagesById(request, [selected.id])).map(page => pageObservation(current.site, page)),
            nextCursor: null,
          };
        const body = parse(
          z.object({
            results: z
              .array(z.object({ id, type: z.string().max(64).optional(), status: z.string().max(64).optional() }))
              .max(250),
            _links: nextSchema,
          }),
          await request(
            `/wiki/api/v2/pages/${selected.id}/descendants?${new URLSearchParams({ limit: String(limits.listPageSize), ...(cursor ? { cursor } : {}) })}`,
          ),
        );
        const ids = [
          ...(cursor ? [] : [selected.id]),
          ...body.results
            .filter(item => (item.type ?? 'page') === 'page' && (item.status ?? 'current') === 'current')
            .map(item => item.id),
        ];
        return {
          accessedAt,
          accountGeneration,
          observations: (await pagesById(request, ids)).map(page => pageObservation(current.site, page)),
          nextCursor: cursorFrom(body._links?.next),
        };
      });
    },
    async read(workspaceId, userId, expected, selected: AtlassianSelectedTarget, itemId) {
      itemId = parse(id, itemId, 'invalid-selection');
      const current = await credential(workspaceId, userId, expected.cloudId, expected);
      const product = productOf(selected.kind);
      return withToken(workspaceId, userId, current, product, async (request, accountGeneration) => {
        const accessedAt = observedNow();
        if (product === 'confluence') {
          const page = parse(
            pageSchema,
            await request(`/wiki/api/v2/pages/${itemId}?${new URLSearchParams({ 'body-format': 'atlas_doc_format' })}`),
          );
          if (page.id !== itemId) throw new AtlassianCorpusError('invalid-response');
          if (page.status !== 'current') throw new AtlassianCorpusError('not-found');
          if (selected.kind === 'space' && page.spaceId !== selected.id)
            throw new AtlassianCorpusError('outside-selection');
          if (selected.kind === 'page' && itemId !== selected.id) {
            if (!selected.descendants) throw new AtlassianCorpusError('outside-selection');
            const ancestors = parse(
              z.object({ results: z.array(z.object({ id })).max(250) }),
              await request(`/wiki/api/v2/pages/${itemId}/ancestors?limit=250`),
            );
            if (!ancestors.results.some(item => item.id === selected.id))
              throw new AtlassianCorpusError('outside-selection');
          }
          return {
            ...pageObservation(current.site, page),
            accessedAt,
            accountGeneration,
            markdown: serializeConfluencePage(
              page,
              selected.kind === 'space' && selected.key ? selected.key : (page.spaceId ?? 'unknown'),
            ),
          };
        }
        const fields = 'summary,description,status,issuetype,project,reporter,created,updated';
        const issue = parse(
          z.object({ id, key: z.string().max(64), fields: z.record(z.string(), z.unknown()) }),
          await request(`/rest/api/3/issue/${itemId}?${new URLSearchParams({ fields })}`),
        );
        if (issue.id !== itemId) throw new AtlassianCorpusError('invalid-response');
        const project = parse(z.object({ id }), issue.fields.project);
        if (project.id !== selected.id) throw new AtlassianCorpusError('outside-selection');
        const updated = parse(z.string().max(64), issue.fields.updated);
        const comments: z.infer<typeof commentSchema>[] = [];
        for (let page = 0, startAt = 0; ; page++) {
          if (page >= limits.commentPages) throw new AtlassianCorpusError('item-too-large');
          const body = parse(
            z.object({
              comments: z.array(commentSchema).max(100),
              total: z.number().int().min(0),
              startAt: z.number().int().min(0),
            }),
            await request(
              `/rest/api/3/issue/${itemId}/comment?${new URLSearchParams({ startAt: String(startAt), maxResults: '100', orderBy: 'created' })}`,
            ),
          );
          if (body.total > limits.comments) throw new AtlassianCorpusError('item-too-large');
          comments.push(...body.comments.filter(allowedComment));
          startAt += body.comments.length;
          if (!body.comments.length || startAt >= body.total) break;
        }
        const summary = issueObservation(current.site, {
          id: issue.id,
          key: issue.key,
          fields: { summary: String(issue.fields.summary ?? ''), updated },
        });
        return { ...summary, accessedAt, accountGeneration, markdown: serializeJiraIssue(issue, comments) };
      });
    },
  };
}

const unconfigured = async (): Promise<never> => {
  throw new AtlassianCorpusError('not-configured');
};
export const unconfiguredAtlassianCorpusProvider: AtlassianCorpusProvider = {
  sites: unconfigured,
  discover: unconfigured,
  inspectSelection: unconfigured,
  access: unconfigured,
  list: unconfigured,
  read: unconfigured,
};

// Reuses the existing Atlassian REST account configuration and integration credential keys. Missing configuration reports not-configured.
export function atlassianCorpusFromEnvironment(options: {
  runtime: AccountRuntime;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  keyring?: IntegrationKeyring;
}): AtlassianCorpusProvider {
  const env = options.env ?? process.env;
  const configurations = accountConfigurations(env);
  if (!configurations['atlassian-rest']) return unconfiguredAtlassianCorpusProvider;
  try {
    const keyring = options.keyring ?? integrationCredentialKeyring(env);
    const accounts = createAtlassianAccounts({
      runtime: options.runtime,
      configurations,
      keyring,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    return createAtlassianCorpusProvider({ accounts, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  } catch {
    return unconfiguredAtlassianCorpusProvider;
  }
}
