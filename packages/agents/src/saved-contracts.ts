import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import {
  agentDefinitionSchema,
  definitionRevisionSchema,
  maximumTaskLimits,
  scopeSchema,
  taskLimitsSchema,
} from './contracts.ts';

export const soulRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const agentPermissionSchema = z.enum(['read', 'edit', 'delete', 'invoke', 'manage']);
export const saveAgentSchema = z.strictObject({
  requestId: uuidSchema,
  expectedSoulRevision: soulRevisionSchema,
  expectedSavedRevision: soulRevisionSchema.nullable(),
  owningTeamId: uuidSchema.nullable(),
  definition: agentDefinitionSchema,
});
export const agentProjectionSchema = z.strictObject({
  workspaceId: uuidSchema,
  commit: soulRevisionSchema,
  kind: z.literal('agent'),
  id: uuidSchema,
  path: z.string(),
  bucket: z.string(),
  key: z.string(),
  sha256: definitionRevisionSchema,
});
export const savedAgentSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  owningTeamId: uuidSchema.nullable(),
  savedRevision: soulRevisionSchema,
  definitionRevision: definitionRevisionSchema,
});
export const agentCommandStatusSchema = z.object({
  commandId: uuidSchema,
  agentId: uuidSchema,
  status: z.enum(['preparing', 'accepted', 'conflict', 'failed']),
  savedRevision: soulRevisionSchema.nullable(),
});
export const agentPolicySchema = z.strictObject({
  version: z.number().int().nonnegative(),
  owningTeamId: uuidSchema.nullable(),
  grants: z.array(z.strictObject({ teamId: uuidSchema, permissions: z.array(agentPermissionSchema).max(5) })).max(100),
  personGrants: z
    .array(z.strictObject({ membershipId: uuidSchema, permissions: z.array(agentPermissionSchema).max(5) }))
    .max(100),
});
export const agentContextSchema = z.object({
  currentSoulRevision: z.string(),
  teams: z.array(z.object({ id: z.uuid(), name: z.string() })),
  builtinSkills: z
    .array(z.object({ id: z.string(), name: z.string(), description: z.string(), revision: z.literal('latest') }))
    .default([]),
});
export const agentDetailSchema = savedAgentSchema.extend({
  definition: agentDefinitionSchema,
  capabilities: z.array(z.string()),
  activations: z.array(z.object({ id: z.uuid(), revision: z.string(), scope: scopeSchema })),
});
export const agentPolicyDetailSchema = agentPolicySchema.extend({
  enrollment: z.array(z.uuid()),
  enabled: z.boolean(),
  limits: scopeSchema,
  taskLimits: taskLimitsSchema.default(maximumTaskLimits),
  slackSender: z.enum(['user', 'app']).default('user'),
});
export const agentListSchema = z.object({
  agents: z.array(savedAgentSchema),
  count: z.number().optional(),
  nextCursor: z.uuid().nullable(),
});
export const definitionSharingCandidatesSchema = z.object({
  membershipId: uuidSchema,
  people: z.array(z.object({ membershipId: uuidSchema, userId: z.string(), name: z.string(), email: z.string() })),
  teams: z.array(z.object({ id: uuidSchema, name: z.string() })),
});
export class AgentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
