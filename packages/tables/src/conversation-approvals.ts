import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  requireTablePermission,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { internalFenceSchema, lockInternalFence } from '@tulipfarm/conversations/internal';
import {
  approvalDecisionSchema,
  approvalInputSchema,
  approvalOutcomeSchema,
  approvalViewSchema,
} from '@tulipfarm/conversations/approval-contracts';
import { ConversationConflict } from '@tulipfarm/conversations';
import { catalog, table, type TableRuntime } from './service-store.ts';
import { lockConfirmationProposal, recordTableConfirmation } from './maintenance.ts';
import { canonicalJson } from './canonical.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { recordConversationActivity } from '@tulipfarm/conversations/activity';

const requestSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  turn_id: uuidSchema,
  internal_id: uuidSchema,
  revision: z.number().int(),
  membership_id: uuidSchema,
  prompt: z.string(),
  migration_id: uuidSchema,
  table_id: uuidSchema,
  plan_digest: z.string(),
  expected_applied_revision: z.string().nullable(),
  destructive_effect: z.unknown(),
  expires_at: z.date(),
  expired: z.boolean(),
  generation: z.number().int(),
  attempt_epoch: z.number().int(),
});
type ApprovalRequest = z.infer<typeof requestSchema>;
const winnerSchema = z.object({
  resolution: approvalOutcomeSchema.shape.status,
  membership_id: uuidSchema.nullable(),
  command_id: uuidSchema.nullable(),
  requested_decision: z.string().nullable(),
  confirmation_id: uuidSchema.nullable(),
});
const outcome = (row: ApprovalRequest, winner: z.infer<typeof winnerSchema>) => ({
  requestId: row.id,
  revision: row.revision,
  status: winner.resolution,
  confirmationId: winner.confirmation_id,
});

async function load(tx: AuthorizationTransaction, id: string) {
  const row = requestSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT *,expires_at <= clock_timestamp() AS expired FROM ${table(tx, 'tf_conversation_approval_requests')} WHERE id=$1`,
          [id],
        )
      ).rows[0],
    );
  if (!row) throw new AccessDenied();
  return row;
}
async function owned(tx: AuthorizationTransaction, row: ApprovalRequest, actor: HumanActor) {
  if (
    row.membership_id !== actor.membershipId ||
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE id=$1 AND kind='private' AND owner_user_id=$2 AND owner_membership_id=$3 FOR UPDATE`,
        [row.conversation_id, actor.userId, actor.membershipId],
      )
    ).rowCount
  )
    throw new AccessDenied();
}
async function winner(tx: AuthorizationTransaction, id: string) {
  return winnerSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${table(tx, 'tf_conversation_approval_resolutions')} WHERE request_id=$1`,
          [id],
        )
      ).rows[0],
    );
}
async function publish(
  tx: AuthorizationTransaction,
  chatId: string,
  id: string,
  kind: 'approval' | 'approval-resolution',
  actor?: HumanActor,
) {
  const messageId = randomUUID();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) SELECT $1,id,next_message_sequence,$3,$4 FROM ${table(tx, 'tf_conversations')} WHERE id=$2`,
    [messageId, chatId, actor ? 'human' : 'assistant', actor?.membershipId ?? null],
  );
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,approval_id) VALUES ($1,$2,0,$3,$4)`,
    [chatId, messageId, kind, id],
  );
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence=next_message_sequence+1 WHERE id=$1`,
    [chatId],
  );
  if (actor || kind === 'approval') await recordConversationActivity(tx, chatId);
}

