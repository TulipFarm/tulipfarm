import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createMcpSession } from '@tulipfarm/provider-mcp';
import { GitHubCredentialRejected, type GitHubCredential } from './accounts.ts';
import { type GitHubWrite, GitHubBatchError } from './batch-contracts.ts';
import {
  checkPullIdentity,
  isPullWrite,
  pullMcpArguments,
  pullPath,
  pullRecoveryPath,
  pullRequest,
  pullResult,
  recoverPull,
} from './pull-writes.ts';
import { mcpWriteResult, writeSuccessStatus } from './write-results.ts';
import {
  branchPath,
  checkRepositoryTarget,
  isRepositoryWrite,
  repositoryPath,
  repositoryRequest,
  repositoryResult,
} from './repository-writes.ts';
import {
  checkFileTarget,
  contentsResult,
  fileCandidateSchema,
  fileChanges,
  fileReceipt,
  fileRequest,
  fileTree,
  isFileWrite,
  type FileWrite,
} from './file-writes.ts';
import { decodeFileContent } from './file-contracts.ts';
import {
  checkReleaseTarget,
  isReleaseWrite,
  recoverRelease,
  releasePath,
  releaseRequest,
  releaseResult,
  releaseUploadBytes,
} from './release-writes.ts';
import {
  actionsApiVersion,
  actionsMcpArguments,
  actionsPath,
  actionsRequest,
  actionsResult,
  checkActionsTarget,
  isActionsWrite,
} from './actions-writes.ts';
import {
  checkDiscussionTarget,
  discussionMcpArguments,
  discussionRequest,
  discussionResult,
  isDiscussionWrite,
  recoverDiscussion,
} from './discussion-writes.ts';
import { checkProjectTarget, projectRequest, projectResult, isProjectWrite, recoverProject } from './project-writes.ts';

