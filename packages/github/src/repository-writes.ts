import { z } from 'zod';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import type { GitHubCredential } from './accounts.ts';

export type RepositoryWrite = Extract<GitHubWrite, { kind: `repository.${string}` | `branch.${string}` }>;
export function isRepositoryWrite(operation: GitHubWrite): operation is RepositoryWrite {
  return operation.kind.startsWith('repository.') || operation.kind.startsWith('branch.');
}
export const repositoryPath = (operation: { owner: string; repo: string }) =>
  `/repos/${encodeURIComponent(operation.owner)}/${encodeURIComponent(operation.repo)}`;
export const branchPath = (operation: { owner: string; repo: string; branch: string }) =>
  `${repositoryPath(operation)}/git/ref/heads/${encodeURIComponent(operation.branch)}`;
export function repositoryRequest(operation: RepositoryWrite) {
  const path = repositoryPath(operation);
  switch (operation.kind) {
    case 'repository.create':
      return {
        path: operation.ownerType === 'user' ? '/user/repos' : `/orgs/${encodeURIComponent(operation.owner)}/repos`,
        method: 'POST',
        body: {
          name: operation.repo,
          description: operation.description,
          private: operation.private,
          auto_init: operation.autoInit,
        },
      };
    case 'repository.settings':
      return {
        path,
        method: 'PATCH',
        body: {
          description: operation.description,
          private: operation.private,
          has_issues: operation.hasIssues,
          has_wiki: operation.hasWiki,
          default_branch: operation.defaultBranch,
        },
      };
    case 'repository.rename':
      return { path, method: 'PATCH', body: { name: operation.name } };
    case 'repository.archive':
      return { path, method: 'PATCH', body: { archived: operation.archived } };
    case 'repository.delete':
      return { path, method: 'DELETE', body: undefined };
    case 'branch.create':
      return {
        path: `${path}/git/refs`,
        method: 'POST',
        body: { ref: `refs/heads/${operation.branch}`, sha: operation.headSha },
      };
    case 'branch.delete':
      return {
        path: `${path}/git/refs/heads/${encodeURIComponent(operation.branch)}`,
        method: 'DELETE',
        body: undefined,
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
const identity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositoryIdentity = z.object({ id: identity, full_name: z.string() });
export async function checkRepositoryTarget(
  operation: RepositoryWrite,
  credential: GitHubCredential,
  read: (path: string) => Promise<unknown>,
  dispatch: boolean,
) {
  if (operation.kind === 'repository.create') {
    const owner = z
      .object({ id: identity, login: z.string(), type: z.enum(['User', 'Organization']) })
      .parse(await read(operation.ownerType === 'user' ? '/user' : `/orgs/${encodeURIComponent(operation.owner)}`));
    if (
      owner.id !== operation.ownerId ||
      owner.login.toLowerCase() !== operation.owner.toLowerCase() ||
      owner.type !== (operation.ownerType === 'user' ? 'User' : 'Organization') ||
      (operation.ownerType === 'user' && String(owner.id) !== credential.identity.id)
    )
      throw new GitHubBatchError('batch-conflict');
    return;
  }
  const repository = repositoryIdentity
    .extend({
      archived: z.boolean(),
      default_branch: z.string(),
      permissions: z.object({ admin: z.boolean(), push: z.boolean() }),
    })
    .parse(await read(repositoryPath(operation)));
  if (
    repository.id !== operation.repositoryId ||
    repository.full_name.toLowerCase() !== `${operation.owner}/${operation.repo}`.toLowerCase()
  )
    throw new GitHubBatchError('batch-conflict');
  if (!dispatch) return;
  const branch = operation.kind === 'branch.create' || operation.kind === 'branch.delete';
  if (
    (branch ? !repository.permissions.push : !repository.permissions.admin) ||
    (repository.archived && operation.kind !== 'repository.archive' && operation.kind !== 'repository.delete')
  )
    throw new GitHubBatchError('batch-conflict');
  if (operation.kind === 'repository.delete' && !credential.scopes.includes('delete_repo'))
    throw new GitHubBatchError('batch-conflict');
  if (operation.kind === 'branch.create') {
    const commit = z.object({ sha }).parse(await read(`${repositoryPath(operation)}/git/commits/${operation.headSha}`));
    if (commit.sha !== operation.headSha) throw new GitHubBatchError('batch-conflict');
  }
  if (operation.kind === 'branch.delete') {
    const reference = z
      .object({ ref: z.string(), object: z.object({ type: z.literal('commit'), sha }) })
      .parse(await read(branchPath(operation)));
    if (
      operation.branch === repository.default_branch ||
      reference.ref !== `refs/heads/${operation.branch}` ||
      reference.object.sha !== operation.headSha
    )
      throw new GitHubBatchError('batch-conflict');
  }
}
export function repositoryResult(operation: RepositoryWrite, value: unknown) {
  if (operation.kind === 'repository.delete') return { repositoryId: operation.repositoryId, deleted: true };
  if (operation.kind === 'branch.delete')
    return { repositoryId: operation.repositoryId, deleted: true, headSha: operation.headSha };
  if (operation.kind === 'branch.create') {
    const result = z
      .object({
        ref: z.literal(`refs/heads/${operation.branch}`),
        object: z.object({ type: z.literal('commit'), sha: z.literal(operation.headSha) }),
      })
      .parse(value);
    return { repositoryId: operation.repositoryId, headSha: result.object.sha };
  }
  const result = repositoryIdentity.parse(value);
  const name = operation.kind === 'repository.rename' ? operation.name : operation.repo;
  if (
    result.full_name.toLowerCase() !== `${operation.owner}/${name}`.toLowerCase() ||
    (operation.kind !== 'repository.create' && result.id !== operation.repositoryId)
  )
    throw new GitHubBatchError('batch-unavailable');
  return { repositoryId: result.id };
}
