import { z } from 'zod';

export const githubNodeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_=-]+$/);
const repository = {
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine(value => value !== '.' && value !== '..'),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repositoryNodeId: githubNodeId,
  ownerNodeId: githubNodeId,
};
const discussion = {
  ...repository,
  discussionId: githubNodeId,
  discussionNumber: z.number().int().positive().max(2147483647),
};
const comment = { ...discussion, commentId: githubNodeId };
const body = z.string().min(1).max(16000);
export const discussionWriteSchemas = [
  z.strictObject({
    kind: z.literal('discussion.create'),
    ...repository,
    categoryId: githubNodeId,
    title: z.string().min(1).max(256),
    body,
  }),
  z.strictObject({
    kind: z.literal('discussion.update'),
    ...discussion,
    categoryId: githubNodeId,
    title: z.string().min(1).max(256),
    body,
  }),
  z.strictObject({ kind: z.literal('discussion.delete'), ...discussion }),
  z.strictObject({
    kind: z.literal('discussion.comment-create'),
    ...discussion,
    replyToId: githubNodeId.nullable(),
    body,
  }),
  z.strictObject({ kind: z.literal('discussion.comment-update'), ...comment, body }),
  z.strictObject({ kind: z.literal('discussion.comment-delete'), ...comment }),
  z.strictObject({ kind: z.enum(['discussion.answer-mark', 'discussion.answer-unmark']), ...comment }),
] as const;
export type DiscussionWrite = z.infer<(typeof discussionWriteSchemas)[number]>;