const writeTools = {
  'project.create': null,
  'project.update': null,
  'project.close': null,
  'project.reopen': null,
  'project.delete': null,
  'project.field-create': null,
  'project.field-update': null,
  'project.field-delete': null,
  'project.item-add': null,
  'project.draft-create': null,
  'project.draft-update': null,
  'project.item-archive': null,
  'project.item-unarchive': null,
  'project.item-delete': null,
  'project.value-set': null,
  'project.value-clear': null,
  'discussion.create': null,
  'discussion.update': null,
  'discussion.delete': null,
  'discussion.comment-create': null,
  'discussion.comment-update': 'discussion_comment_write',
  'discussion.comment-delete': 'discussion_comment_write',
  'discussion.answer-mark': 'discussion_comment_write',
  'discussion.answer-unmark': 'discussion_comment_write',
  'actions.dispatch': null,
  'actions.rerun': 'actions_run_trigger',
  'actions.cancel': 'actions_run_trigger',
  'actions.artifact-delete': null,
  'release.create': null,
  'release.update': null,
  'release.publish': null,
  'release.delete': null,
  'release.asset-upload': null,
  'release.asset-update': null,
  'release.asset-delete': null,
  'file.create': null,
  'file.update': null,
  'file.delete': null,
  'files.commit': null,
  'pull.create-fork': null,
  'repository.create': 'create_repository',
  'repository.settings': null,
  'repository.rename': null,
  'repository.archive': null,
  'repository.delete': null,
  'branch.create': null,
  'branch.delete': null,
  'issue.create': 'issue_write',
  'issue.update': 'issue_write',
  'issue.comment': 'add_issue_comment',
  'issue.close': 'issue_write',
  'issue.reopen': 'issue_write',
  'pull.create': 'create_pull_request',
  'pull.update': 'update_pull_request',
  'pull.comment': 'add_issue_comment',
  'pull.close': 'update_pull_request',
  'pull.reopen': 'update_pull_request',
  'pull.review': 'pull_request_review_write',
  'pull.request-reviewers': 'request_pull_request_reviewers',
  'pull.merge': 'merge_pull_request',
} satisfies Record<GitHubWrite['kind'], string | null>;
export const writeBindingsSchema = z
  .array(
    z.strictObject({
      operation: z.enum([
        'discussion.comment-update',
        'discussion.comment-delete',
        'discussion.answer-mark',
        'discussion.answer-unmark',
        'actions.rerun',
        'actions.cancel',
        'repository.create',
        'issue.create',
        'issue.update',
        'issue.comment',
        'issue.close',
        'issue.reopen',
        'pull.create',
        'pull.update',
        'pull.comment',
        'pull.review',
        'pull.request-reviewers',
        'pull.close',
        'pull.reopen',
        'pull.merge',
      ]),
      name: z.string(),
      contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .max(20)
  .superRefine((bindings, ctx) => {
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (seen.has(binding.operation) || binding.name !== writeTools[binding.operation])
        ctx.addIssue({ code: 'custom', message: 'Invalid reviewed GitHub write binding' });
      seen.add(binding.operation);
    }
  });
export type WriteBinding = z.infer<typeof writeBindingsSchema>[number];
export function githubWriteBindings(env: NodeJS.ProcessEnv = process.env) {
  try {
    return writeBindingsSchema.parse(JSON.parse(env.GITHUB_MCP_WRITE_BINDINGS ?? '[]'));
  } catch {
    throw new Error('Invalid GitHub reviewed write bindings');
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const batchDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const writeConfiguration = (bindings: readonly WriteBinding[]) =>
  batchDigest({
    version: 1,
    rest: '2022-11-28',
    actionsRest: actionsApiVersion,
    bindings: [...bindings].sort((a, b) => a.operation.localeCompare(b.operation)),
  });
export function issueRequest(operation: GitHubWrite) {
  if (isProjectWrite(operation)) return projectRequest(operation);
  if (isDiscussionWrite(operation)) return discussionRequest(operation);
  if (isActionsWrite(operation)) return actionsRequest(operation);
  if (isReleaseWrite(operation)) return releaseRequest(operation);
  if (isFileWrite(operation)) return fileRequest(operation);
  if (isRepositoryWrite(operation)) return repositoryRequest(operation);
  if (isPullWrite(operation)) return pullRequest(operation);
  const base = `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}/issues`;
  switch (operation.kind) {
    case 'issue.create':
      return { path: base, method: 'POST', body: { title: operation.title, body: operation.body } };
    case 'issue.update':
      return {
        path: `${base}/${operation.issueNumber}`,
        method: 'PATCH',
        body: { title: operation.title, body: operation.body },
      };
    case 'issue.comment':
      return { path: `${base}/${operation.issueNumber}/comments`, method: 'POST', body: { body: operation.body } };
    case 'issue.close':
    case 'issue.reopen':
      return {
        path: `${base}/${operation.issueNumber}`,
        method: 'PATCH',
        body: { state: operation.kind === 'issue.close' ? 'closed' : 'open' },
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
export async function providerJson(response: Response, token: string, allowEmpty = false) {
  if (!response.body) {
    if (allowEmpty) return null;
    throw new GitHubBatchError('batch-unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 131072) throw new GitHubBatchError('batch-unavailable');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (allowEmpty && !text.trim()) return null;
  const value = z.json().parse(JSON.parse(text));
  if (
    [token, Buffer.from(token).toString('base64'), Buffer.from(token).toString('base64url')].some(
      secret => text.includes(secret) || JSON.stringify(value).includes(secret),
    )
  )
    throw new GitHubBatchError('batch-unavailable');
  return value;
}
export function githubHeaders(credential: GitHubCredential) {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'TulipFarm',
  };
}
export type WriteOutcome =
  | { status: 'succeeded'; result: z.infer<ReturnType<typeof z.json>> }
  | { status: 'rejected' | 'unknown'; result: null };
export async function requireWriteTarget(
  operation: GitHubWrite,
  credential: GitHubCredential,
  fetcher: typeof fetch,
  dispatch = false,
) {
  if (isProjectWrite(operation))
    return checkProjectTarget(operation, credential, projectReader(credential, fetcher), dispatch);
  if (isDiscussionWrite(operation))
    return checkDiscussionTarget(
      operation,
      credential,
      async (query, variables) => {
        const response = await fetcher('https://api.github.com/graphql', {
          method: 'POST',
          body: JSON.stringify({ query, variables }),
          headers: githubHeaders(credential),
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        if (response.status === 401) {
          await response.body?.cancel();
          throw new GitHubCredentialRejected();
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new GitHubBatchError('batch-unavailable');
        }
        return providerJson(response, credential.accessToken);
      },
      dispatch,
    );
  const base = `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}`;
  if (
    isActionsWrite(operation) ||
    isPullWrite(operation) ||
    isRepositoryWrite(operation) ||
    isFileWrite(operation) ||
    isReleaseWrite(operation)
  ) {
    const read = async (path: string) => {
      const response = await fetcher(`https://api.github.com${path}`, {
        method: 'GET',
        headers: {
          ...githubHeaders(credential),
          ...(isActionsWrite(operation) ? { 'X-GitHub-Api-Version': actionsApiVersion } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new GitHubCredentialRejected();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubBatchError('batch-unavailable');
      }
      return providerJson(response, credential.accessToken);
    };
    if (isActionsWrite(operation)) return checkActionsTarget(operation, credential, read, dispatch);
    if (isReleaseWrite(operation)) return checkReleaseTarget(operation, credential, read, dispatch);
    if (isRepositoryWrite(operation)) return checkRepositoryTarget(operation, credential, read, dispatch);
    if (isFileWrite(operation)) {
      await checkFileTarget(operation, credential, read, dispatch);
      return;
    }
    const repository = z
      .object({
        id: z.number().int().positive(),
        full_name: z.string(),
        archived: z.boolean(),
        permissions: z.object({ push: z.boolean() }),
      })
      .parse(await read(base));
    if (
      repository.id !== operation.repositoryId ||
      repository.full_name.toLowerCase() !== `${operation.owner}/${operation.repo}`.toLowerCase()
    )
      throw new GitHubBatchError('batch-conflict');
    if (dispatch && (repository.archived || (operation.kind === 'pull.merge' && !repository.permissions.push)))
      throw new GitHubBatchError('batch-conflict');
    if (operation.kind === 'pull.create-fork') {
      const headTarget = { owner: operation.headOwner, repo: operation.headRepo, branch: operation.head };
      const head = z
        .object({
          id: z.number(),
          full_name: z.string(),
          archived: z.boolean(),
          permissions: z.object({ push: z.boolean() }),
          source: z.object({ id: z.number() }).optional(),
          parent: z.object({ id: z.number() }).optional(),
        })
        .parse(await read(repositoryPath(headTarget)));
      if (
        head.id !== operation.headRepositoryId ||
        head.full_name.toLowerCase() !== `${operation.headOwner}/${operation.headRepo}`.toLowerCase()
      )
        throw new GitHubBatchError('batch-conflict');
      if (dispatch) {
        if (
          head.archived ||
          !head.permissions.push ||
          (head.parent?.id !== operation.repositoryId && head.source?.id !== operation.repositoryId)
        )
          throw new GitHubBatchError('batch-conflict');
        const ref = z.object({
          ref: z.literal(`refs/heads/${operation.head}`),
          object: z.object({ type: z.literal('commit'), sha: z.literal(operation.headSha) }),
        });
        if (!ref.safeParse(await read(branchPath(headTarget))).success) throw new GitHubBatchError('batch-conflict');
        await read(branchPath({ ...operation, branch: operation.base }));
      }
    } else if (operation.kind !== 'pull.create')
      checkPullIdentity(operation, await read(pullPath(operation)), dispatch);
    return;
  }
  const response = await fetcher(
    `https://api.github.com${base}${'issueNumber' in operation ? `/issues/${operation.issueNumber}` : ''}`,
    { method: 'GET', headers: githubHeaders(credential), redirect: 'error', signal: AbortSignal.timeout(10000) },
  );
  if (response.status === 401) throw new GitHubCredentialRejected();
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubBatchError('batch-unavailable');
  }
  const result = z
    .object({ id: z.number().int().positive(), pull_request: z.unknown().optional() })
    .parse(await providerJson(response, credential.accessToken));
  if (result.pull_request !== undefined) throw new GitHubBatchError('batch-conflict');
}
export async function dispatchGitHubWrite(input: {
  operation: GitHubWrite;
  credential: GitHubCredential;
  bindings: readonly WriteBinding[];
  fetcher: typeof fetch;
  authorize: () => Promise<boolean>;
  preparedFile?: z.infer<typeof fileCandidateSchema>;
  beforeVisibleWrite?: (candidate: z.infer<typeof fileCandidateSchema> | null) => Promise<void>;
}): Promise<WriteOutcome> {
  const { operation, credential, fetcher } = input;
  if (isFileWrite(operation)) return dispatchFileWrite({ ...input, operation });
  const binding = input.bindings.find(item => item.operation === operation.kind);
  if (binding) {
    if (isProjectWrite(operation)) throw new GitHubBatchError('batch-unavailable');
    const { kind: _kind, ...args } = operation;
    const request = issueRequest(operation);
    const session = createMcpSession({
      endpoint: 'https://api.githubcopilot.com/mcp/',
      clientName: 'tulipfarm-github',
      token: credential.accessToken,
      timeoutMs: 10000,
      bindings: [binding],
      fetcher,
      authorize: input.authorize,
      error: () => new GitHubBatchError('batch-unavailable'),
      knownError: () => null,
      isDefiniteRejection: () => false,
      result: value => {
        const text = JSON.stringify(value);
        if (
          Buffer.byteLength(text) > 131072 ||
          [
            credential.accessToken,
            Buffer.from(credential.accessToken).toString('base64'),
            Buffer.from(credential.accessToken).toString('base64url'),
          ].some(secret => text.includes(secret))
        )
          throw new GitHubBatchError('batch-unavailable');
        return z.json().parse(mcpWriteResult(operation, value));
      },
    });
    try {
      await session.discover();
      const parameters = isDiscussionWrite(operation)
        ? discussionMcpArguments(operation)
        : operation.kind === 'actions.rerun' || operation.kind === 'actions.cancel'
          ? actionsMcpArguments(operation)
          : operation.kind === 'repository.create'
            ? {
                name: operation.repo,
                description: operation.description,
                private: operation.private,
                autoInit: operation.autoInit,
                ...(operation.ownerType === 'organization' ? { organization: operation.owner } : {}),
              }
            : isPullWrite(operation)
              ? pullMcpArguments(operation)
              : operation.kind === 'issue.comment'
                ? {
                    owner: operation.owner,
                    repo: operation.repo,
                    issue_number: operation.issueNumber,
                    body: operation.body,
                  }
                : {
                    owner: args.owner,
                    repo: args.repo,
                    ...request.body,
                    method: operation.kind === 'issue.create' ? 'create' : 'update',
                    ...('issueNumber' in operation ? { issue_number: operation.issueNumber } : {}),
                  };
      const result = await session.execute(binding.operation, parameters);
      return { status: 'succeeded', result };
    } catch {
      return { status: 'unknown', result: null };
    } finally {
      await session.close();
    }
  }
  const request = issueRequest(operation);
  if (!(await input.authorize())) return { status: 'rejected', result: null };
  const upload = operation.kind === 'release.asset-upload' ? releaseUploadBytes(operation) : null;
  const response = await fetcher(`https://${upload ? 'uploads' : 'api'}.github.com${request.path}`, {
    method: request.method,
    body: upload ?? JSON.stringify(request.body),
    headers: {
      ...githubHeaders(credential),
      ...(isActionsWrite(operation) ? { 'X-GitHub-Api-Version': actionsApiVersion } : {}),
      ...(operation.kind === 'release.asset-upload'
        ? { 'Content-Type': operation.contentType, 'Content-Length': String(operation.size) }
        : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new GitHubCredentialRejected();
  }
  if ([403, 404, 405, 409, 410, 422].includes(response.status)) {
    await response.body?.cancel();
    return { status: 'rejected', result: null };
  }
  if (response.status !== writeSuccessStatus[operation.kind]) {
    await response.body?.cancel();
    return { status: 'unknown', result: null };
  }
  const value =
    response.status === 204
      ? null
      : await providerJson(
          response,
          credential.accessToken,
          operation.kind === 'actions.rerun' || operation.kind === 'actions.cancel',
        );
  if (operation.kind === 'pull.merge' && z.object({ merged: z.literal(false) }).safeParse(value).success)
    return { status: 'rejected', result: null };
  const result = isProjectWrite(operation)
    ? projectResult(operation, value)
    : isDiscussionWrite(operation)
      ? discussionResult(operation, value)
      : isActionsWrite(operation)
        ? actionsResult(operation, value)
        : isReleaseWrite(operation)
          ? releaseResult(operation, value)
          : isRepositoryWrite(operation)
            ? repositoryResult(operation, value)
            : isPullWrite(operation)
              ? pullResult(operation, value)
              : z
                  .object({ id: z.number().int().positive(), number: z.number().int().positive().optional() })
                  .parse(value);
  return { status: 'succeeded', result: z.json().parse(result) };
}

export async function reconcileGitHubWrite(input: {
  operation: GitHubWrite;
  credential: GitHubCredential;
  fetcher: typeof fetch;
  marker: string;
  previousEvidence?: unknown;
}) {
  const { operation, credential } = input;
  if (isProjectWrite(operation)) {
    const result = await recoverProject(operation, credential, input.marker, projectReader(credential, input.fetcher));
    return {
      result,
      evidence: {
        checkedAt: new Date().toISOString(),
        provider: 'github',
        outcome: result ? 'confirmed-original-success' : 'unresolved',
      },
    };
  }
  if (isDiscussionWrite(operation)) {
    await requireWriteTarget(operation, credential, input.fetcher);
    const result = await recoverDiscussion(operation, credential, input.marker, async (query, variables) => {
      const response = await input.fetcher('https://api.github.com/graphql', {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
        headers: githubHeaders(credential),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new GitHubCredentialRejected();
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new GitHubBatchError('batch-unavailable');
      }
      return providerJson(response, credential.accessToken);
    });
    return {
      result,
      evidence: {
        checkedAt: new Date().toISOString(),
        provider: 'github',
        outcome: result ? 'confirmed-original-success' : 'unresolved',
      },
    };
  }
  if (isActionsWrite(operation)) {
    await requireWriteTarget(operation, credential, input.fetcher);
    const path =
      actionsPath(operation) +
      (operation.kind === 'actions.dispatch' ? '/runs?event=workflow_dispatch&per_page=30' : '');
    const response = await input.fetcher(`https://api.github.com${path}`, {
      method: 'GET',
      headers: { ...githubHeaders(credential), 'X-GitHub-Api-Version': actionsApiVersion },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    const status = response.status;
    const value = status === 200 ? await providerJson(response, credential.accessToken) : null;
    if (status !== 200) await response.body?.cancel();
    return {
      result: null,
      evidence: {
        checkedAt: new Date().toISOString(),
        provider: 'github',
        status,
        responseDigest: batchDigest(value),
        outcome: 'unresolved',
      },
    };
  }
  if (isFileWrite(operation)) return reconcileFileWrite({ ...input, operation });
  if (isReleaseWrite(operation)) {
    const path = releasePath(operation) + (operation.kind === 'release.create' ? '?per_page=30' : '');
    const response = await input.fetcher(`https://api.github.com${path}`, {
      method: 'GET',
      headers: githubHeaders(credential),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    const status = response.status;
    const value = status === 200 ? await providerJson(response, credential.accessToken) : null;
    if (status !== 200) await response.body?.cancel();
    const result = status === 200 ? recoverRelease(operation, value, input.marker, credential.identity.id) : null;
    return {
      result,
      evidence: {
        checkedAt: new Date().toISOString(),
        provider: 'github',
        status,
        responseDigest: batchDigest(value),
        outcome: result ? 'confirmed-original-success' : 'unresolved',
      },
    };
  }
  if (isRepositoryWrite(operation)) {
    const path =
      operation.kind === 'repository.create'
        ? repositoryPath(operation)
        : operation.kind === 'branch.create' || operation.kind === 'branch.delete'
          ? branchPath(operation)
          : `/repositories/${operation.repositoryId}`;
    const response = await input.fetcher(`https://api.github.com${path}`, {
      method: 'GET',
      headers: githubHeaders(credential),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    const status = response.status;
    const value = status === 200 ? await providerJson(response, credential.accessToken) : null;
    if (status !== 200) await response.body?.cancel();
    return {
      result: null,
      evidence: {
        checkedAt: new Date().toISOString(),
        provider: 'github',
        status,
        responseDigest: batchDigest(value),
        outcome: 'unresolved',
      },
    };
  }
  const request = issueRequest(operation);
  const path = isPullWrite(operation)
    ? pullRecoveryPath(operation)
    : operation.kind === 'issue.create'
      ? `${request.path}?state=all&sort=created&direction=desc&per_page=100`
      : operation.kind === 'issue.comment'
        ? `${request.path}?per_page=100`
        : request.path;
  const response = await input.fetcher(`https://api.github.com${path}`, {
    method: 'GET',
    headers: githubHeaders(credential),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401) throw new GitHubCredentialRejected();
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubBatchError('batch-unavailable');
  }
  const result = await providerJson(response, credential.accessToken);
  const evidence = {
    checkedAt: new Date().toISOString(),
    provider: 'github',
    responseDigest: batchDigest(result),
    outcome: 'unresolved',
  };
  if (isPullWrite(operation)) {
    const recovered = recoverPull(operation, result, input.marker, credential.identity.id);
    return {
      result: recovered,
      evidence: { ...evidence, outcome: recovered ? 'confirmed-original-success' : 'unresolved' },
    };
  }
  if (operation.kind !== 'issue.create' && operation.kind !== 'issue.comment') return { result: null, evidence };
  const matches = z
    .array(
      z
        .object({
          id: z.number().int().positive(),
          body: z.string().nullable(),
          user: z.object({ id: z.number() }),
          title: z.string().optional(),
        })
        .passthrough(),
    )
    .parse(result)
    .filter(
      item =>
        item.body === operation.body &&
        item.body.includes(input.marker) &&
        String(item.user.id) === credential.identity.id &&
        (operation.kind !== 'issue.create' || item.title === operation.title),
    );
  if (matches.length !== 1) return { result: null, evidence };
  return {
    result: z
      .json()
      .parse(
        z.object({ id: z.number().int().positive(), number: z.number().int().positive().optional() }).parse(matches[0]),
      ),
    evidence: { ...evidence, outcome: 'confirmed-original-success' },
  };
}

export function projectReader(credential: GitHubCredential, fetcher: typeof fetch) {
  return async (query: string, variables: Record<string, string>) => {
    const response = await fetcher('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: githubHeaders(credential),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new GitHubBatchError('batch-unavailable');
    }
    return providerJson(response, credential.accessToken);
  };
}
function fileReader(credential: GitHubCredential, fetcher: typeof fetch) {
  return async (path: string) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      method: 'GET',
      headers: githubHeaders(credential),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new GitHubBatchError('batch-unavailable');
    }
    return providerJson(response, credential.accessToken);
  };
}
export async function prepareFileCommit(input: {
  operation: Extract<FileWrite, { kind: 'files.commit' }>;
  credential: GitHubCredential;
  fetcher: typeof fetch;
  authorize: () => Promise<boolean>;
}) {
  const { operation, credential, fetcher } = input;
  const read = fileReader(credential, fetcher);
  const repository = await checkFileTarget(operation, credential, read, true);
  const base = await fileTree(operation, read);
  const send = async (path: string, method: string, body: unknown) => {
    if (!(await input.authorize())) throw new GitHubBatchError('batch-conflict');
    return fetcher(`https://api.github.com${path}`, {
      method,
      body: JSON.stringify(body),
      headers: githubHeaders(credential),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  };
  const prepare = async (path: string, body: unknown) => {
    const response = await send(path, 'POST', body);
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubCredentialRejected();
    }
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new GitHubBatchError('batch-unavailable');
    }
    return z
      .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
      .parse(await providerJson(response, credential.accessToken)).sha;
  };
  const treeSha = await prepare(`${repositoryPath(operation)}/git/trees`, {
    base_tree: base.treeSha,
    tree: fileChanges(operation).map(file => ({
      path: file.path,
      mode: base.entries.get(file.path)?.mode ?? '100644',
      type: 'blob',
      ...(file.kind === 'delete' ? { sha: null } : { content: decodeFileContent(file) }),
    })),
  });
  const commitSha = await prepare(`${repositoryPath(operation)}/git/commits`, {
    message: operation.message,
    tree: treeSha,
    parents: [operation.headSha],
  });
  return fileCandidateSchema.parse({
    phase: 'ref-dispatch',
    commitSha,
    treeSha,
    defaultBranch: repository.default_branch,
  });
}
async function dispatchFileWrite(input: {
  operation: FileWrite;
  credential: GitHubCredential;
  fetcher: typeof fetch;
  authorize: () => Promise<boolean>;
  preparedFile?: z.infer<typeof fileCandidateSchema>;
  beforeVisibleWrite?: (candidate: z.infer<typeof fileCandidateSchema> | null) => Promise<void>;
}): Promise<WriteOutcome> {
  const { operation, credential, fetcher } = input;
  const read = fileReader(credential, fetcher);
  const repository = await checkFileTarget(operation, credential, read, true);
  const candidate =
    operation.kind === 'files.commit'
      ? (input.preparedFile ?? (await prepareFileCommit({ ...input, operation })))
      : null;
  if (operation.kind !== 'files.commit') await fileTree(operation, read);
  const request =
    operation.kind === 'files.commit' && candidate
      ? {
          path: `${repositoryPath(operation)}/git/refs/heads/${encodeURIComponent(operation.branch)}`,
          method: 'PATCH',
          body: { sha: candidate.commitSha, force: false },
        }
      : fileRequest(operation);
  await checkFileTarget(operation, credential, read, true);
  if (!(await input.authorize())) return { status: 'rejected', result: null };
  await input.beforeVisibleWrite?.(candidate);
  const response = await fetcher(`https://api.github.com${request.path}`, {
    method: request.method,
    body: JSON.stringify(request.body),
    headers: githubHeaders(credential),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new GitHubCredentialRejected();
  }
  if ([403, 404, 405, 409, 410, 422].includes(response.status)) {
    await response.body?.cancel();
    return { status: 'rejected', result: null };
  }
  if (response.status !== writeSuccessStatus[operation.kind]) {
    await response.body?.cancel();
    return { status: 'unknown', result: null };
  }
  const value = await providerJson(response, credential.accessToken);
  if (operation.kind !== 'files.commit')
    return { status: 'succeeded', result: contentsResult(operation, value, repository.default_branch) };
  if (!candidate) throw new GitHubBatchError('batch-unavailable');
  z.object({
    ref: z.literal(`refs/heads/${operation.branch}`),
    object: z.object({ type: z.literal('commit'), sha: z.literal(candidate.commitSha) }),
  }).parse(value);
  return { status: 'succeeded', result: fileReceipt(operation, candidate.commitSha, candidate.defaultBranch) };
}

async function reconcileFileWrite(input: {
  operation: FileWrite;
  credential: GitHubCredential;
  fetcher: typeof fetch;
  marker: string;
  previousEvidence?: unknown;
}) {
  const { operation, credential, fetcher } = input;
  const read = fileReader(credential, fetcher);
  const repository = await checkFileTarget(operation, credential, read, false);
  const saved = fileCandidateSchema.safeParse(input.previousEvidence);
  const evidence = {
    ...(saved.success ? saved.data : {}),
    checkedAt: new Date().toISOString(),
    provider: 'github',
    outcome: 'unresolved',
  };
  const reference = z
    .object({
      ref: z.literal(`refs/heads/${operation.branch}`),
      object: z.object({ type: z.literal('commit'), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
    })
    .parse(await read(branchPath(operation)));
  let commitSha: string;
  if (operation.kind === 'files.commit') {
    if (!saved.success) return { result: null, evidence };
    commitSha = saved.data.commitSha;
  } else {
    const list = z
      .array(
        z.object({
          sha: z.string().regex(/^[a-f0-9]{40}$/),
          commit: z.object({ message: z.string() }),
          author: z.object({ id: z.number() }).nullable(),
          parents: z.array(z.object({ sha: z.string() })),
        }),
      )
      .parse(await read(`${repositoryPath(operation)}/commits?sha=${reference.object.sha}&per_page=20`));
    const matches = list.filter(
      item =>
        input.marker &&
        item.commit.message === operation.message &&
        item.commit.message.includes(input.marker) &&
        String(item.author?.id) === credential.identity.id &&
        item.parents.length === 1 &&
        item.parents[0]?.sha === operation.headSha,
    );
    if (matches.length !== 1 || !matches[0]) return { result: null, evidence };
    commitSha = matches[0].sha;
  }
  const commit = z
    .object({
      sha: z.literal(commitSha),
      message: z.literal(operation.message),
      parents: z.tuple([z.object({ sha: z.literal(operation.headSha) })]),
      tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
    })
    .parse(await read(`${repositoryPath(operation)}/git/commits/${commitSha}`));
  if (saved.success && commit.tree.sha !== saved.data.treeSha) return { result: null, evidence };
  if (operation.kind !== 'files.commit') {
    const detail = z
      .object({
        sha: z.literal(commitSha),
        files: z.tuple([
          z.object({
            filename: z.literal(operation.path),
            status: z.enum(['added', 'modified', 'removed']),
            sha: z.string(),
          }),
        ]),
      })
      .parse(await read(`${repositoryPath(operation)}/commits/${commitSha}`));
    const expected =
      operation.kind === 'file.delete'
        ? operation.blobSha
        : createHash('sha1')
            .update(`blob ${Buffer.byteLength(decodeFileContent(operation))}\0`)
            .update(decodeFileContent(operation))
            .digest('hex');
    if (
      detail.files[0].sha !== expected ||
      detail.files[0].status !==
        { 'file.create': 'added', 'file.update': 'modified', 'file.delete': 'removed' }[operation.kind]
    )
      return { result: null, evidence };
  }
  if (reference.object.sha !== commitSha) {
    const comparison = z
      .object({
        status: z.string(),
        merge_base_commit: z.object({ sha: z.string() }),
        base_commit: z.object({ sha: z.string() }),
      })
      .parse(await read(`${repositoryPath(operation)}/compare/${commitSha}...${reference.object.sha}`));
    if (
      comparison.status !== 'ahead' ||
      comparison.merge_base_commit.sha !== commitSha ||
      comparison.base_commit.sha !== commitSha
    )
      return { result: null, evidence };
  }
  return {
    result: fileReceipt(operation, commitSha, saved.success ? saved.data.defaultBranch : repository.default_branch),
    evidence: { ...evidence, commitSha, observedHead: reference.object.sha, outcome: 'confirmed-original-success' },
  };
}
