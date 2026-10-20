import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { sourceDependenciesSchema } from '@tulipfarm/access/source-dependencies';
import { skillSelectionSchema } from './skill-ids.ts';
import { skillPackageSchema } from './skill-package-contracts.ts';

export const workspaceSkillDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(280).optional(),
  instructions: z.string().trim().min(1).max(32000),
  package: skillPackageSchema.optional(),
});
export const workspaceSkillWriteDefinitionSchema = workspaceSkillDefinitionSchema.refine(
  definition => definition.description !== undefined || definition.package !== undefined,
  'A procedure description or package metadata description is required',
);
export const workspaceSkillRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceSkillSummarySchema = z.object({
  id: uuidSchema,
  revision: z.string(),
  name: z.string(),
  description: z.string().max(1024).default(''),
  source: z.string().default('Legacy skill'),
  status: z.enum(['enabled', 'disabled', 'needs-review', 'archived']).default('enabled'),
});
export const procedureSelectionSchema = z.union([
  skillSelectionSchema,
  z.strictObject({ id: uuidSchema, revision: workspaceSkillRevisionSchema }),
]);
export const procedureSelectionsSchema = z
  .array(procedureSelectionSchema)
  .max(16)
  .refine(
    items => items.every(item => item.id !== 'planning'),
    'Planning requires the default chat agent and its plan tools.',
  )
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Select each skill once');
export const resolvedProcedureSchema = z.strictObject({
  id: z.string(),
  revision: z.string(),
  ...workspaceSkillDefinitionSchema.shape,
  sources: sourceDependenciesSchema.optional(),
});
export const resolvedProceduresSchema = z.array(resolvedProcedureSchema).max(16);
export const workspaceSkillQuerySchema = z.strictObject({
  after: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  view: z.enum(['visible', 'reviewed', 'archived']).default('visible'),
  search: z.string().trim().max(120).default(''),
});
export const workspaceSkillLifecycleSchema = z.enum(['active', 'archived', 'deleted']);
const command = { requestId: uuidSchema, expectedVersion: z.number().int().nonnegative() };
export const saveWorkspaceSkillSchema = z.strictObject({ ...command, definition: workspaceSkillWriteDefinitionSchema });
export const reviewWorkspaceSkillSchema = z.strictObject({ ...command, revision: workspaceSkillRevisionSchema });
export const enableWorkspaceSkillSchema = z.strictObject({ ...command, enabled: z.boolean() });
const skillPermissions = z.array(z.enum(['read', 'use', 'manage'])).max(3);
export const skillSharingSchema = z.strictObject({
  version: z.number().int().positive(),
  grants: z.array(z.strictObject({ teamId: uuidSchema, permissions: skillPermissions })).max(100),
  personGrants: z.array(z.strictObject({ membershipId: uuidSchema, permissions: skillPermissions })).max(100),
});
export const setWorkspaceSkillLifecycleSchema = z.strictObject({
  ...command,
  lifecycle: workspaceSkillLifecycleSchema,
});
export const workspaceSkillReceiptSchema = z.strictObject({
  id: uuidSchema,
  version: z.number().int().positive(),
  savedRevision: workspaceSkillRevisionSchema,
  activeRevision: workspaceSkillRevisionSchema.nullable(),
  enabled: z.boolean(),
  lifecycle: workspaceSkillLifecycleSchema.exclude(['active']).optional(),
});
export const skillPinUseSchema = z.enum(['active-revision', 'open-run', 'open-task', 'saved-definition']);
export const workspaceSkillDeletionSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  version: z.number().int().positive(),
  lifecycle: z.enum(['active', 'archived']),
  blockers: z
    .array(
      z.strictObject({ agentId: uuidSchema, name: z.string().nullable(), uses: z.array(skillPinUseSchema).min(1) }),
    )
    .max(20),
  hiddenAgents: z.number().int().nonnegative(),
  blockerCount: z.number().int().nonnegative(),
});
export type WorkspaceSkillDeletion = z.infer<typeof workspaceSkillDeletionSchema>;
export class WorkspaceSkillError extends Error {
  readonly code:
    | 'version-conflict'
    | 'idempotency-conflict'
    | 'review-required'
    | 'limit-reached'
    | 'skill-in-use'
    | 'skill-archived';
  constructor(code: WorkspaceSkillError['code']) {
    super(code);
    this.code = code;
  }
}
