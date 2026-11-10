import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { canonicalEmail, canonicalEmailSql } from './canonical-email.ts';
import { encryptEmailDelivery, type EmailDeliveryKeys } from './email-delivery.ts';
import { decryptInvitationCopy, encryptInvitationCopy } from './invitation-copy.ts';
import {
  AccessDenied,
  currentMember,
  departureNeedsManagerHandoff,
  lockAuthorization,
  resolveHuman,
  requireTeamManager,
  tablePersonGrantsInstalled,
  type AuthorizationTransaction,
  type HumanActor,
  type ManagerDeparture,
} from '@tulipfarm/access';
import { afterCommit, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { emitHook } from '@tulipfarm/extensions';
import { trackEvent } from '@tulipfarm/observability';
import {
  activeRecommendationMembers,
  recordRecommendationChange,
  scheduleRecommendationExpiry,
} from '@tulipfarm/workspace-storage/recommendations';
import {
  projectWorkspaceMemberProfile,
  refreshWorkspaceMemberAccess,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import { memberProfileSchema, WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import { bindWorkspaceMemberAccount, requireWorkspaceMemberInvitation } from './member-links.ts';
import {
  collaborationDirectorySchema,
  teamRoleInputSchema,
  enrollmentInputSchema,
  governanceSnapshotSchema,
  grantInputSchema,
  personGrantInputSchema,
  personGrantListSchema,
  invitationInputSchema,
  invitationListQuerySchema,
  invitationDetailsSchema,
  invitationSchema,
  invitationTokenSchema,
  memberRoleInputSchema,
  ownMembershipSchema,
  resendInvitationSchema,
  teamInputSchema,
  teamUpdateSchema,
  invitationChoicesSchema,
  invitationTeamEnrollmentSchema,
  memberAccessSchema,
  policyChangeSchema,
  policyInputSchema,
  skippedChoicesSchema,
  type InvitationChoices,
  type PolicyPermission,
  type PolicyScope,
} from './governance-contracts.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Transaction = AuthorizationTransaction & { workspaceId: string };
const memberRowSchema = z.object({ id: z.uuid(), user_id: z.string(), role: z.enum(['admin', 'member']) });
const profileSchema = z.object({ id: z.string(), name: z.string(), email: z.email(), email_verified: z.boolean() });
const invitationRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['share', 'email']),
  email: z.string().nullable(),
  expires_at: z.date(),
  revoked_at: z.date().nullable(),
  consumed_membership_id: z.uuid().nullable(),
  expired: z.boolean(),
  copy_material: z.unknown(),
  predecessor_id: z.uuid().nullable(),
  workspace_member_id: z.uuid().nullable().default(null),
  created_at: z.date().optional(),
  role: z.enum(['admin', 'member']).default('member'),
  assignments: z.unknown().optional(),
  skipped: z.unknown().optional(),
});
const storedTeamSchema = z.object({ id: z.uuid(), role: z.enum(['member', 'manager']), name: z.string() });
const storedPolicySchema = z.object({
  scope: z.object({ kind: z.enum(['table', 'collection', 'owned']), id: z.uuid() }),
  permissions: z.array(z.string()),
  name: z.string(),
});
const assignmentsSchema = z
  .object({ teams: z.array(storedTeamSchema).default([]), policies: z.array(storedPolicySchema).default([]) })
  .catch({ teams: [], policies: [] });
type Assignments = z.infer<typeof assignmentsSchema>;
const tablePermissions = [
  'table.schema.manage',
  'table.row.create',
  'table.row.read',
  'table.row.update',
  'table.row.delete',
] as const;
const policyPermissions = ['table.create', ...tablePermissions];
const success = { ok: true } as const;

export class GovernanceConflict extends Error {
  constructor(
    readonly code:
      | 'final-team-manager'
      | 'manager-handoff-required'
      | 'team-details-conflict'
      | 'duplicate-team-name'
      | 'final-admin'
      | 'team-owns-tables'
      | 'team-owns-archived-tables'
      | 'team-owns-agents'
      | 'team-owns-integrations'
      | 'team-id-conflict'
      | 'team-id-retired'
      | 'teams-unavailable'
      | 'person-grants-unavailable'
      | 'invitations-unavailable'
      | 'invitation-request-conflict'
      | 'invitation-account-exists'
      | 'invitation-expired',
  ) {
    super(code);
  }
}

