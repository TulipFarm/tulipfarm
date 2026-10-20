import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  currentMember,
  lockAuthorization,
  requireTablePermission,
  resolveHuman,
  type HumanActor,
} from '@tulipfarm/access';
import { activeGeneration, workspaceMembersTable } from '@tulipfarm/tables/store';
import {
  memberProfileSchema,
  workspaceMemberIdSchema,
  workspaceMembersStateSchema,
  WorkspaceMemberError,
} from '@tulipfarm/tables/workspace-members';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from './storage.ts';

type Transaction = Parameters<Parameters<WorkspaceRuntime['transaction']>[2]>[0];
const stateQuerySchema = z.strictObject({
  ids: z.array(workspaceMemberIdSchema).min(1).max(100).optional(),
  after: workspaceMemberIdSchema.optional(),
  limit: z.int().min(1).max(100).default(50),
  attention: z.boolean().default(false),
});

export function createWorkspaceMembers(runtime: Pick<WorkspaceRuntime, 'transaction'>) {
  async function read<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: Transaction, actor: HumanActor, tableId: string) => Promise<T>,
  ) {
    return runtime.transaction(z.uuid().parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      const registration = await workspaceMembersTable(tx);
      if (!registration) throw new WorkspaceMemberError('member-unavailable');
      await requireTablePermission(tx, actor, registration.coreDefinition.id, 'table.row.read');
      return operation(tx, actor, registration.coreDefinition.id);
    });
  }
  return {
    state(workspaceId: string, userId: string, input: unknown = {}) {
      const query = stateQuerySchema.parse(input);
      return read(workspaceId, userId, async (tx, actor, tableId) => {
        const generation = await activeGeneration(tx, tableId);
        const admin = (await currentMember(tx, actor)).role === 'admin';
        const editable = await canAccessTable(tx, actor, tableId, 'table.row.update');
        const creatable = await canAccessTable(tx, actor, tableId, 'table.row.create');
        const accounts = qualified(tx.schema, 'tf_workspace_member_accounts');
        const identities = qualified(tx.schema, 'tf_table_identities');
        const memberships = qualified(tx.schema, 'tf_memberships');
        const sync = (
          await tx.client.query(
            `SELECT
          count(*) FILTER(WHERE m.removed_at IS NULL AND a.profile_status='pending')::integer AS pending,
          count(*) FILTER(WHERE m.removed_at IS NULL AND a.profile_status='failed')::integer AS failed,
          count(*) FILTER(WHERE m.removed_at IS NOT NULL AND NOT i.live AND a.profile_revision=0)::integer AS "repairRequired"
          FROM ${accounts} a JOIN ${identities} i ON i.table_id=a.table_id AND i.row_id=a.member_id
          JOIN ${memberships} m ON m.id=a.membership_id AND m.user_id=a.user_id WHERE a.table_id=$1`,
            [tableId],
          )
        ).rows[0];
        const rows = z
          .array(
            z.object({
              id: workspaceMemberIdSchema,
              token: z.uuid(),
              live: z.boolean(),
              linked: z.boolean(),
              mine: z.boolean(),
              profile_status: z.string().nullable(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `SELECT i.row_id AS id,i.token,i.live,
          m.id IS NOT NULL AND m.removed_at IS NULL AS linked,COALESCE(a.user_id=$2,false) AS mine,a.profile_status
          FROM ${identities} i LEFT JOIN ${accounts} a ON a.table_id=i.table_id AND a.member_id=i.row_id
          LEFT JOIN ${memberships} m ON m.id=a.membership_id AND m.user_id=a.user_id
          WHERE i.table_id=$1 AND (i.live OR a.profile_revision=0)
            AND ($3::uuid[] IS NULL OR i.row_id=ANY($3)) AND ($4::uuid IS NULL OR i.row_id>$4)
            AND (NOT $6::boolean OR NOT i.live OR m.removed_at IS NULL AND a.profile_status IN ('pending','failed'))
          ORDER BY i.row_id LIMIT $5`,
                [tableId, actor.userId, query.ids ?? null, query.after ?? null, query.limit + 1, query.attention],
              )
            ).rows,
          );
        const members = rows.slice(0, query.limit).map(row => ({
          id: row.id,
          token: row.token,
          materialized: row.live,
          accountLinked: row.linked,
          profile: !row.linked ? (row.live ? 'manual' : 'repair-required') : row.profile_status,
          canRetry: row.linked && (admin || row.mine),
          canRepair: !row.linked && !row.live && creatable,
          canEditProfile: row.live && !row.linked && editable,
        }));
        return workspaceMembersStateSchema.parse({
          tableId,
          revision: generation.revision,
          sync,
          members,
          nextCursor: rows.length > query.limit ? members.at(-1)!.id : null,
        });
      });
    },
    retry(workspaceId: string, userId: string, memberIdInput: string) {
      const memberId = workspaceMemberIdSchema.parse(memberIdInput);
      return read(workspaceId, userId, async (tx, actor) => {
        const admin = (await currentMember(tx, actor)).role === 'admin';
        const queued = await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_workspace_member_accounts')} a
          SET profile_status='pending',profile_error=NULL,next_attempt_at=clock_timestamp()
          WHERE a.member_id=$1 AND ($2 OR a.user_id=$3)
            AND EXISTS(SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m
              WHERE m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL)`,
          [memberId, admin, actor.userId],
        );
        if (!queued.rowCount) throw new AccessDenied();
        return { status: 'pending' as const };
      });
    },
    photo(workspaceId: string, userId: string, memberIdInput: string, digestInput: string) {
      const memberId = workspaceMemberIdSchema.parse(memberIdInput),
        digest = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(digestInput);
      return read(workspaceId, userId, async (tx, _actor, tableId) => {
        const row = (
          await tx.client.query(
            `SELECT image FROM ${qualified(tx.schema, 'tf_workspace_member_images')}
          WHERE table_id=$1 AND member_id=$2 AND digest=$3`,
            [tableId, memberId, digest],
          )
        ).rows[0];
        if (!row) throw new AccessDenied();
        return memberProfileSchema.shape.image.unwrap().parse(row.image);
      });
    },
  };
}
