import { z } from 'zod';
import { workspaceMemberIdSchema } from '@tulipfarm/tables/workspace-members';

export const memberRoleSchema = z.enum(['admin', 'member']);
export const teamInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine(name => !name.startsWith('_'), 'Team names starting with _ are reserved'),
  description: z.string().trim().max(1000).default(''),
});
export const teamUpdateSchema = teamInputSchema.extend({
  expected: z.strictObject({ name: z.string(), description: z.string() }),
});
export const leaveTeamInputSchema = z.strictObject({});
export const memberRoleInputSchema = z.strictObject({ role: memberRoleSchema });
export const enrollmentInputSchema = z.strictObject({ enrolled: z.boolean() });
export const teamRoleSchema = z.enum(['member', 'manager']);
export const teamRoleInputSchema = z.strictObject({ role: teamRoleSchema });
export const directoryMemberSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  image: z.string().nullable(),
});
export const collaborationDirectorySchema = z.object({ members: z.array(directoryMemberSchema) });
export const tableGrantPermissionSchema = z.enum([
  'table.schema.manage',
  'table.row.create',
  'table.row.read',
  'table.row.update',
  'table.row.delete',
]);
export const grantTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('table'), id: z.uuid(), permission: tableGrantPermissionSchema }),
  z.strictObject({ kind: z.literal('collection'), id: z.uuid(), permission: z.literal('table.create') }),
]);
export const grantInputSchema = z.strictObject({ teamId: z.uuid(), target: grantTargetSchema, granted: z.boolean() });
export const personGrantSchema = z.strictObject({ membershipId: z.uuid(), target: grantTargetSchema });
export const personGrantInputSchema = personGrantSchema.extend({ granted: z.boolean() });
export const personGrantListSchema = z.object({ grants: z.array(personGrantSchema) });
export type PersonGrantInput = z.infer<typeof personGrantInputSchema>;
export const memberSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  role: memberRoleSchema,
  name: z.string(),
  email: z.email(),
});
export const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  membershipIds: z.array(z.uuid()),
  managerIds: z.array(z.uuid()),
  canManage: z.boolean(),
  canLeave: z.boolean(),
});
export type Team = z.infer<typeof teamSchema>;
export const governanceSnapshotSchema = z.object({
  actorMembershipId: z.uuid(),
  members: z.array(memberSchema),
  teams: z.array(teamSchema),
  directory: z.array(directoryMemberSchema),
  tableTeamIds: z.array(z.uuid()),
  tables: z.array(z.object({ id: z.uuid(), name: z.string(), owningTeamId: z.uuid() })),
  grants: z.array(z.object({ teamId: z.uuid(), target: grantTargetSchema })),
});
export type GovernanceSnapshot = z.infer<typeof governanceSnapshotSchema>;
export const ownMembershipSchema = z.object({
  membershipId: z.uuid(),
  role: memberRoleSchema,
  teams: z.array(z.object({ id: z.uuid(), name: z.string(), role: teamRoleSchema.default('member') })),
  capabilities: z.object({ manageGovernance: z.boolean(), canLeave: z.boolean() }),
});
export type OwnMembership = z.infer<typeof ownMembershipSchema>;
export type GrantInput = z.infer<typeof grantInputSchema>;
export const invitationInputSchema = z.strictObject({
  kind: z.literal('email'),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  requestId: z.uuid(),
  workspaceMemberId: workspaceMemberIdSchema.optional(),
});
export const resendInvitationSchema = z.strictObject({
  requestId: z.uuid(),
  workspaceMemberId: workspaceMemberIdSchema.optional(),
});
export const invitationLinkSchema = z.object({ url: z.url() });
export const invitationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['share', 'email']),
  email: z.email().nullable(),
  expiresAt: z.iso.datetime(),
  status: z.enum(['active', 'expired', 'revoked', 'consumed']),
  delivery: z.enum(['pending', 'sending', 'failed', 'sent', 'cancelled']).nullable().default(null),
  canCopy: z.boolean().default(false),
  workspaceMemberId: workspaceMemberIdSchema.nullable().default(null),
});
export const invitationTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
export const redeemInvitationSchema = z.strictObject({ token: invitationTokenSchema });
export const createdInvitationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('already-member') }),
  z.object({ outcome: z.enum(['created', 'pending']), invitation: invitationSchema }),
]);
export const invitationListQuerySchema = z.object({
  after: z.uuid().optional(),
  search: z.string().trim().toLowerCase().max(254).optional(),
});
export const invitationListSchema = z.object({ items: z.array(invitationSchema), nextCursor: z.uuid().nullable() });
export const joinedWorkspaceSchema = z.object({ workspaceId: z.uuid(), membershipId: z.uuid() });
export const governanceSuccessSchema = z.object({ ok: z.literal(true) });