export function createTableApprovalRequests(runtime: TableRuntime) {
  async function create(value: unknown, content: unknown) {
    const fence = internalFenceSchema.parse(value),
      input = approvalInputSchema.parse(content);
    if (fence.origin.kind !== 'linked') throw new AccessDenied();
    const origin = fence.origin;
    return runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const run = z
        .object({ user_id: z.string(), membership_id: uuidSchema })
        .parse(
          (
            await tx.client.query(
              `SELECT user_id,membership_id FROM ${table(tx, 'tf_agent_runs')} WHERE id=$1 AND kind='delegated'`,
              [fence.runId],
            )
          ).rows[0],
        );
      const actor: HumanActor = { kind: 'human', userId: run.user_id, membershipId: run.membership_id };
      const proposal = await lockConfirmationProposal(tx, actor, input.migrationId, input.planDigest);
      await requireTablePermission(
        tx,
        { kind: 'agent', runId: fence.runId },
        proposal.job.table_id,
        'table.schema.manage',
      );
      await lockInternalFence(tx, fence, true);
      const previous = (
        await tx.client.query(
          `SELECT id FROM ${table(tx, 'tf_conversation_approval_requests')} WHERE internal_id=$1 AND producer_id=$2`,
          [fence.runId, input.producerId],
        )
      ).rows[0];
      if (previous) {
        const row = await load(tx, uuidSchema.parse(previous.id));
        if (
          row.prompt !== input.prompt ||
          row.migration_id !== input.migrationId ||
          row.plan_digest !== input.planDigest
        )
          throw new ConversationConflict('command-conflict');
        return { requestId: row.id, revision: row.revision };
      }
      await lockInternalFence(tx, fence);
      const conflicts = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_confirmations')} WHERE migration_id=$1 UNION ALL SELECT 1 FROM ${table(tx, 'tf_table_controls')} WHERE migration_id=$1 AND operation='reject' UNION ALL SELECT 1 FROM ${table(tx, 'tf_conversation_approval_requests')} WHERE migration_id=$1`,
        [input.migrationId],
      );
      if (conflicts.rowCount) throw new ConversationConflict('request-conflict');
      const id = randomUUID(),
        job = proposal.job;
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_approval_requests')} (id,conversation_id,turn_id,internal_id,producer_id,membership_id,prompt,migration_id,table_id,plan_digest,expected_applied_revision,destructive_effect,generation,attempt_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          origin.conversationId,
          origin.turnId,
          fence.runId,
          input.producerId,
          actor.membershipId,
          input.prompt,
          job.id,
          job.table_id,
          input.planDigest,
          job.expected_applied_revision,
          proposal.plan.impact,
          origin.generation,
          origin.epoch,
        ],
      );
      await publish(tx, origin.conversationId, id, 'approval');
      await lockInternalFence(tx, fence);
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL WHERE id=$1`,
        [origin.turnId],
      );
      return { requestId: id, revision: 1 };
    });
  }

  async function read(workspaceId: string, userId: string, chatId: string, requestId: string) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId),
        row = await load(tx, uuidSchema.parse(requestId));
      if (row.conversation_id !== uuidSchema.parse(chatId)) throw new AccessDenied();
      await requireTablePermission(tx, actor, row.table_id, 'table.schema.manage');
      await owned(tx, row, actor);
      const resolution = await winner(tx, row.id);
      return approvalViewSchema.parse({
        id: row.id,
        turnId: row.turn_id,
        revision: row.revision,
        prompt: row.prompt,
        expiresAt: row.expires_at.toISOString(),
        action: {
          kind: 'table-migration',
          migrationId: row.migration_id,
          tableId: row.table_id,
          planDigest: row.plan_digest,
          expectedAppliedRevision: row.expected_applied_revision,
          effect: row.destructive_effect,
        },
        resolution: resolution ? outcome(row, resolution) : null,
      });
    });
  }

  async function due(workspaceId: string) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      return z
        .array(uuidSchema)
        .parse(
          (
            await tx.client.query(
              `SELECT r.id FROM ${table(tx, 'tf_conversation_approval_requests')} r WHERE r.expires_at <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_approval_resolutions')} s WHERE s.request_id=r.id) ORDER BY r.expires_at,r.id LIMIT 50`,
            )
          ).rows.map(row => row.id),
        );
    });
  }
  async function readForRuntime(value: unknown, requestId: string) {
    const fence = internalFenceSchema.parse(value);
    return runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const row = await load(tx, uuidSchema.parse(requestId));
      await requireTablePermission(tx, { kind: 'agent', runId: fence.runId }, row.table_id, 'table.schema.manage');
      await lockInternalFence(tx, fence);
      if (
        fence.origin.kind !== 'linked' ||
        row.internal_id !== fence.runId ||
        row.conversation_id !== fence.origin.conversationId ||
        row.turn_id !== fence.origin.turnId
      )
        throw new AccessDenied();
      const resolution = await winner(tx, row.id);
      return resolution ? outcome(row, resolution) : null;
    });
  }
  return { create, read, due, readForRuntime };
}

