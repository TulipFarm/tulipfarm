import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import type { GitHubCredential } from './accounts.ts';
import { repositoryPath } from './repository-writes.ts';

export type ReleaseWrite = Extract<GitHubWrite, { kind: `release.${string}` }>;
export function isReleaseWrite(operation: GitHubWrite): operation is ReleaseWrite {
  return operation.kind.startsWith('release.');
}
const release = z.object({
  id: z.number().int().positive(),
  tag_name: z.string(),
  target_commitish: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable().optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  updated_at: z.iso.datetime().nullable().optional(),
  immutable: z.boolean().optional(),
  assets: z.array(z.object({ id: z.number().int().positive() })).max(30),
});
const asset = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  label: z.string().nullable(),
  content_type: z.string(),
  size: z.number().int().nonnegative(),
  state: z.string(),
  digest: z.string().nullable().optional(),
});
export function releaseUploadBytes(operation: Extract<ReleaseWrite, { kind: 'release.asset-upload' }>) {
  const bytes = Buffer.from(operation.content, 'base64');
  if (
    bytes.length !== operation.size ||
    bytes.length > 8192 ||
    bytes.toString('base64') !== operation.content ||
    createHash('sha256').update(bytes).digest('hex') !== operation.sha256
  )
    throw new GitHubBatchError('batch-conflict');
  return bytes;
}
export function releasePath(operation: ReleaseWrite) {
  const base = `${repositoryPath(operation)}/releases`;
  return 'assetId' in operation
    ? `${base}/assets/${operation.assetId}`
    : 'releaseId' in operation
      ? `${base}/${operation.releaseId}`
      : base;
}
const fields = (operation: Extract<ReleaseWrite, { tagName: string }>) => ({
  tag_name: operation.tagName,
  target_commitish: operation.targetCommitish,
  name: operation.name,
  body: operation.body,
  prerelease: operation.prerelease,
});
export function releaseRequest(operation: ReleaseWrite): {
  path: string;
  method: string;
  body?: Record<string, string | boolean>;
} {
  const path = releasePath(operation);
  switch (operation.kind) {
    case 'release.create':
      return { path, method: 'POST', body: { ...fields(operation), draft: true } };
    case 'release.update':
      return { path, method: 'PATCH', body: fields(operation) };
    case 'release.publish':
      return { path, method: 'PATCH', body: { ...fields(operation), draft: false } };
    case 'release.delete':
    case 'release.asset-delete':
      return { path, method: 'DELETE' };
    case 'release.asset-update':
      return { path, method: 'PATCH', body: { name: operation.name, label: operation.label } };
    case 'release.asset-upload':
      return {
        path: `${path}/assets?${new URLSearchParams({ name: operation.name, label: operation.label })}`,
        method: 'POST',
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
export async function checkReleaseTarget(
  operation: ReleaseWrite,
  credential: GitHubCredential,
  read: (path: string) => Promise<unknown>,
  dispatch: boolean,
) {
  const repo = z
    .object({
      id: z.literal(operation.repositoryId),
      full_name: z.string(),
      archived: z.boolean(),
      permissions: z.object({ push: z.boolean() }),
    })
    .parse(await read(repositoryPath(operation)));
  if (
    repo.full_name.toLowerCase() !== `${operation.owner}/${operation.repo}`.toLowerCase() ||
    !repo.permissions.push ||
    (dispatch && repo.archived)
  )
    throw new GitHubBatchError('batch-conflict');
  if (!dispatch) return;
  if (operation.kind === 'release.asset-upload') releaseUploadBytes(operation);
  if (operation.kind === 'release.create') return;
  if ('assetId' in operation) {
    const current = asset.parse(await read(releasePath(operation)));
    if (current.id !== operation.assetId) throw new GitHubBatchError('batch-conflict');
    return;
  }
  const current = release.parse(await read(releasePath(operation)));
  if (
    current.id !== operation.releaseId ||
    (current.immutable && operation.kind !== 'release.delete') ||
    ('expectedUpdatedAt' in operation && (current.updated_at ?? null) !== operation.expectedUpdatedAt)
  )
    throw new GitHubBatchError('batch-conflict');
  if (operation.kind === 'release.publish' || operation.kind === 'release.delete') {
    const ids = [...new Set(operation.assetIds)].sort((a, b) => a - b);
    if (
      ids.length !== operation.assetIds.length ||
      JSON.stringify(ids) !== JSON.stringify(current.assets.map(item => item.id).sort((a, b) => a - b))
    )
      throw new GitHubBatchError('batch-conflict');
  }
  if (
    operation.kind === 'release.publish' &&
    (!current.draft ||
      current.tag_name !== operation.tagName ||
      current.target_commitish !== operation.targetCommitish ||
      current.name !== operation.name ||
      (current.body ?? '') !== operation.body ||
      current.prerelease !== operation.prerelease)
  )
    throw new GitHubBatchError('batch-conflict');
}
export function releaseResult(operation: ReleaseWrite, value: unknown) {
  const base = { repositoryId: operation.repositoryId };
  switch (operation.kind) {
    case 'release.delete':
      z.null().parse(value);
      return { ...base, releaseId: operation.releaseId, assetIds: operation.assetIds, deleted: true };
    case 'release.asset-delete':
      z.null().parse(value);
      return { ...base, assetId: operation.assetId, deleted: true };
    case 'release.asset-update':
    case 'release.asset-upload': {
      const result = asset.parse(value);
      if (
        result.name !== operation.name ||
        (result.label ?? '') !== operation.label ||
        ('assetId' in operation && result.id !== operation.assetId)
      )
        throw new GitHubBatchError('batch-unavailable');
      if (
        operation.kind === 'release.asset-upload' &&
        (result.size !== operation.size ||
          result.content_type !== operation.contentType ||
          result.state !== 'uploaded' ||
          (result.digest != null && result.digest !== `sha256:${operation.sha256}`))
      )
        throw new GitHubBatchError('batch-unavailable');
      return {
        ...base,
        assetId: result.id,
        name: result.name,
        size: result.size,
        ...(operation.kind === 'release.asset-upload'
          ? { releaseId: operation.releaseId, sha256: operation.sha256 }
          : {}),
      };
    }
    case 'release.create':
    case 'release.update':
    case 'release.publish': {
      const result = release.parse(value);
      if (
        ('releaseId' in operation && result.id !== operation.releaseId) ||
        result.tag_name !== operation.tagName ||
        result.target_commitish !== operation.targetCommitish ||
        result.name !== operation.name ||
        (result.body ?? '') !== operation.body ||
        result.prerelease !== operation.prerelease ||
        (operation.kind === 'release.create' && !result.draft) ||
        (operation.kind === 'release.publish' && result.draft)
      )
        throw new GitHubBatchError('batch-unavailable');
      return {
        ...base,
        releaseId: result.id,
        draft: result.draft,
        tagName: result.tag_name,
        updatedAt: result.updated_at ?? null,
      };
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
export function recoverRelease(operation: ReleaseWrite, value: unknown, marker: string, authorId: string) {
  if (operation.kind !== 'release.create') return null;
  const matches = z
    .array(release.extend({ author: z.object({ id: z.number() }) }))
    .parse(value)
    .filter(
      item =>
        String(item.author.id) === authorId &&
        marker &&
        item.body?.includes(marker) &&
        item.body === operation.body &&
        item.name === operation.name &&
        item.tag_name === operation.tagName &&
        item.target_commitish === operation.targetCommitish &&
        item.draft &&
        item.prerelease === operation.prerelease,
    );
  return matches.length === 1 ? releaseResult(operation, matches[0]) : null;
}
