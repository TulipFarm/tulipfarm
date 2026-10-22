import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { AccountRuntime } from './accounts.ts';
import { accountProtocolSchema } from './account-contracts.ts';
import { OperationError, providerOperationSchema, sourceBindingSchema, receiptSchema } from './operation-contracts.ts';

export const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_atlassian_${name}`);
export const sourceRowSchema = z.object({
  id: z.uuid(),
  account_id: z.uuid(),
  membership_id: z.uuid(),
  name: z.string(),
  binding: sourceBindingSchema,
  enabled: z.boolean(),
});
export type SourceRow = z.infer<typeof sourceRowSchema>;
export const proposalRowSchema = z.object({
  id: z.uuid(),
  source_id: z.uuid(),
  membership_id: z.uuid(),
  command_id: z.uuid(),
  operation: providerOperationSchema,
  account_generation: z.number().int(),
  grants_version: z.number().int(),
  configuration_digest: z.string(),
  digest: z.string(),
  expires_at: z.date(),
  expired: z.boolean(),
});
export type ProposalRow = z.infer<typeof proposalRowSchema>;
const accountSchema = z.object({
  id: z.uuid(),
  protocol: accountProtocolSchema,
  ownership: z.enum(['personal', 'business']),
  owner_membership_id: z.uuid().nullable(),
  generation: z.number().int(),
  grants_version: z.number().int(),
  state: z.string(),
  expires_at: z.date().nullable(),
  config_hash: z.string(),
  resources: z.array(z.object({ id: z.string() })),
});
export function sourceView(row: SourceRow) {
  return { id: row.id, accountId: row.account_id, name: row.name, binding: row.binding, enabled: row.enabled };
}
export async function authorizeAccount(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
  const row = accountSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT id,protocol,ownership,owner_membership_id,generation,grants_version,state,expires_at,config_hash,resources FROM ${table(tx, 'accounts')} WHERE id=$1`,
          [id],
        )
      ).rows[0],
    );
  if (!row) throw new AccessDenied();
  if (row.ownership === 'personal') {
    if (row.owner_membership_id !== actor.membershipId) throw new AccessDenied();
  } else if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'account_member_grants')} WHERE account_id=$1 AND membership_id=$2
    UNION ALL SELECT 1 FROM ${table(tx, 'account_team_grants')} g JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.account_id=$1 AND mt.membership_id=$2 LIMIT 1`,
        [row.id, actor.membershipId],
      )
    ).rowCount
  )
    throw new AccessDenied();
  if (row.state !== 'active') throw new OperationError('operation-conflict');
  return row;
}
export async function loadSource(tx: AuthorizationTransaction, actor: HumanActor, id: string, allowDisabled = false) {
  const row = sourceRowSchema
    .optional()
    .parse(
      (
        await tx.client.query(`SELECT * FROM ${table(tx, 'sources')} WHERE id=$1 AND membership_id=$2`, [
          z.uuid().parse(id),
          actor.membershipId,
        ])
      ).rows[0],
    );
  if (!row) throw new AccessDenied();
  if (!row.enabled && !allowDisabled) throw new OperationError('operation-conflict');
  const account = await authorizeAccount(tx, actor, row.account_id);
  return { source: row, account };
}
export async function loadProposal(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
  const row = proposalRowSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${table(tx, 'proposals')} WHERE id=$1 AND membership_id=$2`,
          [z.uuid().parse(id), actor.membershipId],
        )
      ).rows[0],
    );
  if (!row) throw new AccessDenied();
  return row;
}
export async function proposalLock(tx: AuthorizationTransaction, id: string) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 734281))', [`${tx.schema}:${id}`]);
}
export async function decision(tx: AuthorizationTransaction, id: string) {
  return z
    .enum(['approve', 'reject'])
    .nullable()
    .parse(
      (await tx.client.query(`SELECT decision FROM ${table(tx, 'decisions')} WHERE proposal_id=$1`, [id])).rows[0]
        ?.decision ?? null,
    );
}
export async function receipt(tx: AuthorizationTransaction, id: string) {
  return receiptSchema
    .nullable()
    .parse(
      (await tx.client.query(`SELECT status,result,error FROM ${table(tx, 'receipts')} WHERE proposal_id=$1`, [id]))
        .rows[0] ?? null,
    );
}
export async function proposalView(tx: AuthorizationTransaction, row: ProposalRow, source: SourceRow) {
  return {
    id: row.id,
    source: sourceView(source),
    operation: row.operation,
    digest: row.digest,
    expiresAt: row.expires_at.toISOString(),
    decision: await decision(tx, row.id),
    receipt: await receipt(tx, row.id),
  };
}
export function authorized(runtime: AccountRuntime) {
  return <T>(
    workspaceId: string,
    principal: string | HumanActor,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    runtime.transaction(z.uuid().parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
}
export async function freshProposal(tx: AuthorizationTransaction, actor: HumanActor, row: ProposalRow) {
  const value = await loadSource(tx, actor, row.source_id);
  if (row.expired) throw new OperationError('operation-expired');
  if (!value.account.expires_at || value.account.expires_at.getTime() <= Date.now())
    throw new OperationError('operation-conflict');
  if (row.account_generation !== value.account.generation || row.grants_version !== value.account.grants_version)
    throw new OperationError('operation-conflict');
  return value;
}
