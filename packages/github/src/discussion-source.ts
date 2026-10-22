import { z } from 'zod';
import type { GitHubRead } from './read-contracts.ts';

const repository = z.object({
  id: z.string(),
  databaseId: z.number().int().positive(),
  owner: z.object({ id: z.string() }),
});
export function discussionSourceIdentity(operation: GitHubRead, data: unknown) {
  if (
    operation.kind !== 'discussion.read' &&
    operation.kind !== 'discussion.comments' &&
    operation.kind !== 'discussion.replies'
  )
    return undefined;
  const value =
    operation.kind === 'discussion.read'
      ? z
          .object({ id: z.string(), repository })
          .transform(value => ({ discussionId: value.id, repository: value.repository }))
          .parse(data)
      : z.object({ sourceIdentity: z.object({ discussionId: z.string(), repository }) }).parse(data).sourceIdentity;
  return {
    discussionId: value.discussionId,
    repositoryNodeId: value.repository.id,
    repositoryId: value.repository.databaseId,
    ownerNodeId: value.repository.owner.id,
  };
}
