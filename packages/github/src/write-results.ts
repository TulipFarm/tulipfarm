import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import { mergeResultSchema } from './pull-writes.ts';
import { actionsMcpResult } from './actions-writes.ts';
import { discussionMcpResult, isDiscussionWrite } from './discussion-writes.ts';
import { isProjectWrite } from './project-writes.ts';

export const writeSuccessStatus = {
  'project.create': 200,
  'project.update': 200,
  'project.close': 200,
  'project.reopen': 200,
  'project.delete': 200,
  'project.field-create': 200,
  'project.field-update': 200,
  'project.field-delete': 200,
  'project.item-add': 200,
  'project.draft-create': 200,
  'project.draft-update': 200,
  'project.item-archive': 200,
  'project.item-unarchive': 200,
  'project.item-delete': 200,
  'project.value-set': 200,
  'project.value-clear': 200,
  'discussion.create': 200,
  'discussion.update': 200,
  'discussion.delete': 200,
  'discussion.comment-create': 200,
  'discussion.comment-update': 200,
  'discussion.comment-delete': 200,
  'discussion.answer-mark': 200,
  'discussion.answer-unmark': 200,
  'actions.dispatch': 200,
  'actions.rerun': 201,
  'actions.cancel': 202,
  'actions.artifact-delete': 204,
  'release.create': 201,
  'release.update': 200,
  'release.publish': 200,
  'release.delete': 204,
  'release.asset-upload': 201,
  'release.asset-update': 200,
  'release.asset-delete': 204,
  'file.create': 201,
  'file.update': 200,
  'file.delete': 200,
  'files.commit': 200,
  'pull.create-fork': 201,
  'repository.create': 201,
  'repository.settings': 200,
  'repository.rename': 200,
  'repository.archive': 200,
  'repository.delete': 204,
  'branch.create': 201,
  'branch.delete': 204,
  'issue.create': 201,
  'issue.update': 200,
  'issue.comment': 201,
  'issue.close': 200,
  'issue.reopen': 200,
  'pull.create': 201,
  'pull.update': 200,
  'pull.comment': 201,
  'pull.close': 200,
  'pull.reopen': 200,
  'pull.review': 200,
  'pull.request-reviewers': 201,
  'pull.merge': 200,
} satisfies Record<GitHubWrite['kind'], number>;

const minimalResponse = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine(id => BigInt(id) <= 9223372036854775807n),
  url: z.url(),
});
const resultEnvelope = z.object({
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
  structuredContent: z.json().optional(),
  isError: z.literal(false).optional(),
});

export function mcpWriteResult(operation: GitHubWrite, result: unknown) {
  if (isProjectWrite(operation)) throw new GitHubBatchError('batch-unavailable');
  const response = resultEnvelope.parse(result);
  const text = response.content[0].text;
  if (operation.kind === 'pull.review') {
    z.literal('pull request review submitted successfully').parse(text);
    if (response.structuredContent !== undefined) throw new GitHubBatchError('batch-unavailable');
    return { providerAcknowledged: true };
  }
  const value: unknown = JSON.parse(text);
  if (response.structuredContent !== undefined && !isDeepStrictEqual(response.structuredContent, value))
    throw new GitHubBatchError('batch-unavailable');
  if (isDiscussionWrite(operation)) return discussionMcpResult(operation, value);
  if (operation.kind === 'actions.rerun' || operation.kind === 'actions.cancel')
    return actionsMcpResult(operation, value);
  if (operation.kind === 'pull.merge') return mergeResultSchema.parse(value);
  const receipt = minimalResponse.parse(value);
  if (operation.kind === 'repository.create') {
    if (receipt.url.toLowerCase() !== `https://github.com/${operation.owner}/${operation.repo}`.toLowerCase())
      throw new GitHubBatchError('batch-unavailable');
    return { repositoryId: receipt.id };
  }
  const url = new URL(receipt.url);
  const path = url.pathname.split('/');
  const number = z
    .number()
    .int()
    .positive()
    .parse(
      Number(
        z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .parse(path[4]),
      ),
    );
  const family = operation.kind.startsWith('pull.') ? 'pull' : 'issues';
  const comment = operation.kind === 'pull.comment' || operation.kind === 'issue.comment';
  const targetNumber =
    'pullNumber' in operation ? operation.pullNumber : 'issueNumber' in operation ? operation.issueNumber : number;
  if (
    receipt.url.toLowerCase() !==
      `https://github.com/${operation.owner.toLowerCase()}/${operation.repo.toLowerCase()}/${family}/${number}${comment ? `#issuecomment-${receipt.id}` : ''}` ||
    number !== targetNumber ||
    ('pullRequestId' in operation && !comment && receipt.id !== String(operation.pullRequestId))
  )
    throw new GitHubBatchError('batch-unavailable');
  return comment ? { id: receipt.id } : { id: receipt.id, number };
}
