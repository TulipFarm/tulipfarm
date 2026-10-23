import { z } from 'zod';
import type { GitHubCredential } from './accounts.ts';
import { GitHubBatchError, type GitHubWrite } from './batch-contracts.ts';
import { githubNodeId, type DiscussionWrite } from './discussion-contracts.ts';

export function isDiscussionWrite(operation: GitHubWrite): operation is DiscussionWrite {
  return operation.kind.startsWith('discussion.');
}
const repositoryFields = 'id databaseId nameWithOwner owner { id login }';
const discussionFields = `id number title body category { id isAnswerable } repository { ${repositoryFields} }`;
const commentFields = `id body replyTo { id } discussion { ${discussionFields} }`;
const mutation = (name: string, input: string, selection: string) =>
  `mutation($input: ${input}!) { result: ${name}(input: $input) { ${selection} } }`;
export const discussionDocuments = {
  repository: `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${repositoryFields} isArchived hasDiscussionsEnabled viewerPermission } }`,
  category: `query($id: ID!) { node(id: $id) { ... on DiscussionCategory { id repository { ${repositoryFields} } } } }`,
  discussion: `query($id: ID!) { node(id: $id) { ... on Discussion { ${discussionFields} locked viewerCanUpdate viewerCanDelete } } }`,
  comment: `query($id: ID!) { node(id: $id) { ... on DiscussionComment { ${commentFields} viewerCanUpdate viewerCanDelete viewerCanMarkAsAnswer viewerCanUnmarkAsAnswer isAnswer } } }`,
  createdDiscussions: `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { discussions(first: 30, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${discussionFields} author { ... on User { databaseId } } } } } }`,
  createdComments: `query($id: ID!) { node(id: $id) { ... on Discussion { comments(last: 30) { nodes { ${commentFields} author { ... on User { databaseId } } } } } ... on DiscussionComment { replies(last: 30) { nodes { ${commentFields} author { ... on User { databaseId } } } } } } }`,
  'discussion.create': mutation('createDiscussion', 'CreateDiscussionInput', `discussion { ${discussionFields} }`),
  'discussion.update': mutation('updateDiscussion', 'UpdateDiscussionInput', `discussion { ${discussionFields} }`),
  'discussion.delete': mutation('deleteDiscussion', 'DeleteDiscussionInput', 'discussion { id }'),
  'discussion.comment-create': mutation(
    'addDiscussionComment',
    'AddDiscussionCommentInput',
    `comment { ${commentFields} }`,
  ),
  'discussion.comment-update': mutation(
    'updateDiscussionComment',
    'UpdateDiscussionCommentInput',
    `comment { ${commentFields} }`,
  ),
  'discussion.comment-delete': mutation('deleteDiscussionComment', 'DeleteDiscussionCommentInput', 'comment { id }'),
  'discussion.answer-mark': mutation(
    'markDiscussionCommentAsAnswer',
    'MarkDiscussionCommentAsAnswerInput',
    'discussion { id answer { id } }',
  ),
  'discussion.answer-unmark': mutation(
    'unmarkDiscussionCommentAsAnswer',
    'UnmarkDiscussionCommentAsAnswerInput',
    'discussion { id answer { id } }',
  ),
};
export function discussionRequest(operation: DiscussionWrite) {
  let input;
  switch (operation.kind) {
    case 'discussion.create':
      input = {
        repositoryId: operation.repositoryNodeId,
        categoryId: operation.categoryId,
        title: operation.title,
        body: operation.body,
      };
      break;
    case 'discussion.update':
      input = {
        discussionId: operation.discussionId,
        categoryId: operation.categoryId,
        title: operation.title,
        body: operation.body,
      };
      break;
    case 'discussion.delete':
      input = { id: operation.discussionId };
      break;
    case 'discussion.comment-create':
      input = { discussionId: operation.discussionId, replyToId: operation.replyToId, body: operation.body };
      break;
    case 'discussion.comment-update':
      input = { commentId: operation.commentId, body: operation.body };
      break;
    case 'discussion.comment-delete':
    case 'discussion.answer-mark':
    case 'discussion.answer-unmark':
      input = { id: operation.commentId };
      break;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
  return {
    path: '/graphql',
    method: 'POST',
    body: { query: discussionDocuments[operation.kind], variables: { input } },
  };
}
const repositorySchema = z.object({
  id: githubNodeId,
  databaseId: z.number(),
  nameWithOwner: z.string(),
  owner: z.object({ id: githubNodeId, login: z.string() }),
});
function repositoryIdentity(operation: DiscussionWrite, value: unknown) {
  const repository = repositorySchema.parse(value);
  if (
    repository.id !== operation.repositoryNodeId ||
    repository.databaseId !== operation.repositoryId ||
    repository.owner.id !== operation.ownerNodeId ||
    repository.owner.login.toLowerCase() !== operation.owner.toLowerCase() ||
    repository.nameWithOwner.toLowerCase() !== `${operation.owner}/${operation.repo}`.toLowerCase()
  )
    throw new GitHubBatchError('batch-conflict');
  return repository;
}
const discussionSchema = z.object({ id: githubNodeId, number: z.number(), repository: repositorySchema });
function discussionIdentity(operation: Exclude<DiscussionWrite, { kind: 'discussion.create' }>, value: unknown) {
  const discussion = discussionSchema.parse(value);
  repositoryIdentity(operation, discussion.repository);
  if (discussion.id !== operation.discussionId || discussion.number !== operation.discussionNumber)
    throw new GitHubBatchError('batch-conflict');
}
export function graphqlData(value: unknown) {
  const envelope = z
    .object({ data: z.record(z.string(), z.json()).nullable().optional(), errors: z.array(z.unknown()).optional() })
    .parse(value);
  if (envelope.errors?.length || !envelope.data) throw new GitHubBatchError('batch-unavailable');
  return envelope.data;
}
export async function checkDiscussionTarget(
  operation: DiscussionWrite,
  credential: GitHubCredential,
  read: (query: string, variables: Record<string, string>) => Promise<unknown>,
  dispatch: boolean,
) {
  const value = graphqlData(
    await read(discussionDocuments.repository, { owner: operation.owner, repo: operation.repo }),
  ).repository;
  repositoryIdentity(operation, value);
  if (!dispatch) return;
  const rights = z
    .object({ isArchived: z.boolean(), hasDiscussionsEnabled: z.boolean(), viewerPermission: z.string().nullable() })
    .parse(value);
  if (rights.isArchived || !rights.hasDiscussionsEnabled || !rights.viewerPermission)
    throw new GitHubBatchError('batch-conflict');
  if ('categoryId' in operation) {
    const category = z
      .object({ id: z.literal(operation.categoryId), repository: repositorySchema })
      .parse(graphqlData(await read(discussionDocuments.category, { id: operation.categoryId })).node);
    repositoryIdentity(operation, category.repository);
  }
  if (operation.kind === 'discussion.create') return;
  const node = graphqlData(await read(discussionDocuments.discussion, { id: operation.discussionId })).node;
  discussionIdentity(operation, node);
  const discussion = z
    .object({
      locked: z.boolean(),
      viewerCanUpdate: z.boolean(),
      viewerCanDelete: z.boolean(),
      category: z.object({ isAnswerable: z.boolean() }),
    })
    .parse(node);
  if (
    (operation.kind === 'discussion.update' && !discussion.viewerCanUpdate) ||
    (operation.kind === 'discussion.delete' && !discussion.viewerCanDelete) ||
    (operation.kind === 'discussion.comment-create' && discussion.locked)
  )
    throw new GitHubBatchError('batch-conflict');
  const commentId =
    'commentId' in operation
      ? operation.commentId
      : operation.kind === 'discussion.comment-create'
        ? operation.replyToId
        : null;
  if (!commentId) return;
  const comment = z
    .object({
      id: z.literal(commentId),
      discussion: discussionSchema,
      replyTo: z.object({ id: githubNodeId }).nullable(),
      viewerCanUpdate: z.boolean(),
      viewerCanDelete: z.boolean(),
      viewerCanMarkAsAnswer: z.boolean(),
      viewerCanUnmarkAsAnswer: z.boolean(),
      isAnswer: z.boolean(),
    })
    .parse(graphqlData(await read(discussionDocuments.comment, { id: commentId })).node);
  discussionIdentity(operation, comment.discussion);
  if (
    (operation.kind === 'discussion.comment-create' && comment.replyTo !== null) ||
    (operation.kind === 'discussion.comment-update' && !comment.viewerCanUpdate) ||
    (operation.kind === 'discussion.comment-delete' && !comment.viewerCanDelete) ||
    (operation.kind === 'discussion.answer-mark' &&
      (!discussion.category.isAnswerable || !comment.viewerCanMarkAsAnswer || comment.isAnswer)) ||
    (operation.kind === 'discussion.answer-unmark' &&
      (!discussion.category.isAnswerable || !comment.viewerCanUnmarkAsAnswer || !comment.isAnswer))
  )
    throw new GitHubBatchError('batch-conflict');
}
export function discussionResult(operation: DiscussionWrite, value: unknown) {
  const result = z.record(z.string(), z.json()).parse(graphqlData(value).result);
  const base = {
    repositoryId: operation.repositoryId,
    repositoryNodeId: operation.repositoryNodeId,
    ownerNodeId: operation.ownerNodeId,
  };
  if (operation.kind === 'discussion.create' || operation.kind === 'discussion.update') {
    const discussion = discussionSchema
      .extend({
        title: z.literal(operation.title),
        body: z.literal(operation.body),
        category: z.object({ id: z.literal(operation.categoryId) }),
      })
      .parse(result.discussion);
    repositoryIdentity(operation, discussion.repository);
    if (operation.kind === 'discussion.update') discussionIdentity(operation, discussion);
    return { ...base, discussionId: discussion.id, discussionNumber: discussion.number };
  }
  const pinned = { ...base, discussionId: operation.discussionId, discussionNumber: operation.discussionNumber };
  if (operation.kind === 'discussion.delete') {
    z.object({ id: z.literal(operation.discussionId) }).parse(result.discussion);
    return { ...pinned, deleted: true };
  }
  if (operation.kind === 'discussion.comment-create' || operation.kind === 'discussion.comment-update') {
    const comment = z
      .object({
        id: githubNodeId,
        body: z.literal(operation.body),
        discussion: discussionSchema,
        replyTo: z.object({ id: githubNodeId }).nullable(),
      })
      .parse(result.comment);
    discussionIdentity(operation, comment.discussion);
    if (
      (operation.kind === 'discussion.comment-update' && comment.id !== operation.commentId) ||
      (operation.kind === 'discussion.comment-create' && (comment.replyTo?.id ?? null) !== operation.replyToId)
    )
      throw new GitHubBatchError('batch-unavailable');
    return { ...pinned, commentId: comment.id };
  }
  if (operation.kind === 'discussion.comment-delete') {
    z.object({ id: z.literal(operation.commentId) }).parse(result.comment);
    return { ...pinned, commentId: operation.commentId, deleted: true };
  }
  z.object({
    id: z.literal(operation.discussionId),
    answer: operation.kind === 'discussion.answer-mark' ? z.object({ id: z.literal(operation.commentId) }) : z.null(),
  }).parse(result.discussion);
  return { ...pinned, commentId: operation.commentId, answer: operation.kind === 'discussion.answer-mark' };
}
export function discussionMcpArguments(operation: DiscussionWrite) {
  if (operation.kind === 'discussion.comment-update')
    return { method: 'update', commentNodeID: operation.commentId, body: operation.body };
  if (operation.kind === 'discussion.comment-delete') return { method: 'delete', commentNodeID: operation.commentId };
  if (operation.kind === 'discussion.answer-mark' || operation.kind === 'discussion.answer-unmark')
    return {
      method: operation.kind === 'discussion.answer-mark' ? 'mark_answer' : 'unmark_answer',
      commentNodeID: operation.commentId,
    };
  throw new GitHubBatchError('batch-unavailable');
}
export function discussionMcpResult(operation: DiscussionWrite, value: unknown) {
  const base = {
    repositoryId: operation.repositoryId,
    repositoryNodeId: operation.repositoryNodeId,
    ownerNodeId: operation.ownerNodeId,
  };
  if (operation.kind === 'discussion.answer-mark' || operation.kind === 'discussion.answer-unmark') {
    z.strictObject({
      discussionID: z.literal(operation.discussionId),
      discussionURL: z.literal(
        `https://github.com/${operation.owner}/${operation.repo}/discussions/${operation.discussionNumber}`,
      ),
    }).parse(value);
    return {
      ...base,
      discussionId: operation.discussionId,
      discussionNumber: operation.discussionNumber,
      commentId: operation.commentId,
      answer: operation.kind === 'discussion.answer-mark',
    };
  }
  if (operation.kind === 'discussion.comment-update' || operation.kind === 'discussion.comment-delete') {
    const receipt = z.strictObject({ id: z.literal(operation.commentId), url: z.string() }).parse(value);
    if (
      !new RegExp(
        `^https://github\\.com/${operation.owner}/${operation.repo.replaceAll('.', '\\.')}\\/discussions/${operation.discussionNumber}#discussioncomment-[1-9][0-9]*$`,
      ).test(receipt.url)
    )
      throw new GitHubBatchError('batch-unavailable');
    return {
      ...base,
      discussionId: operation.discussionId,
      discussionNumber: operation.discussionNumber,
      commentId: operation.commentId,
      ...(operation.kind === 'discussion.comment-delete' ? { deleted: true } : {}),
    };
  }
  throw new GitHubBatchError('batch-unavailable');
}
export async function recoverDiscussion(
  operation: DiscussionWrite,
  credential: GitHubCredential,
  marker: string,
  read: (query: string, variables: Record<string, string>) => Promise<unknown>,
) {
  if (operation.kind !== 'discussion.create' && operation.kind !== 'discussion.comment-create') return null;
  if (!marker || !operation.body.includes(marker)) return null;
  const value =
    operation.kind === 'discussion.create'
      ? graphqlData(
          await read(discussionDocuments.createdDiscussions, { owner: operation.owner, repo: operation.repo }),
        ).repository
      : graphqlData(
          await read(discussionDocuments.createdComments, { id: operation.replyToId ?? operation.discussionId }),
        ).node;
  const key = operation.kind === 'discussion.create' ? 'discussions' : operation.replyToId ? 'replies' : 'comments';
  const list = z
    .object({
      [key]: z.object({
        nodes: z
          .array(
            z
              .object({ body: z.string(), author: z.object({ databaseId: z.number().nullable() }).nullable() })
              .passthrough(),
          )
          .max(30),
      }),
    })
    .parse(value)[key];
  const matches = list?.nodes.filter(
    item => item.body === operation.body && String(item.author?.databaseId) === credential.identity.id,
  );
  if (matches?.length !== 1) return null;
  try {
    return discussionResult(operation, {
      data: { result: { [operation.kind === 'discussion.create' ? 'discussion' : 'comment']: matches[0] } },
    });
  } catch {
    return null;
  }
}
