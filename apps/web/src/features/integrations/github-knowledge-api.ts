import { z } from 'zod';
import {
  githubCorpusBindingSchema,
  githubCorpusKindSchema,
  githubCorpusKinds,
  githubCorpusLimits,
  githubCorpusSelectionSchema,
  githubExcludePatternProblem,
  type GitHubKnowledgeSettings,
} from '@tulipfarm/knowledge/github-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';

const repositorySchema = z.object({
  repositoryId: z.string(),
  fullName: z.string(),
  visibility: z.enum(['public', 'private', 'internal']),
  title: z.string(),
});
const sourceSchema = z.object({
  sourceId: z.uuid(),
  selection: githubCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()),
  title: z.string(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().nullable(),
  nextAttemptAt: z.iso.datetime(),
  repositories: z
    .array(
      repositorySchema.extend({
        state: z.enum(['active', 'unavailable']),
        failure: z.string().nullable(),
        excluded: z.boolean().default(false),
        status: z.enum(['active', 'excluded', 'needs-permission', 'access-lost']).default('active'),
        missingKinds: z.array(githubCorpusKindSchema).default([]),
      }),
    )
    .nullable(),
  counts: z
    .object({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
  canManage: z.boolean(),
  connection: z.enum(['connected', 'reconnect-required']).default('connected'),
  accountId: z.uuid().nullable().default(null),
  repositoryCounts: z
    .object({
      active: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
      needsPermission: z.number().int().nonnegative(),
      accessLost: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
});
const discoverySchema = z.object({
  binding: githubCorpusBindingSchema,
  items: z.array(repositorySchema),
  nextCursor: z.string().nullable(),
});
const refreshSchema = z.object({
  refreshed: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  bounded: z.literal(true),
});
const documentSchema = z.object({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().nullable(),
  historical: z.boolean().default(false),
  validUntil: z.iso.datetime(),
  canRetry: z.boolean(),
});
export type GitHubDocument = z.infer<typeof documentSchema>;
export type GitHubSource = z.infer<typeof sourceSchema>;
export type GitHubSelection = z.infer<typeof githubCorpusSelectionSchema>;
export type GitHubKind = z.infer<typeof githubCorpusKindSchema>;
export type GitHubRepositoryChoice = z.infer<typeof repositorySchema>;
export type ConfigureGitHub = { commandId: string; accountId: string; selection: GitHubSelection; memberIds: string[] };
export type ManageGitHub = { commandId: string; action: 'pause' | 'resume' | 'retry' | 'remove' };
export type GitHubSettings = GitHubKnowledgeSettings;
export { githubCorpusKinds, githubCorpusLimits, githubCorpusSelectionSchema, githubExcludePatternProblem };

export const githubKnowledgeErrorMessages: Record<string, string> = {
  'github-not-configured':
    'GitHub knowledge is not configured on this server yet. Ask your operator to configure personal GitHub accounts.',
  'github-not-linked': 'Connect this GitHub account first, then try again.',
  'github-reconnect-required': 'This GitHub account needs to be reconnected. Reconnect it, then retry.',
  'github-stale-integration': 'This GitHub account changed. Reload the repository list, then retry.',
  'github-insufficient-scope':
    'This GitHub account cannot read private repositories. Reconnect it with repository access.',
  'github-unauthenticated': 'GitHub rejected this account. Reconnect it, then retry.',
  'github-forbidden': 'Your GitHub account cannot read one of these repositories.',
  'github-rate-limited': 'GitHub is limiting requests. Wait a minute, then try again.',
  'github-invalid-selection':
    'A repository was renamed, a date is in the future or an exclude pattern was rejected. Reload and try again.',
};

export class GitHubKnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.message =
      githubKnowledgeErrorMessages[code] ??
      (status === 409
        ? 'This source changed. Check source status before trying again.'
        : status === 400
          ? 'The source selection was rejected. Check the repositories, content types, date, and members.'
          : status === 413
            ? 'This selection exceeds the Knowledge limit of 1,000 repositories. Choose fewer repositories.'
            : [401, 403, 404].includes(status)
              ? 'This source or GitHub account is unavailable to you. Check your GitHub account and source access.'
              : 'Could not confirm the GitHub request. Check your connection and try again.');
  }
}

export function githubKnowledgeApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/github`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    const value = await readJson(response, !response.ok);
    if (!response.ok) throw new GitHubKnowledgeError(response.status, responseError(value, 'unavailable'));
    return value;
  }
  return {
    members: async (signal: AbortSignal) =>
      z
        .object({ members: z.array(z.object({ id: z.uuid(), name: z.string(), email: z.email() })) })
        .parse(await request('/members', 'GET', signal)),
    documents: async (sourceId: string, cursor: string | null, signal: AbortSignal) =>
      z
        .object({ items: z.array(documentSchema), nextCursor: z.string().nullable() })
        .parse(
          await request(
            `/sources/${encodeURIComponent(sourceId)}/documents${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
            'GET',
            signal,
          ),
        ),
    discover: async (accountId: string, cursor: string | null, signal: AbortSignal) =>
      discoverySchema.parse(
        await request(`/discover?${new URLSearchParams({ accountId, ...(cursor ? { cursor } : {}) })}`, 'GET', signal),
      ),
    list: async (signal: AbortSignal) =>
      z.object({ items: z.array(sourceSchema) }).parse(await request('/sources', 'GET', signal)),
    configure: async (input: ConfigureGitHub, signal: AbortSignal) =>
      sourceSchema.parse(await request('/sources', 'POST', signal, input)),
    manage: async (sourceId: string, input: ManageGitHub, signal: AbortSignal) =>
      sourceSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/manage`, 'POST', signal, input)),
    settings: async (sourceId: string, input: GitHubSettings, signal: AbortSignal) =>
      sourceSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/settings`, 'POST', signal, input)),
    refresh: async (sourceId: string, signal: AbortSignal) =>
      refreshSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/refresh`, 'POST', signal)),
    async original(documentId: string, revisionId: string, signal: AbortSignal) {
      const response = await fetch(
        `${base}/documents/${encodeURIComponent(documentId)}/original?${new URLSearchParams({ revisionId })}`,
        { credentials: 'include', signal: requestSignal(signal), cache: 'no-store' },
      );
      if (!response.ok) throw new GitHubKnowledgeError(response.status, 'unavailable');
      const blob = await response.blob();
      const encoded = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      let filename = 'github-document.md';
      try {
        if (encoded) filename = decodeURIComponent(encoded);
      } catch {
        /* The server name is optional; keep the safe default. */
      }
      return { blob, filename };
    },
  };
}
export type GitHubKnowledgeApi = ReturnType<typeof githubKnowledgeApi>;
export const githubSourceKeys = ['integrations', 'github-personal', 'content', 'knowledge-sources'];
export const githubConcealKeys = [githubSourceKeys];