export function createGovernanceService(dependencies: {
  runtime: Runtime;
  identity: Pick<Pool, 'query'>;
  compatibility: { minimum: number; maximum: number };
  emailDelivery?: { keys: EmailDeliveryKeys; webOrigin: string };
  // Password sign-up cannot prove an address on an instance without email; the invitation token is the proof instead.
  acceptUnverifiedEmail?: boolean;
}) {
  const table = (transaction: Transaction, name: string) => qualified(transaction.schema, name);

  async function withHuman<T>(
    workspaceId: string,
    userId: string,
    mode: 'read' | 'write',
    admin: boolean,
    operation: (transaction: Transaction, actor: HumanActor) => Promise<T>,
  ) {
    return dependencies.runtime.transaction(
      z.uuid().parse(workspaceId).toLowerCase(),
      dependencies.compatibility,
      async transaction => {
        await lockAuthorization(transaction, mode);
        const actor = await resolveHuman(transaction, userId);
        const member = await currentMember(transaction, actor);
        if (admin && member.role !== 'admin') throw new AccessDenied();
        try {
          return await operation(transaction, actor);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505' &&
            'constraint' in error &&
            error.constraint === 'tf_teams_normalized_name'
          )
            throw new GovernanceConflict('duplicate-team-name');
          throw error;
        }
      },
    );
  }

  async function audit(transaction: Transaction, actor: HumanActor, operation: string, subjectId: string) {
    await transaction.client.query(
      `INSERT INTO ${table(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), actor.membershipId, operation, subjectId],
    );
  }

  async function recommendationChange(
    transaction: Transaction,
    sourceId: string,
    membershipIds: string[],
    invalidate = false,
  ) {
    await recordRecommendationChange(transaction, {
      id: randomUUID(),
      kind: 'membership',
      sourceId,
      membershipIds,
      invalidate,
    });
  }

  /** Members who hold an "every table this team owns" policy on any of these teams, through a team or directly. */
  async function ownedPolicyHolders(transaction: Transaction, teamIds: string[]) {
    const person = (await tablePersonGrantsInstalled(transaction))
      ? `UNION SELECT pg.membership_id FROM ${table(transaction, 'tf_table_person_grants')} pg
        WHERE pg.asset_id = ANY($1::uuid[]) AND pg.permission <> 'table.create'`
      : '';
    return z
      .array(z.object({ membership_id: z.uuid() }))
      .parse(
        (
          await transaction.client.query(
            `SELECT mt.membership_id FROM ${table(transaction, 'tf_member_teams')} mt
            JOIN ${table(transaction, 'tf_grants')} g ON g.team_id = mt.team_id
            WHERE g.asset_id = ANY($1::uuid[]) AND g.permission <> 'table.create' ${person}`,
            [teamIds],
          )
        ).rows,
      )
      .map(row => row.membership_id);
  }

  async function teamMembers(transaction: Transaction, teamId: string) {
    return z
      .array(z.object({ id: z.uuid() }))
      .parse(
        (
          await transaction.client.query(
            `SELECT m.id FROM ${table(transaction, 'tf_memberships')} m JOIN ${table(transaction, 'tf_member_teams')} mt ON mt.membership_id=m.id
       WHERE mt.team_id=$1 AND m.removed_at IS NULL ORDER BY m.id`,
            [teamId],
          )
        ).rows,
      )
      .map(member => member.id);
  }

  // Internal teams (names starting with _) are not user-editable and never listed.
  const notInternal = (alias: string) => `${alias}.name NOT LIKE '\\_%'`;
  // A grant whose asset is a team means "create tables owned by" it (table.create) or "every table it owns".
  const grantKind = (grant: { permission: string; owned: boolean }) =>
    grant.permission === 'table.create' ? 'collection' : grant.owned ? 'owned' : 'table';
  const ownedSql = (relation: string, alias: string) =>
    `EXISTS (SELECT 1 FROM ${relation} ot WHERE ot.id = ${alias}.asset_id) AS owned`;

  async function teamExists(transaction: Transaction, id: string) {
    const result = await transaction.client.query(
      `SELECT id FROM ${table(transaction, 'tf_teams')} t WHERE t.id = $1 AND ${notInternal('t')}`,
      [z.uuid().parse(id)],
    );
    if (!result.rowCount) throw new AccessDenied();
  }

  // Grants may also go to the internal team of workspace admins, which is never a table owner or destination.
  async function grantTeamExists(transaction: Transaction, id: string) {
    const result = await transaction.client.query(
      `SELECT id FROM ${table(transaction, 'tf_teams')} t WHERE t.id = $1 AND (${notInternal('t')} OR t.name = '_admin')`,
      [z.uuid().parse(id)],
    );
    if (!result.rowCount) throw new AccessDenied();
  }

  async function activeMember(transaction: Transaction, id: string) {
    const result = await transaction.client.query(
      `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`,
      [z.uuid().parse(id)],
    );
    const member = memberRowSchema.optional().parse(result.rows[0]);
    if (!member) throw new AccessDenied();
    return member;
  }

  async function protectFinalAdmin(transaction: Transaction, member: z.infer<typeof memberRowSchema>) {
    if (member.role !== 'admin') return;
    const remaining = await transaction.client.query(
      `SELECT id FROM ${table(transaction, 'tf_memberships')} WHERE role = 'admin' AND removed_at IS NULL AND id <> $1 LIMIT 1`,
      [member.id],
    );
    if (!remaining.rowCount) throw new GovernanceConflict('final-admin');
  }

  async function remove(transaction: Transaction, actor: HumanActor, membershipId: string) {
    const member = await activeMember(transaction, membershipId);
    await protectFinalAdmin(transaction, member);
    // Leaving voluntarily requires a handoff. An admin's forced removal leaves managerless items locked.
    if (membershipId === actor.membershipId) {
      await protectFinalTeamManager(transaction, membershipId);
      await protectManagerHandoff(transaction, { kind: 'member', membershipId });
    }
    await transaction.client.query(`DELETE FROM ${table(transaction, 'tf_member_teams')} WHERE membership_id = $1`, [
      membershipId,
    ]);
    await transaction.client.query(
      `UPDATE ${table(transaction, 'tf_memberships')} SET removed_at = clock_timestamp() WHERE id = $1`,
      [membershipId],
    );
    const registered = await workspaceMembersTable(transaction);
    const changedMembers = new Set<string>();
    if (registered) {
      const linked = (
        await transaction.client.query(
          `SELECT member_id FROM ${table(transaction, 'tf_workspace_member_accounts')}
        WHERE membership_id=$1`,
          [membershipId],
        )
      ).rows[0];
      if (linked) changedMembers.add(z.uuid().parse(linked.member_id));
    }
    if (
      (
        await transaction.client.query(
          `SELECT 1 FROM ${table(transaction, 'tf_invitations')} WHERE revoked_at IS NULL AND consumed_membership_id IS NULL LIMIT 1`,
        )
      ).rowCount
    ) {
      const identity = profileSchema
        .optional()
        .parse(
          (
            await dependencies.identity.query('SELECT id, name, email, email_verified FROM app.users WHERE id = $1', [
              member.user_id,
            ])
          ).rows[0],
        );
      if (identity) {
        const cancelled = z
          .array(z.object({ id: z.uuid(), workspace_member_id: z.uuid().nullable().default(null) }))
          .parse(
            (
              await transaction.client.query(
                `UPDATE ${table(transaction, 'tf_invitations')} SET revoked_at = clock_timestamp(), copy_material = NULL WHERE ${canonicalEmailSql('email')} = $1 AND revoked_at IS NULL AND consumed_membership_id IS NULL RETURNING id${registered ? ', workspace_member_id' : ''}`,
                [canonicalEmail(identity.email)],
              )
            ).rows,
          );
        for (const row of cancelled) {
          await cancelDelivery(transaction, row.id);
          if (row.workspace_member_id) changedMembers.add(row.workspace_member_id);
        }
      }
    }
    for (const memberId of changedMembers) await refreshWorkspaceMemberAccess(transaction, memberId);
    await audit(transaction, actor, 'member.remove', membershipId);
    await recommendationChange(
      transaction,
      membershipId,
      [membershipId, ...(await activeRecommendationMembers(transaction))],
      true,
    );
    return success;
  }

  async function protectFinalTeamManager(transaction: Transaction, membershipId: string, teamId?: string) {
    if (await isFinalTeamManager(transaction, membershipId, teamId)) throw new GovernanceConflict('final-team-manager');
  }

  async function protectManagerHandoff(transaction: Transaction, departure: ManagerDeparture) {
    if (await departureNeedsManagerHandoff(transaction, departure))
      throw new GovernanceConflict('manager-handoff-required');
  }

  async function isFinalTeamManager(transaction: Transaction, membershipId: string, teamId?: string) {
    const result = await transaction.client.query(
      `SELECT 1 FROM ${table(transaction, 'tf_member_teams')} mt
      WHERE mt.membership_id = $1 AND mt.role = 'manager' AND ($2::uuid IS NULL OR mt.team_id = $2)
      AND NOT EXISTS (SELECT 1 FROM ${table(transaction, 'tf_member_teams')} other
        JOIN ${table(transaction, 'tf_memberships')} m ON m.id = other.membership_id AND m.removed_at IS NULL
        WHERE other.team_id = mt.team_id AND other.role = 'manager' AND other.membership_id <> $1) LIMIT 1`,
      [membershipId, teamId ?? null],
    );
    return Boolean(result.rowCount);
  }

  async function ownMembership(workspaceId: string, userId: string) {
    return withHuman(workspaceId, userId, 'read', false, async (transaction, actor) => {
      const member = await currentMember(transaction, actor);
      const teams = await transaction.client.query(
        `SELECT t.id, t.name, mt.role FROM ${table(transaction, 'tf_teams')} t JOIN ${table(transaction, 'tf_member_teams')} mt ON mt.team_id = t.id WHERE mt.membership_id = $1 AND ${notInternal('t')} ORDER BY t.name, t.id`,
        [actor.membershipId],
      );
      const adminTeam = await transaction.client.query(
        `SELECT t.id FROM ${table(transaction, 'tf_teams')} t JOIN ${table(transaction, 'tf_member_teams')} mt ON mt.team_id = t.id WHERE mt.membership_id = $1 AND t.name = '_admin'`,
        [actor.membershipId],
      );
      const otherAdmin =
        member.role === 'admin'
          ? await transaction.client.query(
              `SELECT id FROM ${table(transaction, 'tf_memberships')} WHERE role = 'admin' AND removed_at IS NULL AND id <> $1 LIMIT 1`,
              [actor.membershipId],
            )
          : null;
      return ownMembershipSchema.parse({
        membershipId: actor.membershipId,
        role: member.role,
        teams: teams.rows,
        adminTeamId: adminTeam.rows[0]?.id ?? null,
        capabilities: {
          manageGovernance: member.role === 'admin',
          canLeave:
            (member.role !== 'admin' || Boolean(otherAdmin?.rowCount)) &&
            !(await isFinalTeamManager(transaction, actor.membershipId)) &&
            !(await departureNeedsManagerHandoff(transaction, { kind: 'member', membershipId: actor.membershipId })),
        },
      });
    });
  }

  async function snapshot(workspaceId: string, userId: string) {
    return withHuman(workspaceId, userId, 'read', false, async (transaction, actor) => {
      const admin = (await currentMember(transaction, actor)).role === 'admin';
      const members = z
        .array(memberRowSchema)
        .parse(
          (
            await transaction.client.query(
              `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY created_at, id`,
            )
          ).rows,
        );
      const profiles = z
        .array(profileSchema)
        .parse(
          (
            await dependencies.identity.query(
              'SELECT id, name, email, email_verified FROM app.users WHERE id = ANY($1::uuid[])',
              [members.map(member => member.user_id)],
            )
          ).rows,
        );
      const byId = new Map(profiles.map(profile => [profile.id, profile]));
      const teams = z
        .array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            description: z.string(),
            membership_ids: z.array(z.uuid()),
            manager_ids: z.array(z.uuid()),
            policy_count: z.coerce.number(),
          }),
        )
        .parse(
          (
            await transaction.client.query(
              `SELECT t.id, t.name, t.description,
        COALESCE(array_agg(mt.membership_id ORDER BY mt.membership_id) FILTER (WHERE m.id IS NOT NULL), '{}'::uuid[]) AS membership_ids,
        COALESCE(array_agg(mt.membership_id ORDER BY mt.membership_id) FILTER (WHERE m.id IS NOT NULL AND mt.role = 'manager'), '{}'::uuid[]) AS manager_ids,
        (SELECT count(DISTINCT g.asset_id) FROM ${table(transaction, 'tf_grants')} g WHERE g.team_id = t.id AND g.permission = ANY($3::text[])
          AND NOT EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_catalog')} c WHERE c.id = g.asset_id AND c.archived_at IS NOT NULL)) AS policy_count
        FROM ${table(transaction, 'tf_teams')} t LEFT JOIN ${table(transaction, 'tf_member_teams')} mt ON mt.team_id = t.id
        LEFT JOIN ${table(transaction, 'tf_memberships')} m ON m.id = mt.membership_id AND m.removed_at IS NULL
        WHERE ${notInternal('t')} AND ($2::boolean OR EXISTS (SELECT 1 FROM ${table(transaction, 'tf_member_teams')} own WHERE own.team_id = t.id AND own.membership_id = $1))
        GROUP BY t.id ORDER BY t.name, t.id`,
              [actor.membershipId, admin, policyPermissions],
            )
          ).rows,
        );
      // Members see their own teams' grants read-only; admins see every grant.
      const grants = z
        .array(z.object({ team_id: z.uuid(), asset_id: z.uuid(), permission: z.string(), owned: z.boolean() }))
        .parse(
          (
            await transaction.client.query(
              `SELECT g.team_id, g.asset_id, g.permission, ${ownedSql(table(transaction, 'tf_teams'), 'g')} FROM ${table(transaction, 'tf_grants')} g WHERE g.permission = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_catalog')} c WHERE c.id = g.asset_id AND c.archived_at IS NOT NULL)
        AND ($2::boolean OR EXISTS (SELECT 1 FROM ${table(transaction, 'tf_member_teams')} own WHERE own.team_id = g.team_id AND own.membership_id = $3))
        ORDER BY g.team_id, g.asset_id, g.permission`,
              [policyPermissions, admin, actor.membershipId],
            )
          ).rows,
        );
      const visibleTables = grants.filter(grant => grantKind(grant) === 'table').map(grant => grant.asset_id);
      const ownedTeams = grants.filter(grant => grantKind(grant) === 'owned').map(grant => grant.asset_id);
      const resources = z
        .array(z.object({ id: z.uuid(), display_name: z.string(), owning_team_id: z.uuid() }))
        .parse(
          (
            await transaction.client.query(
              `SELECT id, display_name, owning_team_id FROM ${table(transaction, 'tf_table_catalog')} WHERE archived_at IS NULL AND ($1::boolean OR id = ANY($2::uuid[]) OR owning_team_id = ANY($3::uuid[])) ORDER BY display_name, id`,
              [admin, visibleTables, ownedTeams],
            )
          ).rows,
        );
      const namedTeams = [
        ...teams.map(team => team.id),
        ...grants.filter(grant => grantKind(grant) !== 'table').map(grant => grant.asset_id),
      ];
      const teamNames = z
        .array(z.object({ id: z.uuid(), name: z.string() }))
        .parse(
          (
            await transaction.client.query(
              `SELECT t.id, t.name FROM ${table(transaction, 'tf_teams')} t WHERE ${notInternal('t')} AND ($1::boolean OR t.id = ANY($2::uuid[])) ORDER BY t.name, t.id`,
              [admin, namedTeams],
            )
          ).rows,
        );
      const personGrants =
        admin && (await tablePersonGrantsInstalled(transaction))
          ? z
              .array(
                z.object({ membership_id: z.uuid(), asset_id: z.uuid(), permission: z.string(), owned: z.boolean() }),
              )
              .parse(
                (
                  await transaction.client
                    .query(`SELECT g.*, ${ownedSql(table(transaction, 'tf_teams'), 'g')} FROM ${table(transaction, 'tf_table_person_grants')} g
        JOIN ${table(transaction, 'tf_memberships')} m ON m.id = g.membership_id AND m.removed_at IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_catalog')} c WHERE c.id = g.asset_id AND c.archived_at IS NOT NULL)
        ORDER BY g.membership_id, g.asset_id, g.permission`)
                ).rows,
              )
          : [];
      const tableTeams = z
        .array(z.object({ id: z.uuid(), name: z.string() }))
        .parse(
          admin
            ? (
                await transaction.client.query(
                  `SELECT t.id, t.name FROM ${table(transaction, 'tf_teams')} t WHERE ${notInternal('t')} OR t.name = '_admin' ORDER BY t.id`,
                )
              ).rows
            : [],
        );
      return governanceSnapshotSchema.parse({
        actorMembershipId: actor.membershipId,
        members: admin
          ? members.map(member => {
              const profile = byId.get(member.user_id);
              if (!profile) throw new Error('Member identity unavailable');
              return {
                id: member.id,
                userId: member.user_id,
                role: member.role,
                name: profile.name,
                email: profile.email,
              };
            })
          : [],
        directory: (await directory(transaction)).members,
        tableTeamIds: tableTeams.filter(team => team.name !== '_admin').map(team => team.id),
        adminTeamId: tableTeams.find(team => team.name === '_admin')?.id ?? null,
        teams: teams.map(team => ({
          id: team.id,
          name: team.name,
          description: team.description,
          membershipIds: team.membership_ids,
          managerIds: team.manager_ids,
          canManage: admin || team.manager_ids.includes(actor.membershipId),
          canLeave: !team.manager_ids.includes(actor.membershipId) || team.manager_ids.length > 1,
          policyCount: team.policy_count,
        })),
        teamNames,
        personGrants: personGrants.map(grant => ({
          membershipId: grant.membership_id,
          target: { kind: grantKind(grant), id: grant.asset_id, permission: grant.permission },
        })),
        tables: resources.map(resource => ({
          id: resource.id,
          name: resource.display_name,
          owningTeamId: resource.owning_team_id,
        })),
        grants: grants.map(grant => ({
          teamId: grant.team_id,
          target: { kind: grantKind(grant), id: grant.asset_id, permission: grant.permission },
        })),
      });
    });
  }

  async function directory(transaction: Transaction) {
    const members = z
      .array(memberRowSchema)
      .parse(
        (
          await transaction.client.query(
            `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY id`,
          )
        ).rows,
      );
    const profiles = z
      .array(z.object({ id: z.string(), name: z.string(), email: z.email(), image: z.string().nullable() }))
      .parse(
        (
          await dependencies.identity.query('SELECT id, name, email, image FROM app.users WHERE id = ANY($1::uuid[])', [
            members.map(member => member.user_id),
          ])
        ).rows,
      );
    const byId = new Map(profiles.map(profile => [profile.id, profile]));
    return collaborationDirectorySchema.parse({
      members: members.map(member => {
        const profile = byId.get(member.user_id);
        if (!profile) throw new Error('Member identity unavailable');
        return { id: member.id, name: profile.name, email: profile.email, image: profile.image, role: member.role };
      }),
    });
  }

  async function setMemberRole(workspaceId: string, userId: string, membershipId: string, input: unknown) {
    const { role } = memberRoleInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      const member = await activeMember(transaction, membershipId);
      if (member.role === role) return success;
      if (role === 'member') await protectFinalAdmin(transaction, member);
      await transaction.client.query(`UPDATE ${table(transaction, 'tf_memberships')} SET role = $2 WHERE id = $1`, [
        membershipId,
        role,
      ]);
      const adminTeam = `SELECT id FROM ${table(transaction, 'tf_teams')} WHERE name = '_admin'`;
      if (role === 'admin')
        await transaction.client.query(
          `INSERT INTO ${table(transaction, 'tf_member_teams')} (membership_id, team_id) SELECT $1, id FROM (${adminTeam}) a ON CONFLICT DO NOTHING`,
          [membershipId],
        );
      else
        await transaction.client.query(
          `DELETE FROM ${table(transaction, 'tf_member_teams')} WHERE membership_id = $1 AND team_id IN (${adminTeam})`,
          [membershipId],
        );
      await audit(transaction, actor, `member.role.${role}`, membershipId);
      await recommendationChange(transaction, membershipId, [membershipId], true);
      return success;
    });
  }

  async function createTeam(workspaceId: string, userId: string, teamId: string, input: unknown) {
    z.uuid().parse(teamId);
    const { name, description } = teamInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      if (
        (
          await transaction.client.query(`SELECT id FROM ${table(transaction, 'tf_retired_teams')} WHERE id = $1`, [
            teamId,
          ])
        ).rowCount
      )
        throw new GovernanceConflict('team-id-retired');
      const inserted = await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_teams')} (id, name, description, creator_membership_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [teamId, name, description, actor.membershipId],
      );
      if (!inserted.rowCount) {
        await requireTeamManager(transaction, actor, teamId);
        const existing = z
          .object({ name: z.string(), description: z.string() })
          .parse(
            (
              await transaction.client.query(
                `SELECT name, description FROM ${table(transaction, 'tf_teams')} WHERE id = $1`,
                [teamId],
              )
            ).rows[0],
          );
        if (existing.name !== name || existing.description !== description)
          throw new GovernanceConflict('team-id-conflict');
      } else {
        await transaction.client.query(
          `INSERT INTO ${table(transaction, 'tf_member_teams')} (team_id, membership_id, role) VALUES ($1, $2, 'manager')`,
          [teamId, actor.membershipId],
        );
        await audit(transaction, actor, 'team.create', teamId);
        await recommendationChange(transaction, teamId, [actor.membershipId]);
      }
      return success;
    });
  }

  // A workspace admin manages every team without being its manager; anyone else must manage the team.
  async function requireTeamAdministration(transaction: Transaction, actor: HumanActor, teamId: string) {
    if ((await currentMember(transaction, actor)).role === 'admin') await teamExists(transaction, teamId);
    else await requireTeamManager(transaction, actor, teamId);
  }

  async function renameTeam(workspaceId: string, userId: string, teamId: string, input: unknown) {
    const { name, description, expected } = teamUpdateSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      await requireTeamAdministration(transaction, actor, teamId);
      const updated = await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_teams')} SET name = $2, description = $3 WHERE id = $1 AND name = $4 AND description = $5 RETURNING id`,
        [teamId, name, description, expected.name, expected.description],
      );
      if (!updated.rowCount) {
        const matching = await transaction.client.query(
          `SELECT id FROM ${table(transaction, 'tf_teams')} WHERE id = $1 AND name = $2 AND description = $3`,
          [teamId, name, description],
        );
        if (matching.rowCount) return success;
        throw new GovernanceConflict('team-details-conflict');
      }
      await audit(transaction, actor, 'team.rename', teamId);
      return success;
    });
  }

  async function deleteTeam(workspaceId: string, userId: string, teamId: string) {
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      await requireTeamAdministration(transaction, actor, teamId);
      const affected = await teamMembers(transaction, teamId);
      const owned = (
        await transaction.client.query(
          `SELECT archived_at IS NOT NULL AS archived FROM ${table(transaction, 'tf_table_catalog')} WHERE owning_team_id = $1 ORDER BY archived_at IS NOT NULL LIMIT 1`,
          [teamId],
        )
      ).rows[0];
      if (owned) throw new GovernanceConflict(owned.archived ? 'team-owns-archived-tables' : 'team-owns-tables');
      await protectManagerHandoff(transaction, { kind: 'team', teamId });
      if (
        (
          await transaction.client.query(
            `SELECT id FROM ${table(transaction, 'tf_agents')} WHERE owning_team_id = $1 AND deleted_at IS NULL LIMIT 1`,
            [teamId],
          )
        ).rowCount
      )
        throw new GovernanceConflict('team-owns-agents');
      await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_agents')} SET policy_version = policy_version + 1 WHERE id IN (SELECT agent_id FROM ${table(transaction, 'tf_agent_teams')} WHERE team_id = $1 UNION SELECT agent_id FROM ${table(transaction, 'tf_agent_grants')} WHERE team_id = $1)`,
        [teamId],
      );
      await transaction.client.query(`DELETE FROM ${table(transaction, 'tf_agent_teams')} WHERE team_id = $1`, [
        teamId,
      ]);
      const integrations = await transaction.client.query('SELECT to_regclass($1) AS relation', [
        table(transaction, 'tf_integrations'),
      ]);
      if (integrations.rows[0]?.relation) {
        if (
          (
            await transaction.client.query(
              `SELECT id FROM ${table(transaction, 'tf_integrations')} WHERE owning_team_id = $1 AND deleted_at IS NULL LIMIT 1`,
              [teamId],
            )
          ).rowCount
        )
          throw new GovernanceConflict('team-owns-integrations');
        await transaction.client.query(
          `UPDATE ${table(transaction, 'tf_integrations')} SET grants_version = grants_version + 1 WHERE id IN (SELECT integration_id FROM ${table(transaction, 'tf_integration_grants')} WHERE team_id = $1 UNION SELECT integration_id FROM ${table(transaction, 'tf_integration_source_grants')} WHERE team_id = $1)`,
          [teamId],
        );
        await transaction.client.query(
          `DELETE FROM ${table(transaction, 'tf_integration_grants')} WHERE team_id = $1`,
          [teamId],
        );
        await transaction.client.query(
          `DELETE FROM ${table(transaction, 'tf_integration_source_grants')} WHERE team_id = $1`,
          [teamId],
        );
        await transaction.client.query(
          `DELETE FROM ${table(transaction, 'tf_integration_creation_grants')} WHERE team_id = $1 OR owning_team_id = $1`,
          [teamId],
        );
      }
      await transaction.client.query(
        `DELETE FROM ${table(transaction, 'tf_grants')} WHERE team_id = $1 OR (asset_id = $1 AND permission = ANY($2::text[]))`,
        [teamId, policyPermissions],
      );
      if (await tablePersonGrantsInstalled(transaction))
        await transaction.client.query(
          `DELETE FROM ${table(transaction, 'tf_table_person_grants')} WHERE asset_id = $1`,
          [teamId],
        );
      await transaction.client.query(`DELETE FROM ${table(transaction, 'tf_member_teams')} WHERE team_id = $1`, [
        teamId,
      ]);
      await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_retired_teams')} (id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [teamId],
      );
      await transaction.client.query(`DELETE FROM ${table(transaction, 'tf_teams')} WHERE id = $1`, [teamId]);
      await audit(transaction, actor, 'team.delete', teamId);
      await recommendationChange(transaction, teamId, affected, true);
      return success;
    });
  }

  async function setEnrollment(
    workspaceId: string,
    userId: string,
    teamId: string,
    membershipId: string,
    input: unknown,
  ) {
    const { enrolled } = enrollmentInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      await requireTeamAdministration(transaction, actor, teamId);
      await activeMember(transaction, membershipId);
      if (!enrolled) {
        await protectFinalTeamManager(transaction, membershipId, teamId);
        await protectManagerHandoff(transaction, { kind: 'enrollment', membershipId, teamId });
      }
      const changed = enrolled
        ? await transaction.client.query(
            `INSERT INTO ${table(transaction, 'tf_member_teams')} (team_id, membership_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [teamId, membershipId],
          )
        : await transaction.client.query(
            `DELETE FROM ${table(transaction, 'tf_member_teams')} WHERE team_id = $1 AND membership_id = $2`,
            [teamId, membershipId],
          );
      await audit(transaction, actor, enrolled ? 'team.enroll' : 'team.unenroll', membershipId);
      if (changed.rowCount) await recommendationChange(transaction, teamId, [membershipId], true);
      return success;
    });
  }

  async function setTeamRole(
    workspaceId: string,
    userId: string,
    teamId: string,
    membershipId: string,
    input: unknown,
  ) {
    const { role } = teamRoleInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      await requireTeamAdministration(transaction, actor, teamId);
      await activeMember(transaction, membershipId);
      const previous = (
        await transaction.client.query(
          `SELECT role FROM ${table(transaction, 'tf_member_teams')} WHERE team_id=$1 AND membership_id=$2`,
          [teamId, membershipId],
        )
      ).rows[0];
      if (role === 'member') await protectFinalTeamManager(transaction, membershipId, teamId);
      const updated = await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_member_teams')} SET role = $3 WHERE team_id = $1 AND membership_id = $2 RETURNING team_id`,
        [teamId, membershipId, role],
      );
      if (!updated.rowCount) throw new AccessDenied();
      await audit(transaction, actor, `team.role.${role}`, teamId);
      if (previous?.role !== role) await recommendationChange(transaction, teamId, [membershipId], true);
      return success;
    });
  }

  async function leaveTeam(workspaceId: string, userId: string, teamId: string) {
    z.uuid().parse(teamId);
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      await teamExists(transaction, teamId);
      await protectFinalTeamManager(transaction, actor.membershipId, teamId);
      await protectManagerHandoff(transaction, { kind: 'enrollment', membershipId: actor.membershipId, teamId });
      const removed = await transaction.client.query(
        `DELETE FROM ${table(transaction, 'tf_member_teams')} WHERE team_id = $1 AND membership_id = $2 RETURNING team_id`,
        [teamId, actor.membershipId],
      );
      if (removed.rowCount) await audit(transaction, actor, 'team.leave', teamId);
      if (removed.rowCount) await recommendationChange(transaction, teamId, [actor.membershipId], true);
      return success;
    });
  }

  async function setGrant(workspaceId: string, userId: string, input: unknown) {
    const { teamId, target, granted } = grantInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      await grantTeamExists(transaction, teamId);
      if (target.kind !== 'table') await teamExists(transaction, target.id);
      else if (
        !(
          await transaction.client.query(
            `SELECT id FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1 AND (archived_at IS NULL OR NOT $2::boolean)`,
            [target.id, granted],
          )
        ).rowCount
      )
        throw new AccessDenied();
      const changed = granted
        ? await transaction.client.query(
            `INSERT INTO ${table(transaction, 'tf_grants')} (team_id, asset_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [teamId, target.id, target.permission],
          )
        : await transaction.client.query(
            `DELETE FROM ${table(transaction, 'tf_grants')} WHERE team_id = $1 AND asset_id = $2 AND permission = $3`,
            [teamId, target.id, target.permission],
          );
      await audit(transaction, actor, `${granted ? 'grant' : 'revoke'}.${target.permission}`, target.id);
      if (changed.rowCount)
        await recommendationChange(transaction, target.id, await teamMembers(transaction, teamId), true);
      return success;
    });
  }

  async function transferTable(workspaceId: string, userId: string, tableId: string, teamId: string) {
    z.uuid().parse(tableId);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      if ((await workspaceMembersTable(transaction))?.coreDefinition.id === tableId)
        throw new WorkspaceMemberError('member-table-protected');
      await teamExists(transaction, teamId);
      const previousOwner = z
        .object({ owning_team_id: z.uuid() })
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT owning_team_id FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1`,
              [tableId],
            )
          ).rows[0],
        )?.owning_team_id;
      const result = await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_table_catalog')} SET owning_team_id = $2 WHERE id = $1 RETURNING id`,
        [tableId, teamId],
      );
      if (!result.rowCount) throw new AccessDenied();
      await audit(transaction, actor, 'table.transfer', tableId);
      // Policies on every table a team owns follow the table, so holders on either side may gain or lose it.
      if (previousOwner && previousOwner !== teamId) {
        const holders = await ownedPolicyHolders(transaction, [previousOwner, teamId]);
        if (holders.length) await recommendationChange(transaction, tableId, holders, true);
      }
      return success;
    });
  }

  async function listPersonGrants(workspaceId: string, userId: string) {
    return withHuman(workspaceId, userId, 'read', true, async transaction => {
      if (!(await tablePersonGrantsInstalled(transaction))) throw new GovernanceConflict('person-grants-unavailable');
      const rows = z
        .array(z.object({ membership_id: z.uuid(), asset_id: z.uuid(), permission: z.string(), owned: z.boolean() }))
        .parse(
          (
            await transaction.client
              .query(`SELECT g.*, ${ownedSql(table(transaction, 'tf_teams'), 'g')} FROM ${table(transaction, 'tf_table_person_grants')} g
        JOIN ${table(transaction, 'tf_memberships')} m ON m.id = g.membership_id AND m.removed_at IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_catalog')} c WHERE c.id = g.asset_id AND c.archived_at IS NOT NULL)
        ORDER BY g.membership_id, g.asset_id, g.permission`)
          ).rows,
        );
      return personGrantListSchema.parse({
        grants: rows.map(grant => ({
          membershipId: grant.membership_id,
          target: { kind: grantKind(grant), id: grant.asset_id, permission: grant.permission },
        })),
      });
    });
  }

  async function setPersonGrant(workspaceId: string, userId: string, input: unknown) {
    const { membershipId, target, granted } = personGrantInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      if (!(await tablePersonGrantsInstalled(transaction))) throw new GovernanceConflict('person-grants-unavailable');
      await activeMember(transaction, membershipId);
      if (target.kind !== 'table') await teamExists(transaction, target.id);
      else if (
        !(
          await transaction.client.query(
            `SELECT id FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1 AND (archived_at IS NULL OR NOT $2::boolean)`,
            [target.id, granted],
          )
        ).rowCount
      )
        throw new AccessDenied();
      const changed = granted
        ? await transaction.client.query(
            `INSERT INTO ${table(transaction, 'tf_table_person_grants')} (membership_id, asset_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [membershipId, target.id, target.permission],
          )
        : await transaction.client.query(
            `DELETE FROM ${table(transaction, 'tf_table_person_grants')} WHERE membership_id = $1 AND asset_id = $2 AND permission = $3`,
            [membershipId, target.id, target.permission],
          );
      await audit(transaction, actor, `person.${granted ? 'grant' : 'revoke'}.${target.permission}`, target.id);
      if (changed.rowCount) await recommendationChange(transaction, target.id, [membershipId], true);
      return success;
    });
  }

  // A policy scope must exist; removing grants from an archived table stays possible.
  async function scopeName(transaction: Transaction, scope: PolicyScope, allowArchived = false) {
    const row = (
      scope.kind !== 'table'
        ? await transaction.client.query(
            `SELECT name FROM ${table(transaction, 'tf_teams')} t WHERE t.id = $1 AND ${notInternal('t')}`,
            [scope.id],
          )
        : await transaction.client.query(
            `SELECT display_name AS name FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1 AND (archived_at IS NULL OR $2::boolean)`,
            [scope.id, allowArchived],
          )
    ).rows[0];
    return z.object({ name: z.string() }).optional().parse(row)?.name;
  }

  /** Sets exactly the permissions one team or person holds on one scope, and reports what changed. */
  async function setPolicy(workspaceId: string, userId: string, input: unknown) {
    const { subject, scope, permissions } = policyInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      if (subject.kind === 'team') await grantTeamExists(transaction, subject.id);
      else {
        if (!(await tablePersonGrantsInstalled(transaction))) throw new GovernanceConflict('person-grants-unavailable');
        await activeMember(transaction, subject.id);
      }
      if ((await scopeName(transaction, scope, permissions.length === 0)) === undefined) throw new AccessDenied();
      const grants =
        subject.kind === 'team'
          ? { relation: table(transaction, 'tf_grants'), column: 'team_id' }
          : { relation: table(transaction, 'tf_table_person_grants'), column: 'membership_id' };
      const current = z
        .array(z.object({ permission: z.string() }))
        .parse(
          (
            await transaction.client.query(
              `SELECT permission FROM ${grants.relation} WHERE ${grants.column} = $1 AND asset_id = $2 AND permission = ANY($3::text[])`,
              [subject.id, scope.id, scope.kind === 'collection' ? ['table.create'] : tablePermissions],
            )
          ).rows,
        )
        .map(row => row.permission as PolicyPermission);
      const added = permissions.filter(permission => !current.includes(permission));
      const removed = current.filter(permission => !permissions.includes(permission));
      if (added.length)
        await transaction.client.query(
          `INSERT INTO ${grants.relation} (${grants.column}, asset_id, permission) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
          [subject.id, scope.id, added],
        );
      if (removed.length)
        await transaction.client.query(
          `DELETE FROM ${grants.relation} WHERE ${grants.column} = $1 AND asset_id = $2 AND permission = ANY($3::text[])`,
          [subject.id, scope.id, removed],
        );
      const prefix = subject.kind === 'team' ? '' : 'person.';
      for (const permission of added) await audit(transaction, actor, `${prefix}grant.${permission}`, scope.id);
      for (const permission of removed) await audit(transaction, actor, `${prefix}revoke.${permission}`, scope.id);
      if (added.length || removed.length)
        await recommendationChange(
          transaction,
          scope.id,
          subject.kind === 'team' ? await teamMembers(transaction, subject.id) : [subject.id],
          true,
        );
      return policyChangeSchema.parse({ added, removed });
    });
  }

  /** One member's role, teams and effective table access with where each part comes from. Admins, or the member. */
  async function memberAccess(workspaceId: string, userId: string, membershipId: string) {
    z.uuid().parse(membershipId);
    return withHuman(workspaceId, userId, 'read', false, async (transaction, actor) => {
      const viewer = await currentMember(transaction, actor);
      const admin = viewer.role === 'admin';
      if (!admin && membershipId !== actor.membershipId) throw new AccessDenied();
      const member = await activeMember(transaction, membershipId);
      const profile = z
        .object({ id: z.string(), name: z.string(), email: z.email(), image: z.string().nullable() })
        .optional()
        .parse(
          (
            await dependencies.identity.query('SELECT id, name, email, image FROM app.users WHERE id = $1', [
              member.user_id,
            ])
          ).rows[0],
        );
      if (!profile) throw new Error('Member identity unavailable');
      const teams = z
        .array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            role: z.enum(['member', 'manager']),
            viewer_role: z.string().nullable(),
          }),
        )
        .parse(
          (
            await transaction.client.query(
              `SELECT t.id, t.name, mt.role, own.role AS viewer_role FROM ${table(transaction, 'tf_member_teams')} mt
          JOIN ${table(transaction, 'tf_teams')} t ON t.id = mt.team_id
          LEFT JOIN ${table(transaction, 'tf_member_teams')} own ON own.team_id = t.id AND own.membership_id = $2
          WHERE mt.membership_id = $1 AND ${notInternal('t')} ORDER BY t.name, t.id`,
              [membershipId, actor.membershipId],
            )
          ).rows,
        );
      const scopes = `CASE WHEN g.permission = 'table.create' THEN 'collection' WHEN dt.id IS NOT NULL THEN 'owned' ELSE 'table' END AS kind,
        COALESCE(c.display_name, dt.name) AS scope_name`;
      const scopeJoins = (
        alias: string,
      ) => `LEFT JOIN ${table(transaction, 'tf_table_catalog')} c ON c.id = ${alias}.asset_id AND ${alias}.permission <> 'table.create'
        LEFT JOIN ${table(transaction, 'tf_teams')} dt ON dt.id = ${alias}.asset_id`;
      const visible = `g.permission = ANY($2::text[]) AND (c.id IS NOT NULL AND c.archived_at IS NULL OR dt.id IS NOT NULL)`;
      const grantRow = z.object({
        asset_id: z.uuid(),
        permission: z.string(),
        kind: z.enum(['table', 'collection', 'owned']),
        scope_name: z.string(),
      });
      const teamGrants = z.array(grantRow.extend({ team_id: z.uuid(), team_name: z.string() })).parse(
        (
          await transaction.client.query(
            `SELECT g.team_id, t.name AS team_name, g.asset_id, g.permission, ${scopes}
          FROM ${table(transaction, 'tf_grants')} g JOIN ${table(transaction, 'tf_member_teams')} mt ON mt.team_id = g.team_id AND mt.membership_id = $1
          JOIN ${table(transaction, 'tf_teams')} t ON t.id = g.team_id ${scopeJoins('g')}
          WHERE ${visible} ORDER BY t.name, scope_name, g.asset_id`,
            [membershipId, policyPermissions],
          )
        ).rows,
      );
      const directGrants = (await tablePersonGrantsInstalled(transaction))
        ? z.array(grantRow).parse(
            (
              await transaction.client.query(
                `SELECT g.asset_id, g.permission, ${scopes} FROM ${table(transaction, 'tf_table_person_grants')} g ${scopeJoins('g')}
            WHERE g.membership_id = $1 AND ${visible} ORDER BY scope_name, g.asset_id`,
                [membershipId, policyPermissions],
              )
            ).rows,
          )
        : [];
      type Policy = z.infer<typeof memberAccessSchema>['policies'][number];
      const policies = new Map<string, Policy>();
      const add = (key: string, policy: Omit<Policy, 'permissions' | 'tables'>, permission: string) => {
        const existing = policies.get(key) ?? { ...policy, permissions: [], tables: [] };
        existing.permissions.push(permission as PolicyPermission);
        policies.set(key, existing);
      };
      if (member.role === 'admin')
        policies.set('admin', {
          scope: { kind: 'all' },
          permissions: [...policyPermissions] as PolicyPermission[],
          source: { kind: 'admin' },
          tables: [],
        });
      for (const grant of teamGrants) {
        const scope = { kind: grant.kind, id: grant.asset_id, name: grant.scope_name };
        if (grant.team_name === '_admin')
          add(`admin:${grant.asset_id}:${grant.kind}`, { scope, source: { kind: 'admin' } }, grant.permission);
        else
          add(
            `team:${grant.team_id}:${grant.asset_id}:${grant.kind}`,
            { scope, source: { kind: 'team', teamId: grant.team_id, teamName: grant.team_name } },
            grant.permission,
          );
      }
      for (const grant of directGrants)
        add(
          `direct:${grant.asset_id}:${grant.kind}`,
          { scope: { kind: grant.kind, id: grant.asset_id, name: grant.scope_name }, source: { kind: 'direct' } },
          grant.permission,
        );
      const ownedTeams = [...teamGrants, ...directGrants]
        .filter(grant => grant.kind === 'owned')
        .map(grant => grant.asset_id);
      const covered = ownedTeams.length
        ? z.array(z.object({ id: z.uuid(), name: z.string(), owning_team_id: z.uuid() })).parse(
            (
              await transaction.client.query(
                `SELECT id, display_name AS name, owning_team_id FROM ${table(transaction, 'tf_table_catalog')}
                  WHERE owning_team_id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY display_name, id`,
                [ownedTeams],
              )
            ).rows,
          )
        : [];
      for (const policy of policies.values())
        if (policy.scope.kind === 'owned') {
          const owner = policy.scope.id;
          policy.tables = covered.filter(entry => entry.owning_team_id === owner).map(({ id, name }) => ({ id, name }));
        }
      const skipped = admin
        ? (
            await transaction.client.query(
              `SELECT skipped FROM ${table(transaction, 'tf_invitations')} WHERE consumed_membership_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [membershipId],
            )
          ).rows[0]?.skipped
        : null;
      const parsedSkipped = skipped ? skippedChoicesSchema.parse(skipped) : null;
      const self = membershipId === actor.membershipId;
      const otherAdmin =
        member.role === 'admin'
          ? Boolean(
              (
                await transaction.client.query(
                  `SELECT id FROM ${table(transaction, 'tf_memberships')} WHERE role = 'admin' AND removed_at IS NULL AND id <> $1 LIMIT 1`,
                  [membershipId],
                )
              ).rowCount,
            )
          : true;
      return memberAccessSchema.parse({
        member: { id: member.id, name: profile.name, email: profile.email, image: profile.image, role: member.role },
        self,
        canManage: admin,
        finalAdmin: !otherAdmin,
        canLeave:
          self &&
          otherAdmin &&
          !(await isFinalTeamManager(transaction, membershipId)) &&
          !(await departureNeedsManagerHandoff(transaction, { kind: 'member', membershipId })),
        teams: teams.map(team => ({
          id: team.id,
          name: team.name,
          role: team.role,
          canManage: admin || team.viewer_role === 'manager',
        })),
        policies: [...policies.values()],
        skipped: parsedSkipped && (parsedSkipped.teams.length || parsedSkipped.policies.length) ? parsedSkipped : null,
      });
    });
  }

  const invitation = (row: z.infer<typeof invitationRowSchema>) =>
    invitationSchema.parse({
      id: row.id,
      kind: row.kind,
      email: row.email,
      expiresAt: row.expires_at.toISOString(),
      status: row.consumed_membership_id ? 'consumed' : row.revoked_at ? 'revoked' : row.expired ? 'expired' : 'active',
      canCopy: Boolean(row.copy_material) && !row.revoked_at && !row.consumed_membership_id && !row.expired,
      workspaceMemberId: row.workspace_member_id,
      createdAt: row.created_at?.toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      role: row.role,
      ...assignmentsSchema.parse(row.assignments ?? {}),
      skipped: row.skipped ? skippedChoicesSchema.parse(row.skipped) : null,
    });

  // Invitation choices arrived with migration 51; older workspace schemas accept only plain invitations.
  async function invitationChoicesInstalled(transaction: Transaction) {
    return Boolean(
      (
        await transaction.client.query(
          `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'assignments' AND NOT attisdropped`,
          [table(transaction, 'tf_invitations')],
        )
      ).rowCount,
    );
  }

  type Skipped = z.infer<typeof skippedChoicesSchema>;

  /** Which of these invitation choices name a team or table that has been deleted or archived since. */
  async function missingChoices(transaction: Transaction, assignments: Assignments[]) {
    const teamIds = assignments.flatMap(entry => [
      ...entry.teams.map(team => team.id),
      ...entry.policies.filter(policy => policy.scope.kind !== 'table').map(policy => policy.scope.id),
    ]);
    const tableIds = assignments.flatMap(entry =>
      entry.policies.filter(policy => policy.scope.kind === 'table').map(policy => policy.scope.id),
    );
    const live = new Set(
      teamIds.length || tableIds.length
        ? z
            .array(z.object({ id: z.uuid() }))
            .parse(
              (
                await transaction.client.query(
                  `SELECT t.id FROM ${table(transaction, 'tf_teams')} t WHERE t.id = ANY($1::uuid[]) AND ${notInternal('t')}
                  UNION SELECT c.id FROM ${table(transaction, 'tf_table_catalog')} c WHERE c.id = ANY($2::uuid[]) AND c.archived_at IS NULL`,
                  [teamIds, tableIds],
                )
              ).rows,
            )
            .map(row => row.id)
        : [],
    );
    return (entry: Assignments) => ({
      kept: {
        teams: entry.teams.filter(team => live.has(team.id)),
        policies: entry.policies.filter(policy => live.has(policy.scope.id)),
      },
      skipped: {
        teams: entry.teams.filter(team => !live.has(team.id)).map(({ id, name }) => ({ id, name })),
        policies: entry.policies
          .filter(policy => !live.has(policy.scope.id))
          .map(({ scope, name }) => ({ scope, name })),
      } satisfies Skipped,
    });
  }

  const mergeSkipped = (...lists: (Skipped | null | undefined)[]): Skipped | null => {
    const teams = new Map<string, Skipped['teams'][number]>();
    const policies = new Map<string, Skipped['policies'][number]>();
    for (const list of lists) {
      for (const team of list?.teams ?? []) teams.set(team.id, team);
      for (const policy of list?.policies ?? []) policies.set(`${policy.scope.kind}:${policy.scope.id}`, policy);
    }
    return teams.size || policies.size ? { teams: [...teams.values()], policies: [...policies.values()] } : null;
  };

  /** Checks every chosen team and scope exists now and records its name, so a later skip can still name it. */
  async function resolveChoices(transaction: Transaction, choices: InvitationChoices, dropMissing = false) {
    const plain = choices.role === 'member' && !choices.teams.length && !choices.policies.length;
    if (!(await invitationChoicesInstalled(transaction))) {
      if (plain) return null;
      throw new GovernanceConflict('invitations-unavailable');
    }
    if (choices.policies.length && !(await tablePersonGrantsInstalled(transaction)))
      throw new GovernanceConflict('person-grants-unavailable');
    const assignments: Assignments = { teams: [], policies: [] };
    for (const team of choices.teams) {
      const name = await scopeName(transaction, { kind: 'collection', id: team.id });
      if (name === undefined && dropMissing) continue;
      if (name === undefined) throw new AccessDenied();
      assignments.teams.push({ id: team.id, role: team.role, name });
    }
    for (const policy of choices.policies) {
      const name = await scopeName(transaction, policy.scope);
      if (name === undefined && dropMissing) continue;
      if (name === undefined) throw new AccessDenied();
      assignments.policies.push({ scope: policy.scope, permissions: policy.permissions, name });
    }
    return { role: choices.role, assignments };
  }
  const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

  async function accountsForEmail(email: string) {
    return z
      .array(z.object({ id: z.string() }))
      .parse(
        (
          await dependencies.identity.query('SELECT id FROM app.users WHERE lower(email)=$1 OR canonical_email=$2', [
            email,
            canonicalEmail(email),
          ])
        ).rows,
      )
      .map(user => user.id);
  }

  async function createInvitation(workspaceId: string, userId: string, input: unknown) {
    const parsed = invitationInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      const workspaceMemberId = parsed.workspaceMemberId ?? null;
      const existing = await recoverInvitationOperation(transaction, parsed.requestId, {
        email: parsed.email,
        predecessorId: null,
        workspaceMemberId,
      });
      if (existing) return existing;
      const registered = await workspaceMembersTable(transaction);
      if (registered && !workspaceMemberId) throw new WorkspaceMemberError('member-selection-required');
      const userIds = await accountsForEmail(parsed.email);
      if (workspaceMemberId)
        await requireWorkspaceMemberInvitation(transaction, {
          memberId: workspaceMemberId,
          email: parsed.email,
          recipientUserIds: userIds,
        });
      if (
        (
          await transaction.client.query(
            `SELECT id FROM ${table(transaction, 'tf_memberships')} WHERE user_id = ANY($1::text[]) AND removed_at IS NULL LIMIT 1`,
            [userIds],
          )
        ).rowCount
      ) {
        if (
          workspaceMemberId &&
          !(
            await transaction.client.query(
              `SELECT 1 FROM ${table(transaction, 'tf_workspace_member_accounts')}
          WHERE member_id=$1 AND user_id=ANY($2::text[])`,
              [workspaceMemberId, userIds],
            )
          ).rowCount
        )
          throw new WorkspaceMemberError('member-link-conflict');
        await recordInvitationOperation(
          transaction,
          parsed.requestId,
          parsed.email,
          null,
          'already-member',
          null,
          workspaceMemberId,
        );
        return { outcome: 'already-member' as const };
      }
      const pending = invitationRowSchema
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT *, false AS expired FROM ${table(transaction, 'tf_invitations')} WHERE ${canonicalEmailSql('email')} = $1 AND revoked_at IS NULL AND consumed_membership_id IS NULL AND expires_at > clock_timestamp() ORDER BY created_at DESC LIMIT 1`,
              [canonicalEmail(parsed.email)],
            )
          ).rows[0],
        );
      if (pending && pending.workspace_member_id !== workspaceMemberId)
        throw new WorkspaceMemberError('member-link-conflict');
      const choices = await resolveChoices(
        transaction,
        invitationChoicesSchema.parse({ role: parsed.role, teams: parsed.teams, policies: parsed.policies }),
      );
      if (!pending)
        return issueInvitation(transaction, actor, parsed.email, parsed.requestId, null, workspaceMemberId, choices);
      // Inviting someone again replaces their pending invite with these choices and a fresh link.
      await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_invitations')} SET revoked_at = clock_timestamp(), copy_material = NULL WHERE id = $1`,
        [pending.id],
      );
      await cancelDelivery(transaction, pending.id);
      const replaced = await issueInvitation(
        transaction,
        actor,
        parsed.email,
        parsed.requestId,
        pending.id,
        workspaceMemberId,
        choices,
      );
      return { ...replaced, outcome: 'updated' as const };
    });
  }

  type ResolvedChoices = Awaited<ReturnType<typeof resolveChoices>>;

  async function openInvitation(transaction: Transaction, invitationId: string) {
    const row = invitationRowSchema
      .optional()
      .parse(
        (
          await transaction.client.query(
            `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE id = $1 FOR UPDATE`,
            [invitationId],
          )
        ).rows[0],
      );
    if (!row || row.kind !== 'email' || row.revoked_at || row.consumed_membership_id) throw new AccessDenied();
    // An expired invite can only be resent or revoked; resending is what gives it a working link again.
    if (row.expired) throw new GovernanceConflict('invitation-expired');
    if (!(await invitationChoicesInstalled(transaction))) throw new GovernanceConflict('invitations-unavailable');
    return row;
  }

  async function saveChoices(
    transaction: Transaction,
    actor: HumanActor,
    id: string,
    choices: NonNullable<ResolvedChoices>,
  ) {
    const previous = invitationRowSchema.parse(
      (
        await transaction.client.query(
          `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE id = $1`,
          [id],
        )
      ).rows[0],
    );
    // Choices dropped because their team or table is gone stay on record, so admins still see they were skipped.
    const before = assignmentsSchema.parse(previous.assignments ?? {});
    const gone = (await missingChoices(transaction, [before]))(before).skipped;
    const skipped = mergeSkipped(previous.skipped ? skippedChoicesSchema.parse(previous.skipped) : null, gone);
    const row = invitationRowSchema.parse(
      (
        await transaction.client.query(
          `UPDATE ${table(transaction, 'tf_invitations')} SET role = $2, assignments = $3, skipped = $4 WHERE id = $1
        RETURNING *, expires_at <= clock_timestamp() AS expired`,
          [id, choices.role, JSON.stringify(choices.assignments), skipped && JSON.stringify(skipped)],
        )
      ).rows[0],
    );
    await audit(transaction, actor, 'invitation.choices', id);
    return { ...invitation(row), delivery: await deliveryStatus(transaction, transaction.workspaceId, id) };
  }

  /** Replaces the role, teams and policies a pending invitation applies on accept. Admins only. */
  async function setInvitationChoices(workspaceId: string, userId: string, invitationId: string, input: unknown) {
    invitationId = z.uuid().parse(invitationId).toLowerCase();
    const parsed = invitationChoicesSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      await openInvitation(transaction, invitationId);
      const choices = await resolveChoices(transaction, parsed);
      if (!choices) throw new GovernanceConflict('invitations-unavailable');
      return saveChoices(transaction, actor, invitationId, choices);
    });
  }

  /** Adds a pending invitee to one team, or takes them off it, without changing their other choices. Admins only. */
  async function setInvitationTeam(
    workspaceId: string,
    userId: string,
    teamId: string,
    invitationId: string,
    input: unknown,
  ) {
    teamId = z.uuid().parse(teamId).toLowerCase();
    invitationId = z.uuid().parse(invitationId).toLowerCase();
    const { enrolled, role } = invitationTeamEnrollmentSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      const row = await openInvitation(transaction, invitationId);
      await teamExists(transaction, teamId);
      const assignments = assignmentsSchema.parse(row.assignments ?? {});
      const teams = assignments.teams.filter(team => team.id !== teamId);
      // Choices made earlier may name a team or table that has gone since; drop those rather than refuse.
      const choices = await resolveChoices(
        transaction,
        {
          role: row.role,
          teams: [...teams.map(({ id, role }) => ({ id, role })), ...(enrolled ? [{ id: teamId, role }] : [])],
          policies: assignments.policies.map(({ scope, permissions }) => ({
            scope,
            permissions: permissions as PolicyPermission[],
          })),
        },
        true,
      );
      return saveChoices(transaction, actor, invitationId, choices!);
    });
  }

  function invitationUrl(token: string) {
    if (!dependencies.emailDelivery) throw new GovernanceConflict('invitations-unavailable');
    const url = new URL('/invite', dependencies.emailDelivery.webOrigin);
    url.searchParams.set('token', token);
    return url.href;
  }

  async function cancelDelivery(transaction: Transaction, id: string) {
    await transaction.client.query('SELECT app.invitation_delivery($1, $2, $3)', [
      transaction.workspaceId,
      id,
      'cancel',
    ]);
  }

  async function invitationResult(
    transaction: Transaction,
    row: z.infer<typeof invitationRowSchema>,
    outcome: 'created' | 'pending' | 'updated',
  ) {
    return {
      outcome,
      invitation: { ...invitation(row), delivery: await deliveryStatus(transaction, transaction.workspaceId, row.id) },
    };
  }

  async function recordInvitationOperation(
    transaction: Transaction,
    requestId: string,
    email: string,
    predecessorId: string | null,
    outcome: 'created' | 'pending' | 'already-member',
    invitationId: string | null,
    workspaceMemberId: string | null,
  ) {
    await transaction.client.query(
      `INSERT INTO ${table(transaction, 'tf_invitation_operations')} (request_id, email, predecessor_id, outcome, invitation_id${workspaceMemberId ? ', workspace_member_id' : ''}) VALUES ($1,$2,$3,$4,$5${workspaceMemberId ? ',$6' : ''})`,
      [requestId, email, predecessorId, outcome, invitationId, ...(workspaceMemberId ? [workspaceMemberId] : [])],
    );
  }

  async function recoverInvitationOperation(
    transaction: Transaction,
    requestId: string,
    expected: ({ email: string; predecessorId: null } | { predecessorId: string }) & {
      workspaceMemberId: string | null;
    },
  ) {
    const receipt = z
      .object({
        email: z.string(),
        predecessor_id: z.uuid().nullable(),
        outcome: z.enum(['created', 'pending', 'already-member']),
        invitation_id: z.uuid().nullable(),
        workspace_member_id: z.uuid().nullable().default(null),
      })
      .optional()
      .parse(
        (
          await transaction.client.query(
            `SELECT * FROM ${table(transaction, 'tf_invitation_operations')} WHERE request_id=$1`,
            [requestId],
          )
        ).rows[0],
      );
    if (!receipt) return null;
    // A new invite to an address with a pending one replaces it, so its receipt names that predecessor.
    const replaced = 'email' in expected && receipt.predecessor_id !== null;
    if (
      (!replaced && receipt.predecessor_id !== expected.predecessorId) ||
      receipt.workspace_member_id !== expected.workspaceMemberId ||
      ('email' in expected && receipt.email !== expected.email)
    )
      throw new GovernanceConflict('invitation-request-conflict');
    if (receipt.outcome === 'already-member') return { outcome: 'already-member' as const };
    const row = invitationRowSchema.parse(
      (
        await transaction.client.query(
          `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE id=$1`,
          [receipt.invitation_id],
        )
      ).rows[0],
    );
    return invitationResult(transaction, row, replaced ? 'updated' : receipt.outcome);
  }

  async function issueInvitation(
    transaction: Transaction,
    actor: HumanActor,
    email: string,
    requestId: string,
    predecessorId: string | null,
    workspaceMemberId: string | null,
    choices: ResolvedChoices,
  ) {
    if (!dependencies.emailDelivery) throw new GovernanceConflict('invitations-unavailable');
    const workspaceId = transaction.workspaceId;
    const token = `${workspaceId}.${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const url = invitationUrl(token);
    const material = encryptInvitationCopy(workspaceId, id, url, dependencies.emailDelivery.keys);
    const row = invitationRowSchema.parse(
      (
        await transaction.client.query(
          `INSERT INTO ${table(transaction, 'tf_invitations')} (id, issuer_membership_id, kind, email, token_hash, request_id, predecessor_id, copy_material${workspaceMemberId ? ', workspace_member_id' : ''}${choices ? ', role, assignments' : ''}) VALUES ($1, $2, 'email', $3, $4, $5, $6, $7${workspaceMemberId ? ',$8' : ''}${choices ? (workspaceMemberId ? ',$9,$10' : ',$8,$9') : ''}) RETURNING *, false AS expired`,
          [
            id,
            actor.membershipId,
            email,
            hashToken(token),
            requestId,
            predecessorId,
            material,
            ...(workspaceMemberId ? [workspaceMemberId] : []),
            ...(choices ? [choices.role, JSON.stringify(choices.assignments)] : []),
          ],
        )
      ).rows[0],
    );
    if (
      workspaceMemberId &&
      (await refreshWorkspaceMemberAccess(transaction, workspaceMemberId)) === 'not-materialized'
    )
      throw new WorkspaceMemberError('member-unavailable');
    const workspace = z
      .object({ name: z.string() })
      .parse(
        (await dependencies.identity.query('SELECT name FROM app.workspaces WHERE id = $1', [workspaceId])).rows[0],
      );
    const payload = encryptEmailDelivery(
      id,
      { kind: 'invitation', email, url, workspaceName: workspace.name, expiresAt: row.expires_at.toISOString() },
      dependencies.emailDelivery.keys,
    );
    await transaction.client.query('SELECT app.invitation_delivery($1, $2, $3, $4, $5)', [
      workspaceId,
      id,
      'enqueue',
      payload,
      row.expires_at,
    ]);
    await audit(transaction, actor, predecessorId ? 'invitation.resend' : 'invitation.create', id);
    await recordInvitationOperation(transaction, requestId, email, predecessorId, 'created', id, workspaceMemberId);
    await recommendationChange(transaction, id, await activeRecommendationMembers(transaction));
    await scheduleRecommendationExpiry(transaction, id, row.expires_at);
    afterCommit(transaction.client, () => {
      void emitHook('member.invited', {
        workspaceId,
        invitationId: id,
        invitedByUserId: actor.userId,
        replacesInvitationId: predecessorId,
      });
      trackEvent('member_invited', { userId: actor.userId, workspaceId }, { resend: predecessorId !== null });
    });
    return invitationResult(transaction, row, 'created');
  }

  async function resendInvitation(workspaceId: string, userId: string, invitationId: string, input: unknown) {
    invitationId = z.uuid().parse(invitationId).toLowerCase();
    const { requestId, workspaceMemberId: selectedMemberId } = resendInvitationSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      const previous = invitationRowSchema
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE id = $1`,
              [invitationId],
            )
          ).rows[0],
        );
      const workspaceMemberId = selectedMemberId ?? previous?.workspace_member_id ?? null;
      const existing = await recoverInvitationOperation(transaction, requestId, {
        predecessorId: invitationId,
        workspaceMemberId,
      });
      if (existing) return existing;
      if (previous?.workspace_member_id && previous.workspace_member_id !== workspaceMemberId)
        throw new WorkspaceMemberError('member-link-conflict');
      if (
        !previous ||
        previous.kind !== 'email' ||
        !previous.email ||
        previous.consumed_membership_id ||
        previous.revoked_at
      )
        throw new AccessDenied();
      if (await workspaceMembersTable(transaction)) {
        if (!workspaceMemberId) throw new WorkspaceMemberError('member-selection-required');
        await requireWorkspaceMemberInvitation(transaction, {
          memberId: workspaceMemberId,
          email: previous.email,
          recipientUserIds: await accountsForEmail(previous.email),
        });
      }
      if (
        (
          await transaction.client.query(
            `SELECT id FROM ${table(transaction, 'tf_invitations')} WHERE ${canonicalEmailSql('email')} = $1 AND id <> $2 AND revoked_at IS NULL AND consumed_membership_id IS NULL AND expires_at > clock_timestamp() LIMIT 1`,
            [canonicalEmail(previous.email), invitationId],
          )
        ).rowCount
      )
        throw new GovernanceConflict('invitation-request-conflict');
      await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_invitations')} SET revoked_at = clock_timestamp(), copy_material = NULL WHERE id = $1`,
        [invitationId],
      );
      await cancelDelivery(transaction, invitationId);
      const carried = (await invitationChoicesInstalled(transaction))
        ? { role: previous.role, assignments: assignmentsSchema.parse(previous.assignments ?? {}) }
        : null;
      const issued = await issueInvitation(
        transaction,
        actor,
        previous.email,
        requestId,
        invitationId,
        workspaceMemberId,
        carried,
      );
      if (carried && previous.skipped)
        await transaction.client.query(
          `UPDATE ${table(transaction, 'tf_invitations')} SET skipped = $2 WHERE predecessor_id = $1`,
          [invitationId, JSON.stringify(skippedChoicesSchema.parse(previous.skipped))],
        );
      return issued;
    });
  }

  async function copyInvitation(workspaceId: string, userId: string, invitationId: string) {
    z.uuid().parse(invitationId);
    return withHuman(workspaceId, userId, 'read', true, async transaction => {
      const row = invitationRowSchema
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE id = $1`,
              [invitationId],
            )
          ).rows[0],
        );
      if (!row || !invitation(row).canCopy || !dependencies.emailDelivery) throw new AccessDenied();
      return {
        url: decryptInvitationCopy(workspaceId, invitationId, row.copy_material, dependencies.emailDelivery.keys),
      };
    });
  }

  async function listInvitations(workspaceId: string, userId: string, input: unknown = {}) {
    const { after, search = '', open } = invitationListQuerySchema.parse(input);
    return withHuman(workspaceId, userId, 'read', true, async transaction => {
      const status = dependencies.emailDelivery
        ? "CASE WHEN kind = 'email' THEN app.invitation_delivery($3, id, 'status') ELSE NULL END"
        : 'NULL::text';
      const result = await transaction.client.query(
        `
        SELECT * FROM (
          SELECT *, expires_at <= clock_timestamp() AS expired, ${status} AS delivery,
            CASE WHEN consumed_membership_id IS NOT NULL THEN 'consumed accepted'
              WHEN revoked_at IS NOT NULL THEN 'revoked'
              WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'active' END AS validity
          FROM ${table(transaction, 'tf_invitations')}
          WHERE $1::uuid IS NULL OR (created_at, id) < (
            SELECT created_at, id FROM ${table(transaction, 'tf_invitations')} WHERE id = $1
          )
        ) invitations
        WHERE ($2 = '' OR strpos(lower(concat_ws(' ', COALESCE(email, 'Retired unrestricted link'), validity, COALESCE(delivery, 'not tracked'))), $2) > 0)
          ${
            open === 'true'
              ? `AND validity IN ('active', 'expired') AND kind = 'email' AND NOT EXISTS (
            SELECT 1 FROM ${table(transaction, 'tf_invitations')} newer WHERE newer.email IS NOT NULL
              AND ${canonicalEmailSql('newer.email')} = ${canonicalEmailSql('invitations.email')}
              AND (newer.created_at, newer.id) > (invitations.created_at, invitations.id))`
              : ''
          }
        ORDER BY created_at DESC, id DESC LIMIT 101
      `,
        dependencies.emailDelivery ? [after ?? null, search, workspaceId] : [after ?? null, search],
      );
      const rows = z
        .array(invitationRowSchema.extend({ delivery: invitationSchema.shape.delivery }))
        .parse(result.rows);
      const page = rows.slice(0, 100);
      const pending = page.filter(row => !row.consumed_membership_id && !row.revoked_at);
      const split = await missingChoices(
        transaction,
        pending.map(row => assignmentsSchema.parse(row.assignments ?? {})),
      );
      // A pending invite no longer offers a team or table deleted since; it lists those as skipped instead.
      const items = page.map(row => {
        const item = { ...invitation(row), delivery: row.delivery };
        if (row.consumed_membership_id || row.revoked_at) return item;
        const { kept, skipped } = split(assignmentsSchema.parse(row.assignments ?? {}));
        return {
          ...item,
          teams: item.teams.filter(team => kept.teams.some(entry => entry.id === team.id)),
          policies: item.policies.filter(policy => kept.policies.some(entry => entry.scope.id === policy.scope.id)),
          skipped: mergeSkipped(item.skipped, skipped),
        };
      });
      return { items, nextCursor: rows.length > 100 ? (items.at(-1)?.id ?? null) : null };
    });
  }

  async function revokeInvitation(workspaceId: string, userId: string, invitationId: string) {
    z.uuid().parse(invitationId);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      const previous = (
        await transaction.client.query(`SELECT * FROM ${table(transaction, 'tf_invitations')} WHERE id=$1`, [
          invitationId,
        ])
      ).rows[0];
      const result = await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_invitations')} SET revoked_at = COALESCE(revoked_at, clock_timestamp()), copy_material = NULL WHERE id = $1 RETURNING id`,
        [invitationId],
      );
      if (!result.rowCount) throw new AccessDenied();
      if (previous?.workspace_member_id)
        await refreshWorkspaceMemberAccess(transaction, z.uuid().parse(previous.workspace_member_id));
      if (dependencies.emailDelivery)
        await transaction.client.query('SELECT app.invitation_delivery($1, $2, $3)', [
          workspaceId,
          invitationId,
          'cancel',
        ]);
      await audit(transaction, actor, 'invitation.revoke', invitationId);
      if (previous?.revoked_at === null)
        await recommendationChange(transaction, invitationId, await activeRecommendationMembers(transaction));
      return success;
    });
  }

  async function deliveryStatus(transaction: Transaction, workspaceId: string, id: string) {
    return z
      .object({ status: invitationSchema.shape.delivery })
      .parse(
        (
          await transaction.client.query('SELECT app.invitation_delivery($1, $2, $3) AS status', [
            workspaceId,
            id,
            'status',
          ])
        ).rows[0],
      ).status;
  }

  async function lockedInvitation(transaction: Transaction, token: string) {
    await lockAuthorization(transaction, 'write');
    await transaction.client.query(
      `SELECT id FROM ${table(transaction, 'tf_invitations')} WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(token)],
    );
    const result = await transaction.client.query(
      `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE token_hash = $1`,
      [hashToken(token)],
    );
    const row = invitationRowSchema.optional().parse(result.rows[0]);
    if (!row || row.kind !== 'email') throw new AccessDenied();
    return row;
  }

  async function redeemInvitation(userId: string, tokenInput: string) {
    const token = invitationTokenSchema.parse(tokenInput);
    const workspaceId = z.uuid().parse(token.split('.')[0]);
    return dependencies.runtime.transaction(workspaceId, dependencies.compatibility, async transaction =>
      admitInvitation(transaction, workspaceId, await lockedInvitation(transaction, token), userId),
    );
  }

  /**
   * What a signed-out holder of the link may learn: whether it can still be redeemed and, only while it can,
   * the invited address, the workspace name and whether that address already has an account.
   */
  // A forged token names an arbitrary workspace id; answer it like an unknown token before opening that workspace.
  async function invitedWorkspace(workspaceId: string) {
    const workspace = z
      .object({ name: z.string() })
      .optional()
      .parse(
        (await dependencies.identity.query('SELECT name FROM app.workspaces WHERE id = $1', [workspaceId])).rows[0],
      );
    if (!workspace) throw new AccessDenied();
    return workspace;
  }

  async function invitationDetails(tokenInput: string) {
    const token = invitationTokenSchema.parse(tokenInput);
    const workspaceId = z.uuid().parse(token.split('.')[0]);
    const workspace = await invitedWorkspace(workspaceId);
    const row = await dependencies.runtime.transaction(workspaceId, dependencies.compatibility, async transaction => {
      await lockAuthorization(transaction, 'read');
      const result = await transaction.client.query(
        `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(transaction, 'tf_invitations')} WHERE token_hash = $1`,
        [hashToken(token)],
      );
      return invitationRowSchema.optional().parse(result.rows[0]);
    });
    if (!row || row.kind !== 'email' || !row.email) throw new AccessDenied();
    const status = invitation(row).status;
    if (status !== 'active') return invitationDetailsSchema.parse({ status });
    return invitationDetailsSchema.parse({
      status,
      email: row.email,
      workspaceName: workspace.name,
      hasAccount: (await accountsForEmail(row.email)).length > 0,
    });
  }

  /**
   * Redeems an active invitation for an address with no account: creates that account, admits it and consumes the
   * invitation under the invitation lock, so the link can create an account only on its first redemption.
   * The account lives in the identity database, so a failure after it was created removes it again.
   */
  async function redeemInvitationForNewAccount(
    tokenInput: string,
    account: { create: (email: string) => Promise<string>; remove: (userId: string) => Promise<void> },
  ) {
    const token = invitationTokenSchema.parse(tokenInput);
    const workspaceId = z.uuid().parse(token.split('.')[0]);
    await invitedWorkspace(workspaceId);
    let created: string | null = null;
    try {
      return await dependencies.runtime.transaction(workspaceId, dependencies.compatibility, async transaction => {
        const row = await lockedInvitation(transaction, token);
        if (!row.email || row.consumed_membership_id || row.expired || row.revoked_at) throw new AccessDenied();
        if ((await workspaceMembersTable(transaction)) && !row.workspace_member_id)
          throw new WorkspaceMemberError('member-selection-required');
        if ((await accountsForEmail(row.email)).length) throw new GovernanceConflict('invitation-account-exists');
        created = await account.create(row.email);
        const joined = await admitInvitation(transaction, workspaceId, row, created);
        return { ...joined, userId: created };
      });
    } catch (error) {
      if (created) await account.remove(created).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Gives a new member the role, teams and table policies chosen on their invitation. Anything deleted or archived
   * since is skipped and recorded on the invitation, so admins can see what did not apply.
   */
  async function applyChoices(
    transaction: Transaction,
    row: z.infer<typeof invitationRowSchema>,
    membershipId: string,
  ) {
    const assignments = assignmentsSchema.parse(row.assignments ?? {});
    if (row.role === 'admin') {
      await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_memberships')} SET role = 'admin' WHERE id = $1`,
        [membershipId],
      );
      await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_member_teams')} (membership_id, team_id) SELECT $1, id FROM ${table(transaction, 'tf_teams')} WHERE name = '_admin' ON CONFLICT DO NOTHING`,
        [membershipId],
      );
    }
    const skipped: Skipped = { teams: [], policies: [] };
    for (const team of assignments.teams) {
      if ((await scopeName(transaction, { kind: 'collection', id: team.id })) === undefined) {
        skipped.teams.push({ id: team.id, name: team.name });
        continue;
      }
      await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_member_teams')} (membership_id, team_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [membershipId, team.id, team.role],
      );
    }
    const personGrants = assignments.policies.length > 0 && (await tablePersonGrantsInstalled(transaction));
    for (const policy of assignments.policies) {
      const permissions = policy.permissions.filter(permission => policyPermissions.includes(permission));
      if (!personGrants || (await scopeName(transaction, policy.scope)) === undefined || !permissions.length) {
        skipped.policies.push({ scope: policy.scope, name: policy.name });
        continue;
      }
      await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_table_person_grants')} (membership_id, asset_id, permission) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
        [membershipId, policy.scope.id, permissions],
      );
    }
    const recorded = mergeSkipped(row.skipped ? skippedChoicesSchema.parse(row.skipped) : null, skipped);
    if (recorded)
      await transaction.client.query(`UPDATE ${table(transaction, 'tf_invitations')} SET skipped = $2 WHERE id = $1`, [
        row.id,
        JSON.stringify(recorded),
      ]);
    if (row.role === 'admin' || assignments.teams.length || assignments.policies.length)
      await recommendationChange(transaction, membershipId, [membershipId], true);
  }

  async function admitInvitation(
    transaction: Transaction,
    workspaceId: string,
    row: z.infer<typeof invitationRowSchema>,
    userId: string,
  ) {
    const registration = await workspaceMembersTable(transaction);
    const identityRow = (
      await dependencies.identity.query(
        `SELECT id, name, email, email_verified${registration ? ', image, profile_revision::text AS revision' : ''} FROM app.users WHERE id = $1`,
        [userId],
      )
    ).rows[0];
    const identity = profileSchema.optional().parse(identityRow);
    if (
      !identity ||
      (!identity.email_verified && !dependencies.acceptUnverifiedEmail) ||
      !row.email ||
      canonicalEmail(identity.email) !== canonicalEmail(row.email)
    )
      throw new AccessDenied();
    const existing = memberRowSchema
      .optional()
      .parse(
        (
          await transaction.client.query(
            `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL`,
            [userId],
          )
        ).rows[0],
      );
    if (row.consumed_membership_id) {
      if (row.consumed_membership_id !== existing?.id) throw new AccessDenied();
      return { workspaceId, membershipId: existing.id };
    }
    if (row.expired || row.revoked_at) throw new AccessDenied();
    if (
      (
        await transaction.client.query(
          `SELECT 1 FROM ${table(transaction, 'tf_memberships')} m JOIN ${table(transaction, 'tf_invitations')} i ON i.id = $2 WHERE m.user_id = $1 AND m.removed_at >= i.created_at LIMIT 1`,
          [userId, row.id],
        )
      ).rowCount
    )
      throw new AccessDenied();
    const membershipId = existing?.id ?? randomUUID();
    if (registration) {
      if (!row.workspace_member_id) throw new WorkspaceMemberError('member-selection-required');
      await bindWorkspaceMemberAccount(transaction, { memberId: row.workspace_member_id, userId, membershipId });
    }
    if (!existing)
      await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_memberships')} (id, user_id, role) VALUES ($1, $2, 'member')`,
        [membershipId, userId],
      );
    if (!existing && (await invitationChoicesInstalled(transaction)))
      await applyChoices(transaction, row, membershipId);
    if (registration && row.workspace_member_id) {
      const profile = memberProfileSchema.parse({
        id: identity.id,
        name: identity.name,
        email: identity.email,
        image: identityRow.image,
        revision: identityRow.revision,
      });
      await projectWorkspaceMemberProfile(transaction, { memberId: row.workspace_member_id, membershipId, profile });
    }
    await transaction.client.query(
      `UPDATE ${table(transaction, 'tf_invitations')} SET consumed_membership_id = $2, copy_material = NULL WHERE id = $1`,
      [row.id, membershipId],
    );
    await cancelDelivery(transaction, row.id);
    await transaction.client.query(
      `INSERT INTO ${table(transaction, 'tf_invitation_redemptions')} (invitation_id, membership_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.id, membershipId],
    );
    await audit(transaction, { kind: 'human', userId, membershipId }, 'invitation.redeem', row.id);
    await recommendationChange(transaction, row.id, await activeRecommendationMembers(transaction));
    afterCommit(transaction.client, () => trackEvent('member_joined', { userId, workspaceId }));
    return { workspaceId, membershipId };
  }

  return {
    invitationDetails,
    redeemInvitationForNewAccount,
    ownMembership,
    snapshot,
    setMemberRole,
    createTeam,
    renameTeam,
    deleteTeam,
    setEnrollment,
    setTeamRole,
    leaveTeam,
    setGrant,
    listPersonGrants,
    setPersonGrant,
    setPolicy,
    memberAccess,
    transferTable,
    collaborationDirectory: (workspaceId: string, userId: string) =>
      withHuman(workspaceId, userId, 'read', false, directory),
    createInvitation,
    listInvitations,
    revokeInvitation,
    redeemInvitation,
    resendInvitation,
    copyInvitation,
    setInvitationChoices,
    setInvitationTeam,
    removeMember: (workspaceId: string, userId: string, membershipId: string) =>
      withHuman(workspaceId, userId, 'write', true, (transaction, actor) => remove(transaction, actor, membershipId)),
    leave: (workspaceId: string, userId: string) =>
      withHuman(workspaceId, userId, 'write', false, (transaction, actor) =>
        remove(transaction, actor, actor.membershipId),
      ),
  };
}
