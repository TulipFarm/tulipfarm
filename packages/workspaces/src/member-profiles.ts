import type { Pool } from 'pg';
import { z } from 'zod';
import { lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  activeGeneration,
  fieldColumn,
  lockCatalogs,
  projectWorkspaceMemberProfile,
  refreshWorkspaceMemberAccess,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import {
  memberProfileSchema,
  workspaceMemberAccess,
  workspaceMemberFields,
  WorkspaceMemberError,
} from '@tulipfarm/tables/workspace-members';
import type { WorkspaceRuntime } from './storage.ts';

const eventSchema = z.object({
  user_id: z.uuid(),
  revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  workspace_cursor: z.uuid().nullable(),
});
const candidateSchema = z.object({
  member_id: z.uuid(),
  membership_id: z.uuid(),
  user_id: z.string(),
  profile_revision: z.string(),
  requested_revision: z.string(),
  next_attempt_at: z.string(),
});

export function memberProfileSource(pool: Pick<Pool, 'query'>) {
  return {
    async read(workspaceId: string, userIds: string[]) {
      return z
        .array(memberProfileSchema)
        .parse(
          (
            await pool.query('SELECT * FROM app.workspace_member_profiles($1,$2::uuid[])', [
              z.uuid().parse(workspaceId),
              z.array(z.uuid()).min(1).max(100).parse(userIds),
            ])
          ).rows,
        );
    },
    async pending() {
      return z.array(eventSchema).parse((await pool.query('SELECT * FROM app.pending_member_profile_events()')).rows);
    },
    async advance(event: z.infer<typeof eventSchema>, next: string | null) {
      return z
        .object({ advanced: z.boolean() })
        .parse(
          (
            await pool.query('SELECT app.advance_member_profile_event($1,$2,$3,$4) AS advanced', [
              event.user_id,
              event.revision,
              event.workspace_cursor,
              next,
            ])
          ).rows[0],
        ).advanced;
    },
  };
}

export function createMemberProfileProjection(options: {
  runtime: Pick<WorkspaceRuntime, 'transaction'>;
  source: ReturnType<typeof memberProfileSource>;
  discover: (after: string | null) => Promise<string[]>;
}) {
  async function dispatch() {
    let queued = 0;
    const failures: unknown[] = [];
    for (const event of await options.source.pending()) {
      try {
        const workspaces = await options.discover(event.workspace_cursor);
        for (const workspaceId of workspaces)
          queued += await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
            await lockAuthorization(tx);
            if (!(await workspaceMembersTable(tx))) return 0;
            const result = await tx.client.query(
              `UPDATE ${qualified(tx.schema, 'tf_workspace_member_accounts')} a
            SET requested_revision=GREATEST(a.requested_revision,$2),profile_status='pending',profile_error=NULL,next_attempt_at=clock_timestamp()
            WHERE a.user_id=$1 AND a.profile_revision<$2
              AND EXISTS(SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m
                WHERE m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL)`,
              [event.user_id, event.revision],
            );
            return result.rowCount ?? 0;
          });
        await options.source.advance(event, workspaces.length === 10 ? workspaces.at(-1)! : null);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Workspace member profile dispatch incomplete');
    return queued;
  }

  async function recordFailures(workspaceId: string, candidates: z.infer<typeof candidateSchema>[]) {
    await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      for (const candidate of candidates)
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_workspace_member_accounts')} a
        SET profile_status='failed',profile_error='profile-projection-failed',next_attempt_at=clock_timestamp()+interval '1 minute'
        WHERE a.member_id=$1 AND a.membership_id=$2 AND a.profile_status IN ('pending','failed','current')
          AND a.profile_revision=$3 AND a.requested_revision=$4
          AND a.next_attempt_at=$5::timestamptz
          AND EXISTS(SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m
            WHERE m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL)`,
          [
            candidate.member_id,
            candidate.membership_id,
            candidate.profile_revision,
            candidate.requested_revision,
            candidate.next_attempt_at,
          ],
        );
    });
  }

  async function project(workspaceId: string) {
    const candidates = await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const registration = await workspaceMembersTable(tx);
      if (!registration) return [];
      await lockCatalogs(tx, [registration.coreDefinition.id]);
      const generation = await activeGeneration(tx, registration.coreDefinition.id);
      const expired = z.array(z.object({ id: z.uuid() })).parse(
        (
          await tx.client.query(
            `SELECT r.id FROM ${qualified(tx.schema, generation.physical_table)} r
          WHERE r.${fieldColumn(workspaceMemberFields.access)}=$1 AND NOT EXISTS(
            SELECT 1 FROM ${qualified(tx.schema, 'tf_invitations')} i WHERE i.workspace_member_id=r.id
              AND i.revoked_at IS NULL AND i.consumed_membership_id IS NULL AND i.expires_at>clock_timestamp())
          ORDER BY r.id LIMIT 10`,
            [workspaceMemberAccess.invited],
          )
        ).rows,
      );
      for (const row of expired) await refreshWorkspaceMemberAccess(tx, row.id);
      return z.array(candidateSchema).parse(
        (
          await tx.client.query(`SELECT a.member_id,a.membership_id,a.user_id,
        a.profile_revision::text,a.requested_revision::text,a.next_attempt_at::text
        FROM ${qualified(tx.schema, 'tf_workspace_member_accounts')} a
        JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
        WHERE a.profile_status IN ('pending','failed','current') AND a.next_attempt_at<=clock_timestamp()
        ORDER BY a.next_attempt_at,a.member_id LIMIT 10`)
        ).rows,
      );
    });
    if (!candidates.length) return { applied: 0, unchanged: 0, detached: 0, stale: 0 };
    let profiles: Map<string, z.infer<typeof memberProfileSchema>>;
    try {
      profiles = new Map(
        (
          await options.source.read(
            workspaceId,
            candidates.map(row => row.user_id),
          )
        ).map(profile => [profile.id, profile]),
      );
    } catch (cause) {
      await recordFailures(workspaceId, candidates);
      throw new Error('Workspace member profile source unavailable', { cause });
    }
    const result = { applied: 0, unchanged: 0, detached: 0, stale: 0 };
    const failures: Error[] = [];
    for (const candidate of candidates) {
      try {
        const status = await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          const profile = profiles.get(candidate.user_id);
          if (!profile) {
            await lockAuthorization(tx);
            const active = (
              await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')}
              WHERE id=$1 AND user_id=$2 AND removed_at IS NULL`,
                [candidate.membership_id, candidate.user_id],
              )
            ).rowCount;
            if (active) throw new WorkspaceMemberError('member-profile-failed');
            return 'detached' as const;
          }
          return projectWorkspaceMemberProfile(tx, {
            memberId: candidate.member_id,
            membershipId: candidate.membership_id,
            profile,
          });
        });
        result[status]++;
      } catch (cause) {
        await recordFailures(workspaceId, [candidate]);
        failures.push(new Error('Workspace member profile projection failed', { cause }));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Workspace member profile projection failed');
    return result;
  }

  return { dispatch, project };
}