export function createTableApprovalResolver(options: {
  runtime: TableRuntime;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
}) {
  async function resolve(
    workspaceId: string,
    requestId: string,
    human?: { userId: string; chatId: string; input: z.infer<typeof approvalDecisionSchema> },
  ) {
    workspaceId = uuidSchema.parse(workspaceId);
    requestId = uuidSchema.parse(requestId);
    const actor = human
      ? await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx);
          return resolveHuman(tx, human.userId);
        })
      : null;
    const connectionString = await options.resolveConfirmationCredential(workspaceId);
    return withMaintenanceTransaction({
      connectionString,
      workspaceId,
      capability: 'confirmation',
      operation: async tx => {
        await lockAuthorization(tx);
        let row = await load(tx, requestId);
        await catalog(tx, row.table_id, 'write');
        if (actor && human) {
          await currentMember(tx, actor);
          if (row.conversation_id !== human.chatId) throw new AccessDenied();
          await requireTablePermission(tx, actor, row.table_id, 'table.schema.manage');
          await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 184735))', [
            `${tx.schema}:${actor.membershipId}:${human.input.commandId}`,
          ]);
          await owned(tx, row, actor);
          if (row.revision !== human.input.expectedRevision) throw new ConversationConflict('request-conflict');
        } else
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
            row.conversation_id,
          ]);
        row = await load(tx, requestId);
        const prior = await winner(tx, row.id);
        if (prior) {
          if (
            human &&
            (prior.command_id !== human.input.commandId ||
              prior.membership_id !== actor?.membershipId ||
              prior.requested_decision !== human.input.decision)
          )
            throw new ConversationConflict('request-conflict');
          return outcome(row, prior);
        }
        if (!human && !row.expired) throw new ConversationConflict('request-conflict');
        if (
          actor &&
          human &&
          (
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_conversation_commands')} WHERE membership_id=$1 AND command_id=$2`,
              [actor.membershipId, human.input.commandId],
            )
          ).rowCount
        )
          throw new ConversationConflict('command-conflict');
        const turn = z
          .object({ status: z.string(), generation: z.number().int(), attempt_epoch: z.number().int() })
          .parse(
            (
              await tx.client.query(
                `SELECT status,generation,attempt_epoch FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 FOR UPDATE`,
                [row.turn_id],
              )
            ).rows[0],
          );
        let waiting =
          turn.status === 'waiting' && turn.generation === row.generation && turn.attempt_epoch === row.attempt_epoch;
        if (!waiting && !(row.expired && ['blocked', 'cancelled'].includes(turn.status)))
          throw new ConversationConflict('request-conflict');
        if (
          !human &&
          waiting &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_memberships')} m JOIN ${table(tx, 'tf_conversations')} c ON c.owner_membership_id=m.id AND c.owner_user_id=m.user_id WHERE c.id=$1 AND m.removed_at IS NULL`,
              [row.conversation_id],
            )
          ).rowCount
        ) {
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='blocked',attempt_epoch=attempt_epoch+1,error_code='membership-removed' WHERE id=$1`,
            [row.turn_id],
          );
          waiting = false;
        }
        let confirmationId: string | null = null,
          rejectionId: string | null = null;
        const status = row.expired
          ? 'expired'
          : human?.input.decision === 'approve'
            ? 'approved'
            : human?.input.decision === 'reject'
              ? 'rejected'
              : 'cancelled';
        if (actor && human && (status === 'approved' || status === 'rejected')) {
          const proposal = await lockConfirmationProposal(tx, actor, row.migration_id, row.plan_digest);
          if (
            proposal.job.table_id !== row.table_id ||
            proposal.job.expected_applied_revision !== row.expected_applied_revision ||
            canonicalJson(proposal.plan.impact) !== canonicalJson(row.destructive_effect)
          )
            throw new ConversationConflict('request-conflict');
          if ((await load(tx, row.id)).expired) throw new ConversationConflict('request-conflict');
          if (status === 'approved')
            confirmationId = (await recordTableConfirmation(tx, workspaceId, actor, proposal, row.expires_at)).id;
          else {
            rejectionId = randomUUID();
            await tx.client.query(
              `INSERT INTO ${table(tx, 'tf_table_controls')} (id,migration_id,membership_id,operation) VALUES ($1,$2,$3,'reject')`,
              [rejectionId, row.migration_id, actor.membershipId],
            );
          }
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_approval_resolutions')} (request_id,request_revision,resolution,membership_id,command_id,confirmation_id,rejection_id,requested_decision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.id,
            row.revision,
            status,
            actor?.membershipId ?? null,
            human?.input.commandId ?? null,
            confirmationId,
            rejectionId,
            human?.input.decision ?? null,
          ],
        );
        if (waiting) {
          await publish(tx, row.conversation_id, row.id, 'approval-resolution', actor ?? undefined);
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='queued',generation=generation+1,attempt_epoch=attempt_epoch+1,attempts=0,lease_until=NULL,retry_at=NULL,error_code=NULL WHERE id=$1`,
            [row.turn_id],
          );
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id,conversation_id,generation) SELECT id,conversation_id,generation FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1`,
            [row.turn_id],
          );
        }
        if (status === 'approved' && (await load(tx, row.id)).expired)
          throw new ConversationConflict('request-conflict');
        const result = { requestId: row.id, revision: row.revision, status, confirmationId };
        if (actor && human)
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_commands')} (membership_id,command_id,operation,conversation_id,input_digest,outcome) VALUES ($1,$2,'approval',$3,$4,$5)`,
            [
              actor.membershipId,
              human.input.commandId,
              row.conversation_id,
              createHash('sha256')
                .update(JSON.stringify({ requestId, ...human.input }))
                .digest('hex'),
              result,
            ],
          );
        return result;
      },
    });
  }
  return {
    decide: (workspaceId: string, userId: string, chatId: string, requestId: string, value: unknown) =>
      resolve(workspaceId, requestId, {
        userId,
        chatId: uuidSchema.parse(chatId),
        input: approvalDecisionSchema.parse(value),
      }),
    expire: (workspaceId: string, requestId: string) => resolve(workspaceId, requestId),
  };
}
