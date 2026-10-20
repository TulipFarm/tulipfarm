import { z } from 'zod';
import { type GitHubWrite, GitHubBatchError } from './batch-contracts.ts';

export type PullWrite = Extract<GitHubWrite, { kind: `pull.${string}` }>;
export const isPullWrite = (operation: GitHubWrite): operation is PullWrite => operation.kind.startsWith('pull.');
export const pullPath = (operation: PullWrite) =>
  `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}/pulls${'pullNumber' in operation ? `/${operation.pullNumber}` : ''}`;

export function pullRequest(operation: PullWrite) {
  const path = pullPath(operation);
  switch (operation.kind) {
    case 'pull.create':
      return {
        path,
        method: 'POST',
        body: {
          title: operation.title,
          body: operation.body,
          head: operation.head,
          base: operation.base,
          draft: operation.draft,
        },
      };
    case 'pull.create-fork':
      return {
        path,
        method: 'POST',
        body: {
          title: operation.title,
          body: operation.body,
          head: `${operation.headOwner}:${operation.head}`,
          head_repo: operation.headRepo,
          base: operation.base,
          draft: operation.draft,
          maintainer_can_modify: false,
        },
      };
    case 'pull.update':
      return { path, method: 'PATCH', body: { title: operation.title, body: operation.body, base: operation.base } };
    case 'pull.close':
    case 'pull.reopen':
      return { path, method: 'PATCH', body: { state: operation.kind === 'pull.close' ? 'closed' : 'open' } };
    case 'pull.comment':
      return {
        path: `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}/issues/${operation.pullNumber}/comments`,
        method: 'POST',
        body: { body: operation.body },
      };
    case 'pull.review':
      return {
        path: `${path}/reviews`,
        method: 'POST',
        body: { body: operation.body, commit_id: operation.headSha, event: operation.event },
      };
    case 'pull.request-reviewers':
      return {
        path: `${path}/requested_reviewers`,
        method: 'POST',
        body: { reviewers: operation.reviewers, team_reviewers: operation.teamReviewers },
      };
    case 'pull.merge':
      return {
        path: `${path}/merge`,
        method: 'PUT',
        body: {
          sha: operation.headSha,
          merge_method: operation.mergeMethod,
          commit_title: operation.commitTitle,
          commit_message: operation.commitMessage,
        },
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export function pullMcpArguments(operation: PullWrite) {
  const repository = { owner: operation.owner, repo: operation.repo };
  if (operation.kind === 'pull.create' || operation.kind === 'pull.create-fork')
    return { ...repository, ...pullRequest(operation).body };
  const target = { ...repository, pullNumber: operation.pullNumber };
  switch (operation.kind) {
    case 'pull.update':
    case 'pull.close':
    case 'pull.reopen':
      return { ...target, ...pullRequest(operation).body };
    case 'pull.comment':
      return { ...repository, issue_number: operation.pullNumber, body: operation.body };
    case 'pull.review':
      return { ...target, method: 'create', body: operation.body, commitID: operation.headSha, event: operation.event };
    case 'pull.request-reviewers':
      return {
        ...target,
        reviewers: [...operation.reviewers, ...operation.teamReviewers.map(team => `${operation.owner}/${team}`)],
      };
    case 'pull.merge':
      return {
        ...target,
        expectedHeadSha: operation.headSha,
        merge_method: operation.mergeMethod,
        commit_title: operation.commitTitle,
        commit_message: operation.commitMessage,
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export const pullIdentitySchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  base: z.object({ ref: z.string(), repo: z.object({ id: z.number().int().positive() }) }),
  head: z.object({ sha: z.string(), ref: z.string() }),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  draft: z.boolean(),
});
export function checkPullIdentity(
  operation: Exclude<PullWrite, { kind: 'pull.create' | 'pull.create-fork' }>,
  value: unknown,
  dispatch: boolean,
) {
  const pull = pullIdentitySchema.parse(value);
  if (
    pull.id !== operation.pullRequestId ||
    pull.number !== operation.pullNumber ||
    pull.base.repo.id !== operation.repositoryId
  )
    throw new GitHubBatchError('batch-conflict');
  if (!dispatch) return;
  if ('headSha' in operation && pull.head.sha !== operation.headSha) throw new GitHubBatchError('batch-conflict');
  if (
    operation.kind === 'pull.merge' &&
    (pull.base.ref !== operation.base || pull.state !== 'open' || pull.merged || pull.draft)
  )
    throw new GitHubBatchError('batch-conflict');
}

export const mergeResultSchema = z.object({ merged: z.literal(true), sha: z.string().regex(/^[a-f0-9]{40}$/) });
export function pullResult(operation: PullWrite, value: unknown) {
  if (operation.kind === 'pull.merge') return mergeResultSchema.parse(value);
  if (operation.kind === 'pull.create-fork')
    z.object({
      head: z.object({
        sha: z.literal(operation.headSha),
        ref: z.literal(operation.head),
        repo: z.object({
          id: z.literal(operation.headRepositoryId),
          full_name: z
            .string()
            .refine(name => name.toLowerCase() === `${operation.headOwner}/${operation.headRepo}`.toLowerCase()),
        }),
      }),
      base: z.object({ ref: z.literal(operation.base), repo: z.object({ id: z.literal(operation.repositoryId) }) }),
    }).parse(value);
  return z.object({ id: z.number().int().positive(), number: z.number().int().positive().optional() }).parse(value);
}

export function pullRecoveryPath(operation: PullWrite) {
  const path = pullPath(operation);
  switch (operation.kind) {
    case 'pull.create':
    case 'pull.create-fork':
      return `${path}?state=all&sort=created&direction=desc&per_page=100`;
    case 'pull.comment':
      return `${pullRequest(operation).path}?per_page=100`;
    case 'pull.review':
      return `${path}/reviews?per_page=100`;
    default:
      return path;
  }
}
export function recoverPull(operation: PullWrite, value: unknown, marker: string, actorId: string) {
  if (
    operation.kind !== 'pull.create' &&
    operation.kind !== 'pull.create-fork' &&
    operation.kind !== 'pull.comment' &&
    operation.kind !== 'pull.review'
  )
    return null;
  const candidates = z
    .array(
      z.object({
        id: z.number().int().positive(),
        number: z.number().int().positive().optional(),
        body: z.string().nullable(),
        user: z.object({ id: z.number() }),
        title: z.string().optional(),
        head: z
          .object({
            ref: z.string(),
            sha: z.string().optional(),
            repo: z.object({ id: z.number(), full_name: z.string() }).optional(),
          })
          .optional(),
        base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }).optional(),
        commit_id: z.string().optional(),
        state: z.string().optional(),
      }),
    )
    .parse(value);
  const matches = candidates.filter(
    item =>
      item.body === operation.body &&
      item.body.includes(marker) &&
      String(item.user.id) === actorId &&
      (operation.kind !== 'pull.create' ||
        (item.title === operation.title &&
          item.head?.ref === operation.head &&
          item.base?.ref === operation.base &&
          item.base.repo.id === operation.repositoryId)) &&
      (operation.kind !== 'pull.create-fork' ||
        (item.title === operation.title &&
          item.head?.ref === operation.head &&
          item.head.sha === operation.headSha &&
          item.head.repo?.id === operation.headRepositoryId &&
          item.head.repo.full_name.toLowerCase() === `${operation.headOwner}/${operation.headRepo}`.toLowerCase() &&
          item.base?.ref === operation.base &&
          item.base.repo.id === operation.repositoryId)) &&
      (operation.kind !== 'pull.review' ||
        (item.commit_id === operation.headSha &&
          item.state ===
            { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[operation.event])),
  );
  return matches.length === 1 ? pullResult(operation, matches[0]) : null;
}
