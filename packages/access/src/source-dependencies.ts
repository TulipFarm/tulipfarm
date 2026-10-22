import { z } from 'zod';
import { uuidSchema } from './contracts.ts';
import { githubReadSchema, githubDownloadReceiptSchema } from './github-read.ts';
import { githubInvestigationPermissionSchema } from './github-investigation.ts';

export const integrationSourceDependencySchema = z.strictObject({
  kind: z.literal('integration-source'),
  integrationId: uuidSchema,
  sourceId: uuidSchema,
});
const projectIdentitySchema = z.strictObject({
  projectId: z.string(),
  projectNumber: z.number().int().positive(),
  ownerNodeId: z.string(),
  owner: z.string(),
  ownerType: z.enum(['user', 'organization']),
  repositories: z
    .array(
      z.object({
        id: z.string(),
        databaseId: z.number(),
        nameWithOwner: z.string(),
        owner: z.object({ id: z.string(), login: z.string() }),
      }),
    )
    .max(30),
  deleted: z.literal(true).optional(),
});
export const mcpSourceDependencySchema = z.strictObject({
  kind: z.literal('mcp-integration'),
  integrationId: uuidSchema,
  authorizationEpoch: z.number().int().positive(),
});
export const privateTaskSourceDependencySchema = z.strictObject({
  kind: z.literal('private-task'),
  taskId: uuidSchema,
});
export const fileReadReceiptSchema = z.strictObject({
  readAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  representation: z.enum(['text', 'extracted', 'metadata']),
});
export type FileReadReceipt = z.infer<typeof fileReadReceiptSchema>;
/** A chat-scoped read of a TulipFarm file. Only the member who referenced the file in that chat can rely on it. */
export const tulipfarmFileSourceSchema = z.strictObject({
  kind: z.literal('tulipfarm-file'),
  fileId: uuidSchema,
  conversationId: uuidSchema,
  membershipId: uuidSchema,
  read: fileReadReceiptSchema,
});
/**
 * A chat-scoped read of a Google Drive file through the sender's Google integration, bound to the integration generation the
 * reference was sent with. `revision` is what Google reported for the content read; Google decides who can open the file.
 */
const googleFileIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
const googleBinding = {
  integrationId: uuidSchema,
  accountId: z.string().min(1).max(512),
  generation: z.number().int().positive(),
};
export const googleFileReadReceiptSchema = z.strictObject({
  readAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  representation: z.enum(['export', 'text', 'extracted', 'metadata']),
  version: z.string().max(64).optional(),
  modifiedTime: z.iso.datetime().optional(),
});
export type GoogleFileReadReceipt = z.infer<typeof googleFileReadReceiptSchema>;
export const googleFileSourceSchema = z.strictObject({
  kind: z.literal('google-file'),
  fileId: googleFileIdSchema,
  conversationId: uuidSchema,
  membershipId: uuidSchema,
  ...googleBinding,
  read: googleFileReadReceiptSchema,
});
/**
 * A Google Drive file a task owner gave an agent task. TulipFarm bound it to the owner's Google integration when the task
 * received it; the owner never supplies the binding. Only the task runtime writes `read`, the receipt of the content a step was given.
 */
