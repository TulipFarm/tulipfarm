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
  role: memberRoleSchema.default('member'),
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
export const policyPermissionSchema = z.enum([...tableGrantPermissionSchema.options, 'table.create']);
export type PolicyPermission = z.infer<typeof policyPermissionSchema>;
/** A table, or "create tables owned by team <id>". */
export const policyScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('table'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('collection'), id: z.uuid() }),
]);
export type PolicyScope = z.infer<typeof policyScopeSchema>;
export const policySubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('team'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('member'), id: z.uuid() }),
]);
const scopedPermissions = <T extends { scope: PolicyScope; permissions: PolicyPermission[] }>(value: T) =>
  value.permissions.every(permission => (permission === 'table.create') === (value.scope.kind === 'collection'));
const uniquePermissions = z
  .array(policyPermissionSchema)
  .max(6)
  .refine(values => new Set(values).size === values.length, 'Duplicate permission');
/** Sets the exact permissions one team or person holds on one scope; an empty list removes the policy. */
export const policyInputSchema = z
  .strictObject({ subject: policySubjectSchema, scope: policyScopeSchema, permissions: uniquePermissions })
  .refine(scopedPermissions, 'Create tables applies only to a team scope');
export const policyChangeSchema = z.object({
  added: z.array(policyPermissionSchema),
  removed: z.array(policyPermissionSchema),
});
export const invitationTeamSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(['member', 'manager']).default('member'),
});
export const invitationPolicySchema = z
  .strictObject({ scope: policyScopeSchema, permissions: uniquePermissions.min(1) })
  .refine(scopedPermissions, 'Create tables applies only to a team scope');
export const invitationChoicesSchema = z.strictObject({
  role: memberRoleSchema.default('member'),
  teams: z
    .array(invitationTeamSchema)
    .max(100)
    .refine(teams => new Set(teams.map(team => team.id)).size === teams.length, 'Duplicate team')
    .default([]),
  policies: z.array(invitationPolicySchema).max(100).default([]),
});
export type InvitationChoices = z.infer<typeof invitationChoicesSchema>;
export const invitationTeamEnrollmentSchema = z.strictObject({
  enrolled: z.boolean(),
  role: z.enum(['member', 'manager']).default('member'),
});
export const accessSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('admin') }),
  z.object({ kind: z.literal('team'), teamId: z.uuid(), teamName: z.string() }),
  z.object({ kind: z.literal('direct') }),
]);
export const effectivePolicySchema = z.object({
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('table'), id: z.uuid(), name: z.string() }),
    z.object({ kind: z.literal('collection'), id: z.uuid(), name: z.string() }),
  ]),
  permissions: z.array(policyPermissionSchema),
  source: accessSourceSchema,
});
export const skippedChoicesSchema = z.object({
  teams: z.array(z.object({ id: z.uuid(), name: z.string() })).default([]),
  policies: z.array(z.object({ scope: policyScopeSchema, name: z.string() })).default([]),
});
export const memberAccessSchema = z.object({
  member: directoryMemberSchema,
  self: z.boolean(),
  canManage: z.boolean(),
  canLeave: z.boolean(),
  finalAdmin: z.boolean(),
  teams: z.array(
    z.object({ id: z.uuid(), name: z.string(), role: z.enum(['member', 'manager']), canManage: z.boolean() }),
  ),
  policies: z.array(effectivePolicySchema),
  skipped: skippedChoicesSchema.nullable(),
});
export type MemberAccess = z.infer<typeof memberAccessSchema>;
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
  policyCount: z.number().int().nonnegative().default(0),
});
export type Team = z.infer<typeof teamSchema>;
export const governanceSnapshotSchema = z.object({
  actorMembershipId: z.uuid(),
  members: z.array(memberSchema),
  teams: z.array(teamSchema),
  directory: z.array(directoryMemberSchema),
  tableTeamIds: z.array(z.uuid()),
  // The internal team of workspace admins; it can receive table grants and own tables. Set only for admins.
  adminTeamId: z.uuid().nullable().default(null),
  tables: z.array(z.object({ id: z.uuid(), name: z.string(), owningTeamId: z.uuid() })),
  grants: z.array(z.object({ teamId: z.uuid(), target: grantTargetSchema })),
  // Names of every team the caller may see named: all teams for admins, otherwise their teams and grant destinations.
  teamNames: z.array(z.object({ id: z.uuid(), name: z.string() })).default([]),
  // Direct person grants, for admins.
  personGrants: z.array(personGrantSchema).default([]),
});
export type GovernanceSnapshot = z.infer<typeof governanceSnapshotSchema>;
export const ownMembershipSchema = z.object({
  membershipId: z.uuid(),
  role: memberRoleSchema,
  teams: z.array(z.object({ id: z.uuid(), name: z.string(), role: teamRoleSchema.default('member') })),
  // The internal team of workspace admins; set only when the caller belongs to it.
  adminTeamId: z.uuid().nullable().default(null),
  capabilities: z.object({ manageGovernance: z.boolean(), canLeave: z.boolean() }),
});
export type OwnMembership = z.infer<typeof ownMembershipSchema>;
export type GrantInput = z.infer<typeof grantInputSchema>;
export const invitationInputSchema = z.strictObject({
  kind: z.literal('email'),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  requestId: z.uuid(),
  workspaceMemberId: workspaceMemberIdSchema.optional(),
  role: invitationChoicesSchema.shape.role.optional(),
  teams: invitationChoicesSchema.shape.teams.optional(),
  policies: invitationChoicesSchema.shape.policies.optional(),
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
  createdAt: z.iso.datetime().optional(),
  revokedAt: z.iso.datetime().nullable().default(null),
  role: memberRoleSchema.default('member'),
  teams: z.array(z.object({ id: z.uuid(), role: z.enum(['member', 'manager']), name: z.string() })).default([]),
  policies: z
    .array(z.object({ scope: policyScopeSchema, permissions: z.array(policyPermissionSchema), name: z.string() }))
    .default([]),
  skipped: skippedChoicesSchema.nullable().default(null),
});
export const invitationTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
export const redeemInvitationSchema = z.strictObject({ token: invitationTokenSchema });
/** What a signed-out holder of an invitation link learns; the details appear only while the invitation is active. */
export const invitationDetailsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['expired', 'revoked', 'consumed']) }),
  z.object({
    status: z.literal('active'),
    email: z.email(),
    workspaceName: z.string(),
    hasAccount: z.boolean(),
  }),
]);
export const createdInvitationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('already-member') }),
  z.object({ outcome: z.enum(['created', 'pending', 'updated']), invitation: invitationSchema }),
]);
export const invitationListQuerySchema = z.object({
  after: z.uuid().optional(),
  // Only the latest active or expired invitation per address: the people who have not joined yet.
  open: z.enum(['true', 'false']).optional(),
  search: z.string().trim().toLowerCase().max(254).optional(),
});
export const invitationListSchema = z.object({ items: z.array(invitationSchema), nextCursor: z.uuid().nullable() });
export const joinedWorkspaceSchema = z.object({ workspaceId: z.uuid(), membershipId: z.uuid() });
export const governanceSuccessSchema = z.object({ ok: z.literal(true) });
