import { z } from 'zod';

const segment = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine(value => value !== '.' && value !== '..');
const repo = { owner: segment, repo: segment };
const page = {
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(30).default(10),
};
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_./-]+$/)
  .refine(value => value.split('/').every(part => part && part !== '.' && part !== '..'));
const query = z.string().trim().min(1).max(256);
const path = z
  .string()
  .max(1024)
  .refine(
    value =>
      value.split('/').every(part => part && part !== '.' && part !== '..') &&
      [...value].every(character => character >= ' ' && character !== String.fromCharCode(127) && character !== '\\'),
  );
const cursor = { after: z.string().min(1).max(1024).optional(), perPage: page.perPage };
const project = { owner: segment, ownerType: z.enum(['user', 'organization']) };
const nodeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_=-]+$/);
export const githubDownloadSchema = z.strictObject({
  kind: z.enum(['release.download', 'actions.artifact-download', 'actions.run-logs-download']),
  ...repo,
  id: number,
});
export type GitHubDownload = z.infer<typeof githubDownloadSchema>;
export const githubDownloadReceiptSchema = z.strictObject({
  id: z.uuid(),
  operation: githubDownloadSchema,
  filename: z.string().regex(/^[A-Za-z0-9_.-]{1,180}$/),
  size: z.number().int().min(1).max(10485760),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const githubReadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('repository.read'), ...repo }),
  z.strictObject({ kind: z.enum(['repository.search', 'file.search', 'issue.search', 'pull.search']), query, ...page }),
  z.strictObject({ kind: z.enum(['file.read', 'file.content']), ...repo, path, ref: ref.optional() }),
  z.strictObject({
    kind: z.literal('file.list'),
    ...repo,
    path: path.or(z.literal('')).default(''),
    ref: ref.optional(),
    ...page,
  }),
  z.strictObject({
    kind: z.enum(['branch.list', 'release.list', 'actions.workflows', 'actions.runs', 'actions.artifacts']),
    ...repo,
    ...page,
  }),
  z.strictObject({ kind: z.literal('branch.read'), ...repo, branch: ref }),
  z.strictObject({
    kind: z.literal('pull.list'),
    ...repo,
    state: z.enum(['open', 'closed', 'all']).default('open'),
    ...page,
  }),
  z.strictObject({ kind: z.enum(['pull.read', 'pull.diff', 'issue.read', 'discussion.read']), ...repo, number }),
  z.strictObject({
    kind: z.enum([
      'pull.files',
      'pull.reviews',
      'pull.comments',
      'pull.review-comments',
      'pull.commits',
      'pull.checks',
      'pull.status',
      'issue.comments',
    ]),
    ...repo,
    number,
    ...page,
  }),
  z.strictObject({ kind: z.enum(['commit.checks', 'commit.status']), ...repo, ref, ...page }),
  z.strictObject({
    kind: z.enum([
      'release.read',
      'release.asset',
      'actions.workflow',
      'actions.run',
      'actions.artifact',
      'actions.logs',
    ]),
    ...repo,
    id: number,
  }),
  z.strictObject({ kind: z.enum(['release.assets', 'actions.jobs']), ...repo, id: number, ...page }),
  z.strictObject({ kind: z.literal('project.list'), ...project, query: query.optional(), ...cursor }),
  z.strictObject({ kind: z.literal('project.read'), ...project, number }),
  z.strictObject({ kind: z.enum(['project.fields', 'project.items']), ...project, number, ...cursor }),
  z.strictObject({ kind: z.literal('project.item'), ...project, number, itemId: nodeId, ...cursor }),
  z.strictObject({
    kind: z.literal('project.item-field'),
    ...project,
    number,
    itemId: nodeId,
    fieldName: z.string().min(1).max(256),
    ...cursor,
  }),
  z.strictObject({ kind: z.enum(['discussion.list', 'discussion.categories']), ...repo, ...cursor }),
  z.strictObject({ kind: z.literal('discussion.search'), query, ...cursor }),
  z.strictObject({ kind: z.literal('discussion.comments'), ...repo, number, ...cursor }),
  z.strictObject({ kind: z.literal('discussion.replies'), ...repo, number, commentId: nodeId, ...cursor }),
]);
export type GitHubRead = z.infer<typeof githubReadSchema>;
