import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { GoogleWorkspaceError } from './contracts.ts';
import { googleOperationSchema } from './operation-contracts.ts';
import { googleReceiptSchema, GoogleLifecycleError, requiredScopes } from './lifecycle-contracts.ts';

export type GoogleOperationRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_google_${name}`);
const integrationSchema = z.object({
  id: z.uuid(),
  account_id: z.string().nullable(),
  generation: z.number().int(),
  status: z.enum(['connected', 'disconnected', 'reconnect-required']),
  scopes: z.array(z.string()),
});
export const proposalRowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  user_id: z.string(),
  command_id: z.uuid(),
  integration_id: z.uuid(),
  account_id: z.string(),
  generation: z.number().int(),
  scopes: z.array(z.string()),
  required_scopes: z.array(z.string()),
  operation: googleOperationSchema,
  digest: z.string(),
  expires_at: z.date(),
  expired: z.boolean(),
});
export type ProposalRow = z.infer<typeof proposalRowSchema>;
export function authorized(runtime: GoogleOperationRuntime) {
  return <T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx, await resolveHuman(tx, userId));
    });
}
export async function loadIntegration(tx: AuthorizationTransaction, actor: HumanActor, scopes: readonly string[]) {
  const row = integrationSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT id,account_id,generation,status,scopes FROM ${table(tx, 'integrations')} WHERE membership_id=$1 AND user_id=$2`,
          [actor.membershipId, actor.userId],
        )
      ).rows[0],
    );
  if (!row || row.status === 'disconnected') throw new GoogleLifecycleError('integration-required');
  if (row.status !== 'connected' || row.account_id === null) throw new GoogleWorkspaceError('reconnect-required');
  const missing = scopes.filter(scope => !row.scopes.includes(scope));
  if (missing.length) throw new GoogleWorkspaceError('insufficient-scope', missing);
  return {
    integrationId: row.id,
    accountId: row.account_id,
    generation: row.generation,
    scopes: [...new Set(row.scopes)].sort(),
    requiredScopes: [...scopes],
  };
}
export async function loadProposal(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
  const row = proposalRowSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${table(tx, 'proposals')} WHERE id=$1 AND membership_id=$2 AND user_id=$3`,
          [uuidSchema.parse(id), actor.membershipId, actor.userId],
        )
      ).rows[0],
    );
  if (!row) throw new AccessDenied();
  return row;
}
export async function proposalLock(tx: AuthorizationTransaction, id: string) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 734282))', [`${tx.schema}:${id}`]);
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
  return googleReceiptSchema
    .nullable()
    .parse(
      (await tx.client.query(`SELECT status,result,error FROM ${table(tx, 'receipts')} WHERE proposal_id=$1`, [id]))
        .rows[0] ?? null,
    );
}
export function integrationView(row: ProposalRow) {
  return {
    integrationId: row.integration_id,
    accountId: row.account_id,
    generation: row.generation,
    scopes: row.scopes,
    requiredScopes: row.required_scopes,
  };
}
export async function proposalView(tx: AuthorizationTransaction, row: ProposalRow) {
  return {
    id: row.id,
    operation: row.operation,
    integration: integrationView(row),
    digest: row.digest,
    expiresAt: row.expires_at.toISOString(),
    decision: await decision(tx, row.id),
    receipt: await receipt(tx, row.id),
  };
}
export async function freshProposal(tx: AuthorizationTransaction, actor: HumanActor, row: ProposalRow) {
  if (row.expired) throw new GoogleLifecycleError('operation-expired');
  const integration = await loadIntegration(tx, actor, requiredScopes(row.operation));
  if (
    integration.integrationId !== row.integration_id ||
    integration.accountId !== row.account_id ||
    integration.generation !== row.generation
  )
    throw new GoogleLifecycleError('operation-conflict');
  return integration;
}
