import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { table, loadIntegration, type GoogleOperationRuntime } from './operation-store.ts';
import {
  heartbeatSettingsSchema,
  heartbeatViewSchema,
  HeartbeatError,
  type HeartbeatWork,
} from './heartbeat-contracts.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export const heartbeatCompatibility = commonCompatibility;
export const checkpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle'), cursor: z.string() }),
  z.object({ kind: z.literal('history'), cursor: z.string(), token: z.string().nullable(), cycle: z.uuid() }),
  z.object({
    kind: z.literal('matching'),
    cursor: z.string(),
    anchor: z.string(),
    token: z.string().nullable(),
    cycle: z.uuid(),
    recovery: z.boolean(),
  }),
]);
export type Checkpoint = z.infer<typeof checkpointSchema>;
export const heartbeatRowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  user_id: z.string(),
  integration_id: z.uuid(),
  account_id: z.string(),
  generation: z.number().int(),
  revision: z.number().int(),
  settings: heartbeatSettingsSchema,
  enabled: z.boolean(),
  enabled_at: z.date(),
  checkpoint: checkpointSchema,
  epoch: z.number().int(),
  lease_until: z.date().nullable(),
  gap_notice: z.literal('history-expired-deleted-mail-unavailable').nullable(),
  last_error: z.string().nullable(),
});
export type HeartbeatRow = z.infer<typeof heartbeatRowSchema>;
export const heartbeatScopes = ['https://www.googleapis.com/auth/gmail.modify'];
export function heartbeatActor(row: HeartbeatRow): HumanActor {
  return { kind: 'human', userId: row.user_id, membershipId: uuidSchema.parse(row.membership_id) };
}
export function heartbeatFence(workspaceId: string, row: HeartbeatRow) {
  return {
    workspaceId,
    actor: heartbeatActor(row),
    integrationId: row.integration_id,
    accountId: row.account_id,
    generation: row.generation,
    requiredScopes: heartbeatScopes,
  };
}
export function heartbeatView(row?: HeartbeatRow, fresh = true) {
  return heartbeatViewSchema.parse(
    row
      ? {
          ...row.settings,
          revision: row.revision,
          integrationId: row.integration_id,
          accountId: row.account_id,
          generation: row.generation,
          state: !row.enabled ? 'disabled' : fresh ? 'ready' : 'reconnect-required',
          gapNotice: row.gap_notice,
          lastError: row.last_error,
        }
      : {
          ...heartbeatSettingsSchema.parse({}),
          revision: 0,
          integrationId: null,
          accountId: null,
          generation: null,
          state: 'disabled',
          gapNotice: null,
          lastError: null,
        },
  );
}
export async function loadHeartbeat(tx: AuthorizationTransaction, id: string) {
  return heartbeatRowSchema
    .optional()
    .parse((await tx.client.query(`SELECT * FROM ${table(tx, 'heartbeats')} WHERE id=$1 FOR UPDATE`, [id])).rows[0]);
}
export async function currentHeartbeat(tx: AuthorizationTransaction, row: HeartbeatRow) {
  const actor = heartbeatActor(row);
  await currentMember(tx, actor);
  await tx.client.query(`SELECT id FROM ${table(tx, 'integrations')} WHERE id=$1 FOR SHARE`, [row.integration_id]);
  const integration = await loadIntegration(tx, actor, heartbeatScopes);
  if (
    integration.integrationId !== row.integration_id ||
    integration.accountId !== row.account_id ||
    integration.generation !== row.generation
  )
    throw new HeartbeatError('heartbeat-stale');
}
export function heartbeatTransactions(runtime: GoogleOperationRuntime) {
  const transaction = <T>(workspaceId: string, run: (tx: AuthorizationTransaction) => Promise<T>) =>
    runtime.transaction(uuidSchema.parse(workspaceId), heartbeatCompatibility, async tx => {
      await lockAuthorization(tx);
      return run(tx);
    });
  return {
    transaction,
    owner: <T>(
      workspaceId: string,
      userId: string,
      run: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
    ) =>
      transaction(workspaceId, async tx => {
        const actor = await resolveHuman(tx, userId);
        await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 841734))', [
          `${tx.schema}:${actor.membershipId}`,
        ]);
        return run(tx, actor);
      }),
    fenced: <T>(
      work: HeartbeatWork,
      epoch: number,
      run: (tx: AuthorizationTransaction, row: HeartbeatRow) => Promise<T>,
    ) =>
      transaction(work.workspaceId, async tx => {
        const row = await loadHeartbeat(tx, work.heartbeatId);
        if (!row || !row.enabled || row.epoch !== epoch || !row.lease_until || row.lease_until.getTime() <= Date.now())
          throw new HeartbeatError('heartbeat-stale');
        await currentHeartbeat(tx, row);
        return run(tx, row);
      }),
  };
}
export function historyCheckpoint(cursor: string): Extract<Checkpoint, { kind: 'history' }> {
  return { kind: 'history', cursor, token: null, cycle: randomUUID() };
}
