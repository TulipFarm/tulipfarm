import { z } from 'zod';
import type { GitHubCredential } from './accounts.ts';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import { decodeFileContent } from './file-contracts.ts';
import { branchPath, repositoryPath } from './repository-writes.ts';

export type FileWrite = Extract<GitHubWrite, { kind: `file.${string}` | 'files.commit' }>;
export const isFileWrite = (operation: GitHubWrite): operation is FileWrite =>
  operation.kind.startsWith('file.') || operation.kind === 'files.commit';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const fileCandidateSchema = z.object({
  phase: z.literal('ref-dispatch'),
  commitSha: sha,
  treeSha: sha,
  defaultBranch: z.string(),
});
export const fileChanges = (operation: FileWrite) =>
  operation.kind === 'files.commit'
    ? operation.files
    : [
        operation.kind === 'file.delete'
          ? { kind: 'delete' as const, path: operation.path, blobSha: operation.blobSha }
          : operation.kind === 'file.update'
            ? { ...operation, kind: 'update' as const }
            : { ...operation, kind: 'create' as const },
      ];
export const contentsPath = (operation: { owner: string; repo: string }, path: string) =>
  `${repositoryPath(operation)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
export function fileRequest(operation: FileWrite) {
  if (operation.kind === 'files.commit') throw new GitHubBatchError('batch-conflict');
  return {
    path: contentsPath(operation, operation.path),
    method: operation.kind === 'file.delete' ? 'DELETE' : 'PUT',
    body: {
      branch: operation.branch,
      message: operation.message,
      ...('blobSha' in operation ? { sha: operation.blobSha } : {}),
      ...(operation.kind !== 'file.delete'
        ? { content: Buffer.from(decodeFileContent(operation)).toString('base64') }
        : {}),
    },
  };
}
export async function checkFileTarget(
  operation: FileWrite,
  credential: GitHubCredential,
  read: (path: string) => Promise<unknown>,
  dispatch: boolean,
) {
  const repository = z
    .object({
      id: z.number(),
      full_name: z.string(),
      archived: z.boolean(),
      default_branch: z.string(),
      permissions: z.object({ push: z.boolean() }),
    })
    .parse(await read(repositoryPath(operation)));
  if (
    repository.id !== operation.repositoryId ||
    repository.full_name.toLowerCase() !== `${operation.owner}/${operation.repo}`.toLowerCase()
  )
    throw new GitHubBatchError('batch-conflict');
  if (!dispatch) return repository;
  if (repository.archived || !repository.permissions.push) throw new GitHubBatchError('batch-conflict');
  const reference = z
    .object({ ref: z.literal(`refs/heads/${operation.branch}`), object: z.object({ type: z.literal('commit'), sha }) })
    .parse(await read(branchPath(operation)));
  if (reference.object.sha !== operation.headSha) throw new GitHubBatchError('batch-conflict');
  return repository;
}
export async function fileTree(operation: FileWrite, read: (path: string) => Promise<unknown>) {
  const commit = z
    .object({ sha: z.literal(operation.headSha), tree: z.object({ sha }) })
    .parse(await read(`${repositoryPath(operation)}/git/commits/${operation.headSha}`));
  const entries = new Map<string, { mode: '100644' | '100755'; sha: string }>();
  const trees = new Map<string, { path: string; mode: string; type: string; sha: string }[]>();
  for (const file of fileChanges(operation)) {
    const parts = file.path.split('/');
    let treeSha = commit.tree.sha;
    for (const [index, part] of parts.entries()) {
      let tree = trees.get(treeSha);
      if (!tree) {
        const value = z
          .object({
            sha: z.literal(treeSha),
            truncated: z.literal(false),
            tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha })),
          })
          .parse(await read(`${repositoryPath(operation)}/git/trees/${treeSha}`));
        tree = value.tree;
        trees.set(treeSha, tree);
      }
      const entry = tree.find(item => item.path === part);
      if (!entry) {
        if (file.kind !== 'create') throw new GitHubBatchError('batch-conflict');
        break;
      }
      if (index < parts.length - 1) {
        if (entry.type !== 'tree' || entry.mode !== '040000') throw new GitHubBatchError('batch-conflict');
        treeSha = entry.sha;
        continue;
      }
      if (
        file.kind === 'create' ||
        entry.type !== 'blob' ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        entry.sha !== file.blobSha
      )
        throw new GitHubBatchError('batch-conflict');
      entries.set(file.path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return { treeSha: commit.tree.sha, entries };
}
export function fileReceipt(operation: FileWrite, commitSha: string, defaultBranch: string) {
  return {
    repositoryId: operation.repositoryId,
    commitSha,
    branch: operation.branch,
    defaultBranch,
    headSha: operation.headSha,
    files: fileChanges(operation).map(file => ({ path: file.path, deleted: file.kind === 'delete' })),
  };
}
export function contentsResult(
  operation: Exclude<FileWrite, { kind: 'files.commit' }>,
  value: unknown,
  defaultBranch: string,
) {
  const result = z
    .object({
      commit: z.object({
        sha,
        message: z.literal(operation.message),
        parents: z.array(z.object({ sha })).min(1).max(1),
      }),
      content: operation.kind === 'file.delete' ? z.null() : z.object({ path: z.literal(operation.path), sha }),
    })
    .parse(value);
  // Contents compares the blob, not the branch head atomically. A concurrent parent stays unresolved.
  if (result.commit.parents[0]?.sha !== operation.headSha) throw new GitHubBatchError('batch-unavailable');
  return fileReceipt(operation, result.commit.sha, defaultBranch);
}
