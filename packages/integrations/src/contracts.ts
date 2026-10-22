import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { githubInvestigationPermissionSchema } from '@tulipfarm/access/github-investigation';

export const repositorySchema = z.strictObject({
  id: uuidSchema,
  owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .refine(value => value !== '.' && value !== '..'),
});
const nameSchema = z.string().trim().min(1).max(120);
export const tokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const createIntegrationSchema = z
  .strictObject({
    id: uuidSchema,
    name: nameSchema,
    owningTeamId: uuidSchema,
    token: tokenSchema,
    repositories: z.array(repositorySchema).min(1).max(100),
  })
  .refine(
    value =>
      new Set(value.repositories.map(item => item.id)).size === value.repositories.length &&
      new Set(value.repositories.map(item => `${item.owner}/${item.repo}`.toLowerCase())).size ===
        value.repositories.length,
  );
export const rotateIntegrationSchema = z.strictObject({
  expectedGeneration: z.number().int().positive().max(2147483646),
  token: tokenSchema,
});
export const updateIntegrationSchema = z.strictObject({ name: nameSchema.optional(), enabled: z.boolean().optional() });
export const transferIntegrationSchema = z.strictObject({ owningTeamId: uuidSchema });
export const integrationCreationGrantsSchema = z.strictObject({
  owningTeamId: uuidSchema,
  teamIds: z.array(uuidSchema).max(100),
});
export const integrationCreationGrantsSnapshotSchema = integrationCreationGrantsSchema.extend({
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
export const updateCreationGrantsSchema = integrationCreationGrantsSchema.extend({
  expectedVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const integrationGrantSchema = z
  .strictObject({
    teamId: uuidSchema,
    permissions: z
      .array(z.enum(['read', 'use', 'manage']))
      .min(1)
      .max(3),
  })
  .refine(value => value.permissions.includes('read') && new Set(value.permissions).size === value.permissions.length);
export const sourceGrantSchema = z.strictObject({ teamId: uuidSchema, sourceId: uuidSchema });
export const integrationPersonGrantSchema = z
  .strictObject({
    memberId: uuidSchema,
    permissions: z
      .array(z.enum(['read', 'use', 'manage']))
      .min(1)
      .max(3),
  })
  .refine(value => value.permissions.includes('read') && new Set(value.permissions).size === value.permissions.length);
export const sourcePersonGrantSchema = z.strictObject({ memberId: uuidSchema, sourceId: uuidSchema });
const investigationPermissionsSchema = z
  .array(githubInvestigationPermissionSchema)
  .min(1)
  .max(6)
  .refine(value => new Set(value).size === value.length);
export const investigationGrantSchema = z.strictObject({
  teamId: uuidSchema,
  sourceId: uuidSchema,
  permissions: investigationPermissionsSchema,
});
export const investigationPersonGrantSchema = z.strictObject({
  memberId: uuidSchema,
  sourceId: uuidSchema,
  permissions: investigationPermissionsSchema,
});
export const integrationGrantsSchema = z.strictObject({
  expectedGrantsVersion: z.number().int().positive().max(2147483646),
  grants: z.array(integrationGrantSchema).max(100),
  sourceGrants: z.array(sourceGrantSchema).max(1000),
  personGrants: z.array(integrationPersonGrantSchema).max(1000).optional(),
  sourcePersonGrants: z.array(sourcePersonGrantSchema).max(1000).optional(),
  investigationGrants: z.array(investigationGrantSchema).max(1000).optional(),
  investigationPersonGrants: z.array(investigationPersonGrantSchema).max(1000).optional(),
});
export const readIssueSchema = z.strictObject({
  requestId: uuidSchema,
  integrationId: uuidSchema,
  sourceId: uuidSchema,
  issueNumber: z.number().int().positive().max(2147483647),
});
export const issueResultSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  body: z.string().max(65536),
  state: z.enum(['open', 'closed']),
  url: z.url(),
});
export const integrationCapabilitiesSchema = z.strictObject({
  read: z.boolean(),
  use: z.boolean(),
  manage: z.boolean(),
  administer: z.boolean(),
});
export const integrationMetadataSchema = z.strictObject({
  id: uuidSchema,
  name: nameSchema,
  owningTeamId: uuidSchema,
  enabled: z.boolean(),
  generation: z.number().int().positive(),
  grantsVersion: z.number().int().positive(),
  capabilities: integrationCapabilitiesSchema,
});
export const integrationDetailSchema = integrationMetadataSchema.extend({
  repositories: z.array(repositorySchema.extend({ canReadIssues: z.boolean() })),
  grants: z.array(integrationGrantSchema).optional(),
  sourceGrants: z.array(sourceGrantSchema).optional(),
  personGrants: z.array(integrationPersonGrantSchema).optional(),
  sourcePersonGrants: z.array(sourcePersonGrantSchema).optional(),
  investigationGrants: z.array(investigationGrantSchema).optional(),
  investigationPersonGrants: z.array(investigationPersonGrantSchema).optional(),
});
export const integrationListSchema = z.strictObject({ integrations: z.array(integrationMetadataSchema) });
export type IntegrationMetadata = z.infer<typeof integrationMetadataSchema>;
export type IntegrationDetail = z.infer<typeof integrationDetailSchema>;
export type IssueResult = z.infer<typeof issueResultSchema>;
export type ReadIssue = z.infer<typeof readIssueSchema>;
export type CreateIntegration = z.infer<typeof createIntegrationSchema>;
export class IntegrationError extends Error {
  readonly code: 'conflict' | 'in-progress' | 'provider-retryable' | 'provider-failed' | 'credential-unavailable';
  constructor(code: IntegrationError['code']) {
    super(`Integration operation ${code}`);
    this.code = code;
  }
}
