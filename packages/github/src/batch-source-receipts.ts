import { z } from 'zod';
import type { SourceDependency } from '@tulipfarm/access';
import type { BatchView, GitHubWrite } from './batch-contracts.ts';
import type { GitHubRead } from './read-contracts.ts';
import { fileChanges, isFileWrite } from './file-writes.ts';
import { isProjectWrite } from './project-writes.ts';

type GitHubSource = Extract<SourceDependency, { kind: 'github-personal' }>;
function receiptTarget(operation: GitHubRead, view: BatchView, repositoryId?: number): GitHubRead | null {
  if (!('repo' in operation)) return operation;
  let current: GitHubRead = operation;
  for (const [ordinal, action] of view.snapshot.actions.entries()) {
    const receipt = view.actions[ordinal];
    if (
      receipt?.status !== 'succeeded' ||
      !('repositoryId' in action) ||
      action.owner.toLowerCase() !== current.owner.toLowerCase()
    )
      continue;
    if (
      repositoryId === undefined
        ? action.repo.toLowerCase() !== current.repo.toLowerCase()
        : action.repositoryId !== repositoryId
    )
      continue;
    if (!z.object({ repositoryId: z.literal(action.repositoryId) }).safeParse(receipt.result).success) continue;
    if (action.kind === 'repository.delete' && z.object({ deleted: z.literal(true) }).safeParse(receipt.result).success)
      return null;
    if (action.kind === 'repository.rename') {
      repositoryId = action.repositoryId;
      current = { ...current, repo: action.name };
    }
    if (
      action.kind === 'release.delete' &&
      z
        .object({ releaseId: z.literal(action.releaseId), deleted: z.literal(true), assetIds: z.array(z.number()) })
        .safeParse(receipt.result).success &&
      (((current.kind === 'release.read' || current.kind === 'release.assets') && current.id === action.releaseId) ||
        (current.kind === 'release.asset' && action.assetIds.includes(current.id)))
    ) {
      repositoryId = action.repositoryId;
      current = { kind: 'repository.read', owner: current.owner, repo: current.repo };
    }
    if (
      action.kind === 'release.asset-delete' &&
      current.kind === 'release.asset' &&
      current.id === action.assetId &&
      z.object({ assetId: z.literal(action.assetId), deleted: z.literal(true) }).safeParse(receipt.result).success
    ) {
      repositoryId = action.repositoryId;
      current = { kind: 'repository.read', owner: current.owner, repo: current.repo };
    }
    if (
      action.kind === 'actions.artifact-delete' &&
      current.kind === 'actions.artifact' &&
      current.id === action.artifactId &&
      z.object({ artifactId: z.literal(action.artifactId), deleted: z.literal(true) }).safeParse(receipt.result).success
    ) {
      repositoryId = action.repositoryId;
      current = { kind: 'repository.read', owner: current.owner, repo: current.repo };
    }
    if (
      action.kind === 'branch.delete' &&
      current.kind === 'branch.read' &&
      current.branch === action.branch &&
      z.object({ deleted: z.literal(true), headSha: z.literal(action.headSha) }).safeParse(receipt.result).success
    ) {
      repositoryId = action.repositoryId;
      current = { kind: 'repository.read', owner: current.owner, repo: current.repo };
    }
    if (isFileWrite(action) && (current.kind === 'file.read' || current.kind === 'file.content')) {
      const path = current.path;
      const result = z
        .object({
          branch: z.literal(action.branch),
          headSha: z.literal(action.headSha),
          commitSha: z.string().regex(/^[a-f0-9]{40}$/),
          defaultBranch: z.string(),
          files: z.array(z.object({ path: z.string(), deleted: z.boolean() })),
        })
        .safeParse(receipt.result);
      if (
        result.success &&
        (current.ref === action.branch || (!current.ref && result.data.defaultBranch === action.branch)) &&
        fileChanges(action).some(
          file =>
            file.kind === 'delete' &&
            file.path === path &&
            result.data.files.some(item => item.path === file.path && item.deleted),
        )
      ) {
        repositoryId = action.repositoryId;
        current = { kind: 'repository.read', owner: current.owner, repo: current.repo };
      }
    }
  }
  return current;
}

export function receiptWrite(operation: GitHubWrite, view: BatchView): GitHubWrite | null {
  if (
    isProjectWrite(operation) &&
    'projectId' in operation &&
    view.snapshot.actions.some(
      (action, ordinal) =>
        action.kind === 'project.delete' &&
        action.projectId === operation.projectId &&
        action.ownerNodeId === operation.ownerNodeId &&
        view.actions[ordinal]?.status === 'succeeded' &&
        z
          .object({
            projectId: z.literal(operation.projectId),
            ownerNodeId: z.literal(operation.ownerNodeId),
            deleted: z.literal(true),
          })
          .safeParse(view.actions[ordinal]?.result).success,
    )
  )
    return null;
  if (!('repo' in operation)) return operation;
  if (operation.kind === 'repository.create') return operation;
  const target = receiptTarget(
    { kind: 'repository.read', owner: operation.owner, repo: operation.repo },
    view,
    'repositoryId' in operation ? operation.repositoryId : undefined,
  );
  return target && 'repo' in target ? { ...operation, owner: target.owner, repo: target.repo } : null;
}

