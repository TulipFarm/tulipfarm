import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  requireCurrentActor,
  uuidSchema,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { chatAccess } from './chat-access.ts';
import { ConversationConflict } from './contracts.ts';
import { type ConversationRuntime } from './runtime.ts';
import { turnRequester } from './turn-requester.ts';

const originSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('autonomous') }),
  z.strictObject({
    kind: z.literal('linked'),
    conversationId: uuidSchema,
    turnId: uuidSchema,
    generation: z.number().int().nonnegative(),
    epoch: z.number().int().positive(),
  }),
]);
const claimSchema = z.strictObject({
  workspaceId: uuidSchema,
  runId: uuidSchema,
  ownerId: uuidSchema,
  origin: originSchema,
});
export const internalFenceSchema = claimSchema.extend({ epoch: z.number().int().positive() });
export type InternalFence = z.infer<typeof internalFenceSchema>;
const partSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z
      .string()
      .min(1)
      .refine(text => Buffer.byteLength(text) <= 65536),
  }),
  z.strictObject({ kind: z.literal('tool'), callId: uuidSchema }),
]);
const appendSchema = z.strictObject({ producerId: uuidSchema, parts: z.array(partSchema).min(1).max(32) });
const rootSchema = z.object({
  id: uuidSchema,
  origin_conversation_id: uuidSchema.nullable(),
  origin_turn_id: uuidSchema.nullable(),
  next_sequence: z.number().int(),
});
const claimRowSchema = z.object({ owner_id: uuidSchema, epoch: z.number().int(), live: z.boolean() });
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export const internalCompatibility = commonCompatibility;

async function origin(tx: AuthorizationTransaction, input: z.infer<typeof claimSchema>, waiting = false) {
  await requireCurrentActor(tx, { kind: 'agent', runId: input.runId });
  const run = z
    .object({
      kind: z.enum(['delegated', 'scheduled']),
      user_id: z.string().nullable(),
      membership_id: uuidSchema.nullable(),
    })
    .parse(
      (
        await tx.client.query(`SELECT kind, user_id, membership_id FROM ${table(tx, 'tf_agent_runs')} WHERE id = $1`, [
          input.runId,
        ])
      ).rows[0],
    );
  if (input.origin.kind === 'autonomous') {
    if (run.kind !== 'scheduled') throw new AccessDenied();
    return;
  }
  const value = input.origin;
  if (run.kind !== 'delegated' || !run.user_id || !run.membership_id) throw new AccessDenied();
  await chatAccess(
    tx,
    { kind: 'human', userId: run.user_id, membershipId: run.membership_id },
    value.conversationId,
    'read',
    true,
  );
  const turn = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id = $1 AND conversation_id = $2 AND generation = $3 AND attempt_epoch = $4 AND ((status = 'processing' AND lease_until > clock_timestamp()) OR ($5 AND status = 'waiting'))`,
    [value.turnId, value.conversationId, value.generation, value.epoch, waiting],
  );
  if (!turn.rowCount) throw new AccessDenied();
  const requester = await turnRequester(tx, value.conversationId, value.turnId);
  if (requester.userId !== run.user_id || requester.membershipId !== run.membership_id) throw new AccessDenied();
}

async function root(tx: AuthorizationTransaction, input: z.infer<typeof claimSchema>) {
  const row = rootSchema
    .optional()
    .parse(
      (
        await tx.client.query(`SELECT * FROM ${table(tx, 'tf_internal_conversations')} WHERE id = $1 FOR UPDATE`, [
          input.runId,
        ])
      ).rows[0],
    );
  if (
    !row ||
    row.origin_conversation_id !== (input.origin.kind === 'linked' ? input.origin.conversationId : null) ||
    row.origin_turn_id !== (input.origin.kind === 'linked' ? input.origin.turnId : null)
  )
    throw new AccessDenied();
  return row;
}

export async function lockInternalFence(tx: AuthorizationTransaction, input: InternalFence, waiting = false) {
  await origin(tx, input, waiting);
  const row = await root(tx, input);
  const claim = claimRowSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT owner_id, epoch, lease_until > clock_timestamp() AS live FROM ${table(tx, 'tf_conversation_runtime_claims')} WHERE conversation_id = $1 FOR UPDATE`,
          [input.runId],
        )
      ).rows[0],
    );
  if (!claim || !claim.live || claim.epoch !== input.epoch || claim.owner_id !== input.ownerId)
    throw new AccessDenied();
  return row;
}