export const taskGoogleFileSourceSchema = z.strictObject({
  kind: z.literal('google-drive-file'),
  fileId: googleFileIdSchema,
  ...googleBinding,
  read: googleFileReadReceiptSchema.optional(),
});
export const knowledgeSourceDependencySchema = z.strictObject({
  kind: z.literal('knowledge-document'),
  workspaceId: uuidSchema,
  sourceId: uuidSchema,
  documentId: uuidSchema,
  revisionId: uuidSchema,
  publicationId: uuidSchema,
  accessEpoch: z.number().int().positive(),
});
const githubPersonalFields = {
  kind: z.literal('github-personal'),
  accountId: uuidSchema,
  membershipId: uuidSchema,
  generation: z.number().int().positive(),
  selectionVersion: z.number().int().positive(),
  proof: z
    .strictObject({
      operation: githubReadSchema,
      transport: z.enum(['rest', 'graphql', 'official-mcp']),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      accessTargets: z.array(githubReadSchema).max(30).optional(),
      projectIdentity: projectIdentitySchema.optional(),
      projectList: z
        .strictObject({ ownerNodeId: z.string(), projects: z.array(projectIdentitySchema).max(30) })
        .optional(),
      discussionIdentity: z
        .strictObject({
          discussionId: z.string(),
          repositoryNodeId: z.string(),
          repositoryId: z.number().int().positive(),
          ownerNodeId: z.string(),
        })
        .optional(),
      download: githubDownloadReceiptSchema.optional(),
    })
    .optional(),
};
export const githubPersonalSourceSchema = z.discriminatedUnion('origin', [
  z.strictObject({ ...githubPersonalFields, origin: z.literal('chat').optional(), conversationId: uuidSchema }),
  z.strictObject({
    ...githubPersonalFields,
    origin: z.literal('task'),
    taskId: uuidSchema,
    taskGeneration: z.number().int().nonnegative(),
    batchId: uuidSchema.optional(),
  }),
]);
export const sourceDependencySchema = z.discriminatedUnion('kind', [
  mcpSourceDependencySchema,
  privateTaskSourceDependencySchema,
  knowledgeSourceDependencySchema,
  tulipfarmFileSourceSchema,
  googleFileSourceSchema,
  z.strictObject({ kind: z.literal('table'), tableId: uuidSchema }),
  z.strictObject({ kind: z.literal('table-rows'), tableId: uuidSchema, revision: z.string() }),
  z.strictObject({ kind: z.literal('table-schema'), tableId: uuidSchema, revision: z.string() }),
  integrationSourceDependencySchema,
  githubPersonalSourceSchema,
  z.strictObject({
    kind: z.literal('github-source'),
    integrationId: uuidSchema,
    sourceId: uuidSchema,
    generation: z.number().int(),
    grantsVersion: z.number().int(),
    requiredPermissions: z.array(githubInvestigationPermissionSchema).min(1).max(6).optional(),
    readProof: z
      .strictObject({ operation: githubReadSchema, accessTargets: z.array(githubReadSchema).max(30).optional() })
      .optional(),
    investigation: z
      .strictObject({
        membershipId: uuidSchema,
        selectionVersion: z.number().int().positive(),
        origin: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('chat'), conversationId: uuidSchema }),
          z.strictObject({ kind: z.literal('task'), taskId: uuidSchema, generation: z.number().int().nonnegative() }),
        ]),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('atlassian-source'),
    sourceId: uuidSchema,
    accountId: uuidSchema,
    membershipId: uuidSchema,
    generation: z.number().int(),
    grantsVersion: z.number().int(),
    binding: z.string(),
  }),
  z.strictObject({
    kind: z.literal('google-integration'),
    integrationId: uuidSchema,
    accountId: z.string(),
    membershipId: uuidSchema,
    generation: z.number().int(),
    scopes: z.array(z.string()),
    requiredScopes: z.array(z.string()),
  }),
  z.strictObject({ kind: z.literal('agent-definition'), agentId: uuidSchema, revision: z.string() }),
  z.strictObject({ kind: z.literal('workflow-definition'), workflowId: uuidSchema, revision: uuidSchema }),
  z.strictObject({
    kind: z.literal('workflow-provider'),
    integrationId: uuidSchema,
    generation: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal('workspace-skill'), skillId: uuidSchema, revision: z.string() }),
  z.strictObject({ kind: z.literal('creation-team'), teamId: uuidSchema, authority: z.enum(['agent', 'table']) }),
  z.strictObject({ kind: z.literal('private-conversation'), conversationId: uuidSchema }),
  z.strictObject({ kind: z.literal('shared-slack-turn'), eventId: uuidSchema }),
  z.strictObject({ kind: z.literal('public-web'), url: z.url().max(2048) }),
  /** The requester's own saved personal memory; valid only for that membership. */
  z.strictObject({ kind: z.literal('personal-memory'), membershipId: uuidSchema }),
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export type SourceDependency = z.infer<typeof sourceDependencySchema>;
export const sourceDependenciesSchema = z.array(sourceDependencySchema).max(1000);