export function receiptSource(source: GitHubSource, view: BatchView): GitHubSource | null {
  if (!source.proof || source.accountId !== view.snapshot.accountId || source.generation !== view.snapshot.generation)
    return source;
  const proof = source.proof;
  if (proof.projectList) {
    const { projectList, ...rest } = proof;
    return {
      ...source,
      proof: {
        ...proof,
        projectList: {
          ...projectList,
          projects: projectList.projects.map(
            identity =>
              receiptSource({ ...source, proof: { ...rest, projectIdentity: identity } }, view)?.proof
                ?.projectIdentity ?? identity,
          ),
        },
      },
    };
  }
  if (proof.projectIdentity) {
    const identity = proof.projectIdentity;
    for (const [ordinal, action] of view.snapshot.actions.entries()) {
      const receipt = view.actions[ordinal];
      if (
        action.kind !== 'project.delete' ||
        action.projectId !== identity.projectId ||
        action.projectNumber !== identity.projectNumber ||
        action.ownerNodeId !== identity.ownerNodeId ||
        action.ownerType !== identity.ownerType ||
        action.owner.toLowerCase() !== identity.owner.toLowerCase() ||
        receipt?.status !== 'succeeded'
      )
        continue;
      if (
        z
          .object({
            projectId: z.literal(identity.projectId),
            ownerNodeId: z.literal(identity.ownerNodeId),
            deleted: z.literal(true),
          })
          .safeParse(receipt.result).success
      )
        return { ...source, proof: { ...proof, projectIdentity: { ...identity, deleted: true } } };
    }
  }
  if (
    proof.discussionIdentity &&
    (proof.operation.kind === 'discussion.read' ||
      proof.operation.kind === 'discussion.comments' ||
      proof.operation.kind === 'discussion.replies')
  ) {
    const operation = proof.operation,
      identity = proof.discussionIdentity;
    for (const [ordinal, action] of view.snapshot.actions.entries()) {
      const receipt = view.actions[ordinal];
      if (
        receipt?.status !== 'succeeded' ||
        (action.kind !== 'discussion.delete' && action.kind !== 'discussion.comment-delete') ||
        action.discussionId !== identity.discussionId ||
        action.repositoryId !== identity.repositoryId ||
        action.repositoryNodeId !== identity.repositoryNodeId ||
        action.ownerNodeId !== identity.ownerNodeId ||
        action.discussionNumber !== operation.number ||
        action.owner !== operation.owner ||
        action.repo !== operation.repo
      )
        continue;
      if (
        !z
          .object({
            repositoryId: z.literal(action.repositoryId),
            repositoryNodeId: z.literal(action.repositoryNodeId),
            ownerNodeId: z.literal(action.ownerNodeId),
            discussionId: z.literal(action.discussionId),
            deleted: z.literal(true),
            ...(action.kind === 'discussion.comment-delete' ? { commentId: z.literal(action.commentId) } : {}),
          })
          .safeParse(receipt.result).success
      )
        continue;
      if (
        action.kind === 'discussion.comment-delete' &&
        (operation.kind !== 'discussion.replies' || operation.commentId !== action.commentId)
      )
        continue;
      const target = receiptTarget(
        { kind: 'repository.read', owner: operation.owner, repo: operation.repo },
        view,
        identity.repositoryId,
      );
      return target ? { ...source, proof: { ...proof, transport: 'rest', operation: target } } : null;
    }
  }
  if (proof.download) {
    if (
      !(
        (proof.download.operation.kind === 'release.download' && proof.operation.kind === 'release.asset') ||
        (proof.download.operation.kind === 'actions.artifact-download' && proof.operation.kind === 'actions.artifact')
      ) ||
      !('id' in proof.operation) ||
      proof.download.operation.id !== proof.operation.id ||
      proof.download.operation.owner !== proof.operation.owner ||
      proof.download.operation.repo !== proof.operation.repo
    )
      return source;
    const target = receiptTarget(proof.operation, view);
    if (target?.kind !== 'repository.read') return source;
    const { download: _download, ...metadata } = proof;
    return { ...source, proof: { ...metadata, operation: target } };
  }
  const rewrite = (operation: GitHubRead) => receiptTarget(operation, view);
  const operation = rewrite(proof.operation);
  if (!operation) return null;
  return {
    ...source,
    proof: {
      ...proof,
      operation,
      ...(proof.accessTargets
        ? { accessTargets: proof.accessTargets.map(rewrite).filter((target): target is GitHubRead => target !== null) }
        : {}),
    },
  };
}