export function createInternalConversations(runtime: ConversationRuntime) {
  const fence = lockInternalFence;
  async function transaction<T>(
    workspaceId: string,
    operation: (tx: AuthorizationTransaction) => Promise<T>,
    mode: 'read' | 'write' = 'read',
  ) {
    return runtime.transaction(workspaceId, internalCompatibility, async tx => {
      await lockAuthorization(tx, mode);
      return operation(tx);
    });
  }

  async function claim(value: unknown): Promise<InternalFence | null> {
    const input = claimSchema.parse(value);
    return transaction(
      input.workspaceId,
      async tx => {
        await origin(tx, input);
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_internal_conversations')} (id, origin_conversation_id, origin_turn_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [
            input.runId,
            input.origin.kind === 'linked' ? input.origin.conversationId : null,
            input.origin.kind === 'linked' ? input.origin.turnId : null,
          ],
        );
        await root(tx, input);
        const previous = claimRowSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT owner_id, epoch, lease_until > clock_timestamp() AS live FROM ${table(tx, 'tf_conversation_runtime_claims')} WHERE conversation_id = $1 FOR UPDATE`,
                [input.runId],
              )
            ).rows[0],
          );
        if (previous?.live && previous.owner_id !== input.ownerId) return null;
        if (previous?.live) return { ...input, epoch: previous.epoch };
        const epoch = (previous?.epoch ?? 0) + 1;
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_runtime_claims')} (conversation_id, owner_id, epoch, lease_until) VALUES ($1,$2,$3,clock_timestamp() + interval '60 seconds') ON CONFLICT (conversation_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, epoch = EXCLUDED.epoch, lease_until = EXCLUDED.lease_until`,
          [input.runId, input.ownerId, epoch],
        );
        return { ...input, epoch };
      },
      'write',
    );
  }

  async function renew(value: unknown) {
    const input = internalFenceSchema.parse(value);
    return transaction(input.workspaceId, async tx => {
      await fence(tx, input);
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_runtime_claims')} SET lease_until = clock_timestamp() + interval '60 seconds' WHERE conversation_id = $1`,
        [input.runId],
      );
    });
  }

  async function append(value: unknown, content: unknown) {
    const input = internalFenceSchema.parse(value),
      message = appendSchema.parse(content);
    const digest = createHash('sha256').update(JSON.stringify(message.parts)).digest('hex');
    return transaction(input.workspaceId, async tx => {
      const conversation = await fence(tx, input);
      const previous = z
        .object({ id: uuidSchema, input_digest: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id, input_digest FROM ${table(tx, 'tf_internal_messages')} WHERE conversation_id = $1 AND producer_id = $2`,
              [input.runId, message.producerId],
            )
          ).rows[0],
        );
      if (previous) {
        if (previous.input_digest !== digest) throw new ConversationConflict('command-conflict');
        return { messageId: previous.id };
      }
      const id = randomUUID();
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_internal_messages')} (id, conversation_id, sequence, producer_id, input_digest, epoch) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, input.runId, conversation.next_sequence, message.producerId, digest, input.epoch],
      );
      for (const [ordinal, part] of message.parts.entries()) {
        if (
          part.kind === 'tool' &&
          !(
            await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_agent_tool_calls')} WHERE id = $1 AND run_id = $2`, [
              part.callId,
              input.runId,
            ])
          ).rowCount
        )
          throw new AccessDenied();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_internal_parts')} (conversation_id, message_id, ordinal, kind, text, call_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.runId,
            id,
            ordinal,
            part.kind,
            part.kind === 'text' ? part.text : null,
            part.kind === 'tool' ? part.callId : null,
          ],
        );
      }
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_internal_conversations')} SET next_sequence = next_sequence + 1 WHERE id = $1`,
        [input.runId],
      );
      return { messageId: id };
    });
  }

  async function history(value: unknown, after = 0) {
    const input = internalFenceSchema.parse(value);
    after = z.number().int().nonnegative().parse(after);
    return transaction(input.workspaceId, async tx => {
      await fence(tx, input);
      return z.array(z.object({ id: uuidSchema, sequence: z.number().int(), parts: z.array(partSchema) })).parse(
        (
          await tx.client.query(
            `SELECT m.id, m.sequence,
        (SELECT jsonb_agg(CASE WHEN p.kind = 'text' THEN jsonb_build_object('kind','text','text',p.text) ELSE jsonb_build_object('kind','tool','callId',p.call_id) END ORDER BY p.ordinal) FROM ${table(tx, 'tf_internal_parts')} p WHERE p.message_id = m.id) AS parts
        FROM ${table(tx, 'tf_internal_messages')} m WHERE m.conversation_id = $1 AND m.sequence > $2 ORDER BY m.sequence LIMIT 50`,
            [input.runId, after],
          )
        ).rows,
      );
    });
  }

  async function publishTool(value: unknown, content: unknown) {
    const input = internalFenceSchema.parse(value);
    const publication = z.strictObject({ producerId: uuidSchema, callId: uuidSchema }).parse(content);
    return transaction(input.workspaceId, async tx => {
      await fence(tx, input);
      if (input.origin.kind !== 'linked') throw new AccessDenied();
      const previous = z
        .object({ call_id: uuidSchema, message_id: uuidSchema })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT call_id, message_id FROM ${table(tx, 'tf_internal_publications')} WHERE internal_id = $1 AND producer_id = $2`,
              [input.runId, publication.producerId],
            )
          ).rows[0],
        );
      if (previous) {
        if (previous.call_id !== publication.callId) throw new ConversationConflict('command-conflict');
        return { messageId: previous.message_id };
      }
      const call = z
        .object({ status: z.enum(['pending', 'waiting', 'completed', 'blocked', 'failed']) })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT status FROM ${table(tx, 'tf_agent_tool_calls')} WHERE run_id = $1 AND id = $2`,
              [input.runId, publication.callId],
            )
          ).rows[0],
        );
      if (!call) throw new AccessDenied();
      const labels = {
        pending: 'Tool queued.',
        waiting: 'Tool waiting.',
        completed: 'Tool completed.',
        blocked: 'Tool blocked.',
        failed: 'Tool failed.',
      };
      const id = randomUUID(),
        chatId = input.origin.conversationId;
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id, conversation_id, sequence, author_kind) SELECT $1,id,next_message_sequence,'assistant' FROM ${table(tx, 'tf_conversations')} WHERE id = $2`,
        [id, chatId],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, text) VALUES ($1,$2,0,'text',$3)`,
        [chatId, id, labels[call.status]],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_internal_publications')} (internal_id, producer_id, call_id, status, conversation_id, message_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.runId, publication.producerId, publication.callId, call.status, chatId, id],
      );
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence = next_message_sequence + 1 WHERE id = $1`,
        [chatId],
      );
      return { messageId: id };
    });
  }

  return { claim, renew, append, history, publishTool };
}
