import { z } from 'zod';

export const githubEventIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s\p{Cc}~^:?*[\]\\]+$/u);

export const githubRepositorySelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repositories'),
    repositoryIds: z
      .array(githubEventIdSchema)
      .min(1)
      .max(1000)
      .refine(unique, 'Select each repository once')
      .transform(ids => ids.sort()),
  }),
  z.strictObject({
    kind: z.literal('organization'),
    organizationId: githubEventIdSchema,
    includeFuture: z.literal(true),
  }),
]);
export const githubBranchSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('selected'),
    names: z
      .array(branchName)
      .min(1)
      .max(100)
      .refine(unique, 'Select each branch once')
      .transform(names => names.sort()),
  }),
]);
export const githubPullRequestActionSchema = z.enum([
  'opened',
  'reopened',
  'synchronize',
  'edited',
  'closed',
  'merged',
  'converted_to_draft',
  'ready_for_review',
  'review_requested',
  'review_request_removed',
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'locked',
  'unlocked',
  'milestoned',
  'demilestoned',
  'auto_merge_enabled',
  'auto_merge_disabled',
  'enqueued',
  'dequeued',
]);
export const githubReviewActionSchema = z.enum(['submitted', 'edited', 'dismissed']);
export const githubCommentActionSchema = z.enum(['created', 'edited', 'deleted']);
export const githubEventSelectionSchema = z
  .array(
    z.discriminatedUnion('event', [
      z.strictObject({
        event: z.literal('pull_request'),
        actions: z
          .array(githubPullRequestActionSchema)
          .min(1)
          .max(22)
          .refine(unique, 'Select each action once')
          .transform(actions => actions.sort()),
      }),
      z.strictObject({
        event: z.literal('pull_request_review'),
        actions: z
          .array(githubReviewActionSchema)
          .min(1)
          .max(3)
          .refine(unique, 'Select each action once')
          .transform(actions => actions.sort()),
      }),
      z.strictObject({
        event: z.literal('pull_request_review_comment'),
        actions: z
          .array(githubCommentActionSchema)
          .min(1)
          .max(3)
          .refine(unique, 'Select each action once')
          .transform(actions => actions.sort()),
      }),
      z.strictObject({
        event: z.literal('issue_comment'),
        actions: z
          .array(githubCommentActionSchema)
          .min(1)
          .max(3)
          .refine(unique, 'Select each action once')
          .transform(actions => actions.sort()),
      }),
    ]),
  )
  .min(1)
  .max(4)
  .refine(events => unique(events.map(event => event.event)), 'Select each event once')
  .transform(events =>
    events.sort((left, right) => (left.event < right.event ? -1 : left.event > right.event ? 1 : 0)),
  );

const text = z.string().max(4000);
const githubUrl = z
  .url()
  .max(2048)
  .refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search
    );
  }, 'Use a GitHub.com HTTPS URL without credentials or query parameters');
export const githubEventFieldsSchema = z
  .strictObject({
    'repository.name': text,
    'repository.url': githubUrl,
    'pullRequest.number': z.number().int().positive(),
    'pullRequest.title': text,
    'pullRequest.url': githubUrl,
    'pullRequest.author': text,
    'pullRequest.state': z.enum(['open', 'closed', 'merged']),
    'pullRequest.baseBranch': branchName,
    'pullRequest.headBranch': branchName,
    'event.action': z.union([githubPullRequestActionSchema, githubReviewActionSchema, githubCommentActionSchema]),
    'review.state': z.enum(['approved', 'changes_requested', 'commented', 'dismissed', 'pending']),
    'review.body': text,
    'comment.body': text,
    'comment.url': githubUrl,
  })
  .partial();
export const githubEventFieldSchema = githubEventFieldsSchema.keyof();
export type GitHubEventFields = z.infer<typeof githubEventFieldsSchema>;
export type GitHubRepositorySelection = z.infer<typeof githubRepositorySelectionSchema>;
export type GitHubEventSelection = z.infer<typeof githubEventSelectionSchema>;
