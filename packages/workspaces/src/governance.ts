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
  invitationSchema,
  invitationTokenSchema,
  memberRoleInputSchema,
  ownMembershipSchema,
  resendInvitationSchema,
  teamInputSchema,
  teamUpdateSchema,
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
});
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
      | 'team-owns-agents'
      | 'team-owns-integrations'
      | 'team-id-conflict'
      | 'team-id-retired'
      | 'teams-unavailable'
      | 'person-grants-unavailable'
      | 'invitations-unavailable'
      | 'invitation-request-conflict',
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

  async function teamExists(transaction: Transaction, id: string) {
    const result = await transaction.client.query(
      `SELECT id FROM ${table(transaction, 'tf_teams')} t WHERE t.id = $1 AND ${notInternal('t')}`,
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
          }),
        )
        .parse(
          (
            await transaction.client.query(
              `SELECT t.id, t.name, t.description,
        array_agg(mt.membership_id ORDER BY mt.membership_id) AS membership_ids,
        COALESCE(array_agg(mt.membership_id ORDER BY mt.membership_id) FILTER (WHERE mt.role = 'manager'), '{}'::uuid[]) AS manager_ids
        FROM ${table(transaction, 'tf_teams')} t JOIN ${table(transaction, 'tf_member_teams')} mt ON mt.team_id = t.id
        JOIN ${table(transaction, 'tf_memberships')} m ON m.id = mt.membership_id AND m.removed_at IS NULL
        WHERE ${notInternal('t')} AND EXISTS (SELECT 1 FROM ${table(transaction, 'tf_member_teams')} own WHERE own.team_id = t.id AND own.membership_id = $1)
        GROUP BY t.id ORDER BY t.name, t.id`,
              [actor.membershipId],
            )
          ).rows,
        );
      const resources = z
        .array(z.object({ id: z.uuid(), display_name: z.string(), owning_team_id: z.uuid() }))
        .parse(
          admin
            ? (
                await transaction.client.query(
                  `SELECT id, display_name, owning_team_id FROM ${table(transaction, 'tf_table_catalog')} ORDER BY display_name, id`,
                )
              ).rows
            : [],
        );
      const grants = z
        .array(z.object({ team_id: z.uuid(), asset_id: z.uuid(), permission: z.string() }))
        .parse(
          admin
            ? (
                await transaction.client.query(
                  `SELECT team_id, asset_id, permission FROM ${table(transaction, 'tf_grants')} WHERE permission = ANY($1::text[]) ORDER BY team_id, asset_id, permission`,
                  [
                    [
                      'table.create',
                      'table.schema.manage',
                      'table.row.create',
                      'table.row.read',
                      'table.row.update',
                      'table.row.delete',
                    ],
                  ],
                )
              ).rows
            : [],
        );
      const tableTeams = z
        .array(z.object({ id: z.uuid() }))
        .parse(
          admin
            ? (
                await transaction.client.query(
                  `SELECT t.id FROM ${table(transaction, 'tf_teams')} t WHERE ${notInternal('t')} ORDER BY t.id`,
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
        tableTeamIds: tableTeams.map(team => team.id),
        teams: teams.map(team => ({
          id: team.id,
          name: team.name,
          description: team.description,
          membershipIds: team.membership_ids,
          managerIds: team.manager_ids,
          canManage: team.manager_ids.includes(actor.membershipId),
          canLeave: !team.manager_ids.includes(actor.membershipId) || team.manager_ids.length > 1,
        })),
        tables: resources.map(resource => ({
          id: resource.id,
          name: resource.display_name,
          owningTeamId: resource.owning_team_id,
        })),
        grants: grants.map(grant => ({
          teamId: grant.team_id,
          target: {
            kind: grant.permission === 'table.create' ? 'collection' : 'table',
            id: grant.asset_id,
            permission: grant.permission,
          },
        })),
      });
    });
  }

  async function directory(transaction: Transaction) {
    const members = z
      .array(z.object({ id: z.uuid(), user_id: z.string() }))
      .parse(
        (
          await transaction.client.query(
            `SELECT id, user_id FROM ${table(transaction, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY id`,
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
        return { id: member.id, name: profile.name, email: profile.email, image: profile.image };
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

  async function renameTeam(workspaceId: string, userId: string, teamId: string, input: unknown) {
    const { name, description, expected } = teamUpdateSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', false, async (transaction, actor) => {
      await requireTeamManager(transaction, actor, teamId);
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
      await requireTeamManager(transaction, actor, teamId);
      const affected = await teamMembers(transaction, teamId);
      if (
        (
          await transaction.client.query(
            `SELECT id FROM ${table(transaction, 'tf_table_catalog')} WHERE owning_team_id = $1 LIMIT 1`,
            [teamId],
          )
        ).rowCount
      )
        throw new GovernanceConflict('team-owns-tables');
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
        `DELETE FROM ${table(transaction, 'tf_grants')} WHERE team_id = $1 OR (asset_id = $1 AND permission = 'table.create')`,
        [teamId],
      );
      if (await tablePersonGrantsInstalled(transaction))
        await transaction.client.query(
          `DELETE FROM ${table(transaction, 'tf_table_person_grants')} WHERE asset_id = $1 AND permission = 'table.create'`,
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
      await requireTeamManager(transaction, actor, teamId);
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
      await requireTeamManager(transaction, actor, teamId);
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
      await teamExists(transaction, teamId);
      if (target.kind === 'collection') await teamExists(transaction, target.id);
      else if (
        !(
          await transaction.client.query(`SELECT id FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1`, [
            target.id,
          ])
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
      const result = await transaction.client.query(
        `UPDATE ${table(transaction, 'tf_table_catalog')} SET owning_team_id = $2 WHERE id = $1 RETURNING id`,
        [tableId, teamId],
      );
      if (!result.rowCount) throw new AccessDenied();
      await audit(transaction, actor, 'table.transfer', tableId);
      return success;
    });
  }

  async function listPersonGrants(workspaceId: string, userId: string) {
    return withHuman(workspaceId, userId, 'read', true, async transaction => {
      if (!(await tablePersonGrantsInstalled(transaction))) throw new GovernanceConflict('person-grants-unavailable');
      const rows = z.array(z.object({ membership_id: z.uuid(), asset_id: z.uuid(), permission: z.string() })).parse(
        (
          await transaction.client.query(`SELECT g.* FROM ${table(transaction, 'tf_table_person_grants')} g
        JOIN ${table(transaction, 'tf_memberships')} m ON m.id = g.membership_id AND m.removed_at IS NULL
        ORDER BY g.membership_id, g.asset_id, g.permission`)
        ).rows,
      );
      return personGrantListSchema.parse({
        grants: rows.map(grant => ({
          membershipId: grant.membership_id,
          target: {
            kind: grant.permission === 'table.create' ? 'collection' : 'table',
            id: grant.asset_id,
            permission: grant.permission,
          },
        })),
      });
    });
  }

  async function setPersonGrant(workspaceId: string, userId: string, input: unknown) {
    const { membershipId, target, granted } = personGrantInputSchema.parse(input);
    return withHuman(workspaceId, userId, 'write', true, async (transaction, actor) => {
      if (!(await tablePersonGrantsInstalled(transaction))) throw new GovernanceConflict('person-grants-unavailable');
      await activeMember(transaction, membershipId);
      if (target.kind === 'collection') await teamExists(transaction, target.id);
      else if (
        !(
          await transaction.client.query(`SELECT id FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1`, [
            target.id,
          ])
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

  const invitation = (row: z.infer<typeof invitationRowSchema>) =>
    invitationSchema.parse({
      id: row.id,
      kind: row.kind,
      email: row.email,
      expiresAt: row.expires_at.toISOString(),
      status: row.consumed_membership_id ? 'consumed' : row.revoked_at ? 'revoked' : row.expired ? 'expired' : 'active',
      canCopy: Boolean(row.copy_material) && !row.revoked_at && !row.consumed_membership_id && !row.expired,
      workspaceMemberId: row.workspace_member_id,
    });
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
      if (pending) {
        if (pending.workspace_member_id !== workspaceMemberId) throw new WorkspaceMemberError('member-link-conflict');
        await recordInvitationOperation(
          transaction,
          parsed.requestId,
          parsed.email,
          null,
          'pending',
          pending.id,
          workspaceMemberId,
        );
        return invitationResult(transaction, pending, 'pending');
      }
      return issueInvitation(transaction, actor, parsed.email, parsed.requestId, null, workspaceMemberId);
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
    outcome: 'created' | 'pending',
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
    if (
      receipt.predecessor_id !== expected.predecessorId ||
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
    return invitationResult(transaction, row, receipt.outcome);
  }

  async function issueInvitation(
    transaction: Transaction,
    actor: HumanActor,
    email: string,
    requestId: string,
    predecessorId: string | null,
    workspaceMemberId: string | null,
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
          `INSERT INTO ${table(transaction, 'tf_invitations')} (id, issuer_membership_id, kind, email, token_hash, request_id, predecessor_id, copy_material${workspaceMemberId ? ', workspace_member_id' : ''}) VALUES ($1, $2, 'email', $3, $4, $5, $6, $7${workspaceMemberId ? ',$8' : ''}) RETURNING *, false AS expired`,
          [
            id,
            actor.membershipId,
            email,
            hashToken(token),
            requestId,
            predecessorId,
            material,
            ...(workspaceMemberId ? [workspaceMemberId] : []),
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
      return issueInvitation(transaction, actor, previous.email, requestId, invitationId, workspaceMemberId);
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
    const { after, search = '' } = invitationListQuerySchema.parse(input);
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
        WHERE $2 = '' OR strpos(lower(concat_ws(' ', COALESCE(email, 'Retired unrestricted link'), validity, COALESCE(delivery, 'not tracked'))), $2) > 0
        ORDER BY created_at DESC, id DESC LIMIT 101
      `,
        dependencies.emailDelivery ? [after ?? null, search, workspaceId] : [after ?? null, search],
      );
      const rows = z
        .array(invitationRowSchema.extend({ delivery: invitationSchema.shape.delivery }))
        .parse(result.rows);
      const items = rows.slice(0, 100).map(row => ({ ...invitation(row), delivery: row.delivery }));
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

  async function redeemInvitation(userId: string, tokenInput: string) {
    const token = invitationTokenSchema.parse(tokenInput);
    const workspaceId = z.uuid().parse(token.split('.')[0]);
    return dependencies.runtime.transaction(workspaceId, dependencies.compatibility, async transaction => {
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
    });
  }

  return {
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
    transferTable,
    collaborationDirectory: (workspaceId: string, userId: string) =>
      withHuman(workspaceId, userId, 'read', false, directory),
    createInvitation,
    listInvitations,
    revokeInvitation,
    redeemInvitation,
    resendInvitation,
    copyInvitation,
    removeMember: (workspaceId: string, userId: string, membershipId: string) =>
      withHuman(workspaceId, userId, 'write', true, (transaction, actor) => remove(transaction, actor, membershipId)),
    leave: (workspaceId: string, userId: string) =>
      withHuman(workspaceId, userId, 'write', false, (transaction, actor) =>
        remove(transaction, actor, actor.membershipId),
      ),
  };
}
