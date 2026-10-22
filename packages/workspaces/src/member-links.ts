import { z } from 'zod';
import { lockAuthorization, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  activeGeneration,
  lockCatalogs,
  lockIdentities,
  readRecord,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import { workspaceMemberIdSchema, WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import { canonicalEmail, canonicalEmailSql } from './canonical-email.ts';

export async function requireWorkspaceMember(tx: AuthorizationTransaction, id: string) {
  const memberId = workspaceMemberIdSchema.parse(id);
  const registration = await workspaceMembersTable(tx);
  if (!registration) throw new WorkspaceMemberError('member-unavailable');
  const tableId = registration.coreDefinition.id;
  await lockCatalogs(tx, [tableId]);
  await lockIdentities(tx, [{ tableId, recordId: memberId }]);
  const generation = await activeGeneration(tx, tableId);
  const row = await readRecord(tx, generation, memberId);
  if (!row) throw new WorkspaceMemberError('member-unavailable');
  return { tableId, row };
}

export async function requireWorkspaceMemberInvitation(
  tx: AuthorizationTransaction,
  input: {
    memberId: string;
    email: string;
    recipientUserIds: string[];
  },
) {
  await requireWorkspaceMember(tx, input.memberId);
  const accounts = qualified(tx.schema, 'tf_workspace_member_accounts');
  const invitations = qualified(tx.schema, 'tf_invitations');
  if (
    (
      await tx.client.query(`SELECT 1 FROM ${accounts} WHERE member_id=$1 AND NOT(user_id=ANY($2::text[]))`, [
        input.memberId,
        input.recipientUserIds,
      ])
    ).rowCount
  )
    throw new WorkspaceMemberError('member-link-conflict');
  if (
    (
      await tx.client.query(
        `SELECT 1 FROM ${invitations} WHERE workspace_member_id=$1
    AND revoked_at IS NULL AND consumed_membership_id IS NULL AND expires_at>clock_timestamp()
    AND ${canonicalEmailSql('email')}<>$2 LIMIT 1`,
        [input.memberId, canonicalEmail(input.email)],
      )
    ).rowCount
  ) {
    throw new WorkspaceMemberError('member-link-conflict');
  }
}

export async function bindWorkspaceMemberAccount(
  tx: AuthorizationTransaction,
  input: {
    memberId: string;
    userId: string;
    membershipId: string;
  },
) {
  const memberId = workspaceMemberIdSchema.parse(input.memberId);
  const membershipId = z.uuid().parse(input.membershipId);
  const userId = z.string().min(1).parse(input.userId);
  await lockAuthorization(tx, 'write');
  const { tableId } = await requireWorkspaceMember(tx, memberId);
  const accounts = qualified(tx.schema, 'tf_workspace_member_accounts');
  const conflicts = await tx.client.query(
    `SELECT 1 FROM ${accounts}
    WHERE (member_id=$1 AND user_id<>$2) OR (user_id=$2 AND member_id<>$1) LIMIT 1`,
    [memberId, userId],
  );
  if (conflicts.rowCount) throw new WorkspaceMemberError('member-link-conflict');
  const result = await tx.client.query(
    `INSERT INTO ${accounts} AS a(member_id,table_id,user_id,membership_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET membership_id=EXCLUDED.membership_id,
      profile_status='pending',profile_error=NULL,next_attempt_at=clock_timestamp()
    WHERE a.member_id=EXCLUDED.member_id RETURNING member_id`,
    [memberId, tableId, userId, membershipId],
  );
  if (!result.rowCount) throw new WorkspaceMemberError('member-link-conflict');
}
