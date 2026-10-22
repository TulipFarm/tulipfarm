import { z } from 'zod';
import { sourceDependenciesSchema } from '@tulipfarm/access/source-dependencies';
import {
  boundedFileContent,
  decodeFileContent,
  fileChangeSchema,
  fileContentFields,
  filePathSchema,
} from './file-contracts.ts';
import { boundedReleaseUpload, releaseAssetFields, releaseUploadFields } from './release-contracts.ts';
import { discussionWriteSchemas } from './discussion-contracts.ts';
import { projectWriteSchemas } from './project-contracts.ts';

const repository = {
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine(value => value !== '.' && value !== '..'),
};
const target = { ...repository, issueNumber: z.number().int().positive().max(2147483647) };
const body = z.string().max(16000);
const identity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pullRepository = { ...repository, repositoryId: identity };
const pullTarget = { ...pullRepository, pullNumber: target.issueNumber, pullRequestId: identity };
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const ref = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/)
  .refine(
    value =>
      !value.includes('..') &&
      value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')),
    'Invalid branch',
  );
const login = repository.owner;
const fileTarget = { ...pullRepository, branch: ref, headSha: sha, message: z.string().min(1).max(1000) };
const releaseTarget = { ...pullRepository, releaseId: identity };
const releaseFields = {
  tagName: ref,
  targetCommitish: ref,
  name: z.string().min(1).max(256),
  body,
  prerelease: z.boolean(),
};
const existingRelease = { ...releaseTarget, expectedUpdatedAt: z.iso.datetime().nullable() };
const runTarget = { ...pullRepository, workflowId: identity, runId: identity, runAttempt: identity, headSha: sha };
export const githubWriteSchema = z.discriminatedUnion('kind', [
  ...projectWriteSchemas,
  ...discussionWriteSchemas,
  z.strictObject({
    kind: z.literal('actions.dispatch'),
    ...pullRepository,
    workflowId: identity,
    ref,
    inputs: z
      .record(z.string().min(1).max(100), z.union([z.string().max(4096), z.boolean(), z.number().finite()]))
      .refine(
        value => Object.keys(value).length <= 25 && new TextEncoder().encode(JSON.stringify(value)).length <= 16384,
        'At most 25 inputs and 16 KiB',
      ),
  }),
  z.strictObject({
    kind: z.literal('actions.rerun'),
    ...runTarget,
    expectedStatus: z.literal('completed'),
    mode: z.enum(['all', 'failed']),
  }),
  z.strictObject({
    kind: z.literal('actions.cancel'),
    ...runTarget,
    expectedStatus: z.enum(['queued', 'in_progress', 'requested', 'waiting', 'pending']),
  }),
  z.strictObject({ kind: z.literal('actions.artifact-delete'), ...pullRepository, artifactId: identity }),
  z.strictObject({ kind: z.literal('release.create'), ...pullRepository, ...releaseFields }),
  z.strictObject({ kind: z.literal('release.update'), ...existingRelease, ...releaseFields }),
  z.strictObject({
    kind: z.literal('release.publish'),
    ...existingRelease,
    ...releaseFields,
    assetIds: z.array(identity).max(30),
  }),
  z.strictObject({ kind: z.literal('release.delete'), ...existingRelease, assetIds: z.array(identity).max(30) }),
  z
    .strictObject({ kind: z.literal('release.asset-upload'), ...releaseTarget, ...releaseUploadFields })
    .refine(boundedReleaseUpload, 'Expected canonical base64 matching the exact byte size'),
  z.strictObject({
    kind: z.literal('release.asset-update'),
    ...pullRepository,
    assetId: identity,
    ...releaseAssetFields,
  }),
  z.strictObject({ kind: z.literal('release.asset-delete'), ...pullRepository, assetId: identity }),
  z
    .strictObject({ kind: z.literal('file.create'), ...fileTarget, path: filePathSchema, ...fileContentFields })
    .refine(boundedFileContent, 'Expected bounded UTF-8 text'),
  z
    .strictObject({
      kind: z.literal('file.update'),
      ...fileTarget,
      path: filePathSchema,
      blobSha: sha,
      ...fileContentFields,
    })
    .refine(boundedFileContent, 'Expected bounded UTF-8 text'),
  z.strictObject({ kind: z.literal('file.delete'), ...fileTarget, path: filePathSchema, blobSha: sha }),
  z
    .strictObject({ kind: z.literal('files.commit'), ...fileTarget, files: z.array(fileChangeSchema).min(1).max(8) })
    .refine(
      value =>
        value.files.every(
          (file, index) =>
            !value.files.some(
              (other, otherIndex) =>
                otherIndex !== index && (file.path === other.path || file.path.startsWith(`${other.path}/`)),
            ),
        ),
      'Overlapping file paths',
    ),
  z.strictObject({
    kind: z.literal('pull.create-fork'),
    ...pullRepository,
    title: z.string().min(1).max(256),
    body,
    headOwner: repository.owner,
    headRepo: repository.repo,
    headRepositoryId: identity,
    head: ref,
    headSha: sha,
    base: ref,
    draft: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('repository.create'),
    ...repository,
    ownerType: z.enum(['user', 'organization']),
    ownerId: identity,
    description: z.string().max(350),
    private: z.boolean(),
    autoInit: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('repository.settings'),
    ...pullRepository,
    description: z.string().max(350),
    private: z.boolean(),
    hasIssues: z.boolean(),
    hasWiki: z.boolean(),
    defaultBranch: ref,
  }),
  z.strictObject({ kind: z.literal('repository.rename'), ...pullRepository, name: repository.repo }),
  z.strictObject({ kind: z.literal('repository.archive'), ...pullRepository, archived: z.boolean() }),
  z.strictObject({ kind: z.literal('repository.delete'), ...pullRepository }),
  z.strictObject({ kind: z.enum(['branch.create', 'branch.delete']), ...pullRepository, branch: ref, headSha: sha }),
  z.strictObject({ kind: z.literal('issue.create'), ...repository, title: z.string().min(1).max(256), body }),
  z.strictObject({ kind: z.literal('issue.update'), ...target, title: z.string().min(1).max(256), body }),
  z.strictObject({ kind: z.literal('issue.comment'), ...target, body: body.min(1) }),
  z.strictObject({ kind: z.enum(['issue.close', 'issue.reopen']), ...target }),
  z.strictObject({
    kind: z.literal('pull.create'),
    ...pullRepository,
    title: z.string().min(1).max(256),
    body,
    head: ref,
    base: ref,
    draft: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('pull.update'), ...pullTarget, title: z.string().min(1).max(256), body, base: ref }),
  z.strictObject({ kind: z.literal('pull.comment'), ...pullTarget, body: body.min(1) }),
  z.strictObject({
    kind: z.literal('pull.review'),
    ...pullTarget,
    headSha: sha,
    event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: body.min(1),
  }),
  z
    .strictObject({
      kind: z.literal('pull.request-reviewers'),
      ...pullTarget,
      reviewers: z.array(login).max(15),
      teamReviewers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/)).max(15),
    })
    .refine(value => value.reviewers.length + value.teamReviewers.length > 0, 'Reviewers required'),
  z.strictObject({ kind: z.enum(['pull.close', 'pull.reopen']), ...pullTarget }),
  z.strictObject({
    kind: z.literal('pull.merge'),
    ...pullTarget,
    headSha: sha,
    base: ref,
    mergeMethod: z.enum(['merge', 'squash', 'rebase']),
    commitTitle: z.string().min(1).max(256),
    commitMessage: body,
  }),
]);
export type GitHubWrite = z.infer<typeof githubWriteSchema>;
export const githubBatchInputSchema = z.strictObject({
  actions: z
    .tuple([githubWriteSchema], githubWriteSchema)
    .refine(actions => actions.length <= 10, 'At most ten actions')
    .refine(
      actions =>
        actions.every(
          (action, index) =>
            action.kind !== 'repository.create' ||
            !actions.some(
              (other, otherIndex) =>
                otherIndex !== index &&
                'repo' in other &&
                other.owner.toLowerCase() === action.owner.toLowerCase() &&
                other.repo.toLowerCase() === action.repo.toLowerCase(),
            ),
        ),
      'Repository creation requires a separate proposal for dependent writes',
    )
    .refine(actions => {
      let count = 0,
        bytes = 0;
      for (const action of actions)
        if (action.kind === 'release.asset-upload') {
          count++;
          bytes += action.size;
        }
      for (const action of actions)
        for (const file of action.kind === 'files.commit'
          ? action.files
          : action.kind.startsWith('file.')
            ? [action]
            : []) {
          count++;
          if ('content' in file && 'encoding' in file) {
            try {
              bytes += new TextEncoder().encode(decodeFileContent(file)).length;
            } catch {
              return false;
            }
          }
        }
      return count <= 8 && bytes <= 16384;
    }, 'At most eight file changes or uploads and 16 KiB of content per batch'),
});
export const batchOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('chat'),
    conversationId: z.uuid(),
    turnId: z.uuid(),
    generation: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('task'),
    taskId: z.uuid(),
    callId: z.uuid(),
    generation: z.number().int().nonnegative(),
  }),
]);
export const batchSnapshotSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  membershipId: z.uuid(),
  commandId: z.uuid(),
  accountId: z.uuid(),
  generation: z.number().int().positive(),
  selectionVersion: z.number().int().positive(),
  origin: batchOriginSchema,
  sources: sourceDependenciesSchema,
  actions: githubBatchInputSchema.shape.actions,
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
});
export type BatchSnapshot = z.infer<typeof batchSnapshotSchema>;
export const batchDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
});
export const actionOutcomeSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  status: z.enum(['unattempted', 'succeeded', 'rejected', 'unknown']),
  result: z.json().nullable(),
  reconciliation: z.json().nullable(),
});
const recoveryEvidenceSchema = z.object({
  provider: z.literal('github'),
  checkedAt: z.iso.datetime(),
  outcome: z.enum(['confirmed-original-success', 'unresolved']),
});
const preparatoryEvidenceSchema = z.object({ phase: z.literal('ref-dispatch') });
export function actionEvidenceState(
  action: z.infer<typeof actionOutcomeSchema> | undefined,
): 'preparatory' | 'confirmed-original-success' | 'unresolved' | 'rejected' | null {
  if (!action || action.reconciliation === null || action.status === 'unattempted') return null;
  if (action.status === 'rejected') return 'rejected';
  const recovery = recoveryEvidenceSchema.safeParse(action.reconciliation);
  if (recovery.success) {
    if (
      action.status === 'succeeded' &&
      action.result !== null &&
      recovery.data.outcome === 'confirmed-original-success'
    )
      return 'confirmed-original-success';
    return action.status === 'unknown' ? 'unresolved' : null;
  }
  return preparatoryEvidenceSchema.safeParse(action.reconciliation).success ? 'preparatory' : null;
}
export const batchViewSchema = z.strictObject({
  snapshot: batchSnapshotSchema,
  digest: z.string(),
  decision: z.enum(['approve', 'reject']).nullable(),
  expired: z.boolean(),
  actions: z.array(actionOutcomeSchema),
});
export type BatchView = z.infer<typeof batchViewSchema>;
export const batchStatusSchema = z.strictObject({
  id: z.uuid(),
  decision: z.enum(['approve', 'reject']).nullable(),
  actions: z.array(actionOutcomeSchema.pick({ ordinal: true, status: true })),
});
export const batchDisplaySchema = z.union([batchViewSchema, batchStatusSchema]);
export class GitHubBatchError extends Error {
  readonly code:
    | 'batch-conflict'
    | 'batch-approval-required'
    | 'batch-unresolved'
    | 'batch-unavailable'
    | 'batch-expired'
    | 'batch-tool-limit'
    | 'selection-required';
  constructor(code: GitHubBatchError['code']) {
    super(code);
    this.code = code;
  }
}
