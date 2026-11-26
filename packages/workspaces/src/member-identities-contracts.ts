import { z } from 'zod';
import { workspaceMemberIdSchema } from '@tulipfarm/tables/workspace-member-id';

export const memberIdentityTrustSchema = z.enum(['verified', 'manual']);
export type MemberIdentityTrust = z.infer<typeof memberIdentityTrustSchema>;

export const workspaceMemberIdentitySchema = z.object({
  id: z.uuid().nullable(),
  memberId: workspaceMemberIdSchema,
  membershipId: z.uuid().nullable(),
  provider: z.string(),
  providerLabel: z.string(),
  scope: z.string(),
  externalId: z.string().nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  aliases: z.array(z.string()),
  trust: memberIdentityTrustSchema,
  conflict: z.enum(['verified-elsewhere']).nullable(),
  profileUrl: z.string().nullable(),
  mention: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type WorkspaceMemberIdentity = z.infer<typeof workspaceMemberIdentitySchema>;

export const identityProviderInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  defaultScope: z.string().nullable(),
  handlePrefix: z.enum(['@']).nullable(),
  supportsManual: z.boolean(),
});
export type IdentityProviderInfo = z.infer<typeof identityProviderInfoSchema>;

export const workspaceMemberIdentitiesSchema = z.object({
  memberId: workspaceMemberIdSchema,
  canManage: z.boolean(),
  providers: z.array(identityProviderInfoSchema),
  identities: z.array(workspaceMemberIdentitySchema),
});
export type WorkspaceMemberIdentities = z.infer<typeof workspaceMemberIdentitiesSchema>;

export const addWorkspaceMemberIdentityInputSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  scope: z.string().max(128).nullable().optional(),
  externalId: z.string().max(128).nullable().optional(),
  handle: z.string().max(128).nullable().optional(),
  displayName: z.string().max(200).nullable().optional(),
});
export type AddWorkspaceMemberIdentityInput = z.infer<typeof addWorkspaceMemberIdentityInputSchema>;

export const updateWorkspaceMemberIdentityInputSchema = z.strictObject({
  externalId: z.string().max(128).nullable().optional(),
  handle: z.string().max(128).nullable().optional(),
  displayName: z.string().max(200).nullable().optional(),
});
export type UpdateWorkspaceMemberIdentityInput = z.infer<typeof updateWorkspaceMemberIdentityInputSchema>;

export const workspaceMemberIdentityResultSchema = z.object({
  identity: workspaceMemberIdentitySchema,
});
export type WorkspaceMemberIdentityResult = z.infer<typeof workspaceMemberIdentityResultSchema>;

export const removeWorkspaceMemberIdentityResultSchema = z.object({
  removed: z.literal(true),
});

export const searchWorkspaceMemberIdentitiesInputSchema = z.strictObject({
  q: z.string().max(200),
  provider: z.string().min(1).max(64).optional(),
  limit: z.int().min(1).max(100).optional(),
});
export type SearchWorkspaceMemberIdentitiesInput = z.infer<typeof searchWorkspaceMemberIdentitiesInputSchema>;

export const workspaceMemberIdentityMatchSchema = z.object({
  memberId: workspaceMemberIdSchema,
  membershipId: z.uuid().nullable(),
  identity: workspaceMemberIdentitySchema,
});
export type WorkspaceMemberIdentityMatch = z.infer<typeof workspaceMemberIdentityMatchSchema>;

export const workspaceMemberIdentitySearchSchema = z.object({
  matches: z.array(workspaceMemberIdentityMatchSchema),
});
export type WorkspaceMemberIdentitySearch = z.infer<typeof workspaceMemberIdentitySearchSchema>;
