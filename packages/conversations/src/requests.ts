import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { chatAccess } from './chat-access.ts';
import { notifyConversationChange } from './event-publisher.ts';
import { turnRequester } from './turn-requester.ts';
import { ConversationConflict } from './contracts.ts';
import { internalFenceSchema, lockInternalFence } from './internal.ts';
import {
  answerDefinitionSchema,
  answerSchema,
  answerRequestSchema,
  cancelRequestSchema,
  requestInputSchema,
  requestOutcomeSchema,
  requestViewSchema,
} from './request-contracts.ts';
import type { ConversationRuntime, ReplyFence } from './runtime.ts';
import {
  requireConversationMcpSources,
  requireFileSources,
  requireGitHubSources,
  requireGoogleSources,
  requireKnowledgeSources,
  requireMcpSources,
  requireResultSources,
} from './source-access.ts';
import { sourceDependenciesSchema } from './results.ts';
import { recordConversationActivity } from './activity.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const rowSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  turn_id: uuidSchema,
  revision: z.number().int(),
  membership_id: uuidSchema,
  internal_id: uuidSchema.nullable(),
  producer_id: uuidSchema,
  answer_schema: answerDefinitionSchema,
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  expired: z.boolean(),
  generation: z.number().int(),
  attempt_epoch: z.number().int(),
});
type RequestRow = z.infer<typeof rowSchema>;

export function createConversationRequests(runtime: ConversationRuntime) {
  async function transaction<T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });
  }

  async function owned(tx: AuthorizationTransaction, actor: HumanActor, chatId: string) {
    await chatAccess(tx, actor, chatId, 'read', true);
    await requireConversationMcpSources(tx, actor, chatId);
  }

  async function request(tx: AuthorizationTransaction, chatId: string, id: string) {
    const row = rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(tx, 'tf_conversation_requests')} WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
            [id, chatId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }

  async function requireRequestSources(tx: AuthorizationTransaction, actor: HumanActor, row: RequestRow) {
    if (row.internal_id !== null) return;
    const step = z
      .object({ sources: sourceDependenciesSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT output->'sources' AS sources FROM ${table(tx, 'tf_conversation_execution_steps')} WHERE call_id=$1 AND turn_id=$2`,
            [row.producer_id, row.turn_id],
          )
        ).rows[0],
      );
    if (!step) throw new AccessDenied();
    await requireGitHubSources(tx, actor, step.sources);
    await requireGoogleSources(tx, actor, step.sources);
    await requireKnowledgeSources(tx, actor, step.sources);
    await requireFileSources(tx, actor, step.sources);
    await requireMcpSources(tx, actor, row.conversation_id, step.sources);
    await requireResultSources(
      tx,
      actor,
      row.conversation_id,
      step.sources.filter(
        source => source.kind === 'table' || source.kind === 'table-rows' || source.kind === 'table-schema',
      ),
    );
  }

  async function publish(
    tx: AuthorizationTransaction,
    chatId: string,
    reference: { kind: 'request'; id: string } | { kind: 'response'; id: string },
    actor?: HumanActor,
  ) {
    const messageId = randomUUID();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) SELECT $1,id,next_message_sequence,$3,$4 FROM ${table(tx, 'tf_conversations')} WHERE id=$2`,
      [messageId, chatId, actor ? 'human' : 'assistant', actor?.membershipId ?? null],
    );
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,request_id,response_id) VALUES ($1,$2,0,$3,$4,$5)`,
      [
        chatId,
        messageId,
        reference.kind,
        reference.kind === 'request' ? reference.id : null,
        reference.kind === 'response' ? reference.id : null,
      ],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence=next_message_sequence+1, activity_at=clock_timestamp() WHERE id=$1`,
      [chatId],
    );
    await recordConversationActivity(tx, chatId);
  }

  async function settle(tx: AuthorizationTransaction, row: RequestRow, status: 'answered' | 'cancelled' | 'expired') {
    const turn = await tx.client.query(
      `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='queued', generation=generation+1, attempt_epoch=attempt_epoch+1, attempts=0, lease_until=NULL, retry_at=NULL, error_code=NULL WHERE id=$1 AND conversation_id=$2 AND status='waiting' AND generation=$3 AND attempt_epoch=$4 RETURNING id`,
      [row.turn_id, row.conversation_id, row.generation, row.attempt_epoch],
    );
    if (
      !turn.rowCount &&
      !(
        status === 'expired' &&
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 AND status IN ('blocked','cancelled')`,
            [row.turn_id],
          )
        ).rowCount
      )
    )
      throw new ConversationConflict('request-conflict');
    await tx.client.query(`UPDATE ${table(tx, 'tf_conversation_requests')} SET status=$2 WHERE id=$1`, [
      row.id,
      status,
    ]);
    if (turn.rowCount)
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id,conversation_id,generation) SELECT id,conversation_id,generation FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1`,
        [row.turn_id],
      );
  }

  async function create(value: unknown, content: unknown) {
    const fence = internalFenceSchema.parse(value),
      input = requestInputSchema.parse(content);
    if (fence.origin.kind !== 'linked') throw new AccessDenied();
    const origin = fence.origin;
    return transaction(fence.workspaceId, async tx => {
      await lockInternalFence(tx, fence, true);
      const prior = z
        .object({ id: uuidSchema, input_digest: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,input_digest FROM ${table(tx, 'tf_conversation_requests')} WHERE internal_id=$1 AND producer_id=$2`,
              [fence.runId, input.producerId],
            )
          ).rows[0],
        );
      if (prior) {
        if (prior.input_digest !== digest(input)) throw new ConversationConflict('command-conflict');
        return { requestId: prior.id, revision: 1 };
      }
      await lockInternalFence(tx, fence);
      const id = randomUUID();
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_requests')} (id,conversation_id,turn_id,internal_id,producer_id,input_digest,membership_id,prompt,answer_schema,generation,attempt_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          origin.conversationId,
          origin.turnId,
          fence.runId,
          input.producerId,
          digest(input),
          (await turnRequester(tx, origin.conversationId, origin.turnId)).membershipId,
          input.prompt,
          input.answerSchema,
          origin.generation,
          origin.epoch,
        ],
      );
      await publish(tx, origin.conversationId, { kind: 'request', id });
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL WHERE id=$1`,
        [origin.turnId],
      );
      await notifyConversationChange(tx, {
        workspaceId: fence.workspaceId,
        conversationId: origin.conversationId,
        turnId: origin.turnId,
        settled: true,
      });
      return { requestId: id, revision: 1 };
    });
  }

  async function createForChat(fence: ReplyFence, content: unknown) {
    const input = requestInputSchema.parse(content);
    return transaction(fence.workspaceId, async tx => {
      const actor = await turnRequester(tx, fence.conversationId, fence.turnId);
      await owned(tx, actor, fence.conversationId);
      const active = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4 AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE`,
        [fence.turnId, fence.conversationId, fence.generation, fence.epoch],
      );
      if (!active.rowCount) throw new AccessDenied();
      const id = randomUUID();
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_requests')} (id,conversation_id,turn_id,producer_id,input_digest,membership_id,prompt,answer_schema,generation,attempt_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          fence.conversationId,
          fence.turnId,
          input.producerId,
          digest(input),
          actor.membershipId,
          input.prompt,
          input.answerSchema,
          fence.generation,
          fence.epoch,
        ],
      );
      await publish(tx, fence.conversationId, { kind: 'request', id });
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL WHERE id=$1`,
        [fence.turnId],
      );
      await notifyConversationChange(tx, { ...fence, settled: true });
      return { requestId: id, revision: 1 };
    });
  }

  async function resolve(
    workspaceId: string,
    userId: string,
    chatIdInput: string,
    requestIdInput: string,
    operation: 'answer' | 'cancel-request',
    value: unknown,
    responseIdInput?: string,
  ) {
    const chatId = uuidSchema.parse(chatIdInput),
      requestId = uuidSchema.parse(requestIdInput);
    const input = operation === 'answer' ? answerRequestSchema.parse(value) : cancelRequestSchema.parse(value);
    const responseId = operation === 'answer' ? uuidSchema.parse(responseIdInput) : null;
    return transaction(workspaceId, async tx => {
      const actor = await resolveHuman(tx, userId);
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 184735))', [
        `${tx.schema}:${actor.membershipId}:${input.commandId}`,
      ]);
      await owned(tx, actor, chatId);
      const hash = digest({ requestId, responseId, ...input });
      const prior = z
        .object({ operation: z.string(), conversation_id: uuidSchema, input_digest: z.string(), outcome: z.unknown() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table(tx, 'tf_conversation_commands')} WHERE membership_id=$1 AND command_id=$2`,
              [actor.membershipId, input.commandId],
            )
          ).rows[0],
        );
      if (prior) {
        if (prior.operation !== operation || prior.conversation_id !== chatId || prior.input_digest !== hash)
          throw new ConversationConflict('command-conflict');
        return requestOutcomeSchema.parse(prior.outcome);
      }
      const row = await request(tx, chatId, requestId);
      await requireRequestSources(tx, actor, row);
      if (row.membership_id !== actor.membershipId) throw new AccessDenied();
      if (row.revision !== input.expectedRevision || row.status !== 'pending')
        throw new ConversationConflict('request-conflict');
      const status = row.expired ? 'expired' : operation === 'answer' ? 'answered' : 'cancelled';
      if (status === 'answered' && 'answer' in input) {
        const answer = answerSchema.parse(input.answer),
          definition = row.answer_schema;
        const typedChoice = answer.kind === 'text' && definition.kind === 'choices' && definition.allowText === true;
        if (
          (!typedChoice && answer.kind !== definition.kind) ||
          (answer.kind === 'choices' &&
            definition.kind === 'choices' &&
            ((!definition.multiple && answer.choiceIds.length !== 1) ||
              answer.choiceIds.some(id => !definition.choices.some(choice => choice.id === id))))
        )
          throw new ConversationConflict('request-conflict');
        const inserted = await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_responses')} (id,conversation_id,request_id,request_revision,membership_id,command_id,answer) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [responseId, chatId, requestId, row.revision, actor.membershipId, input.commandId, answer],
        );
        if (!inserted.rowCount) throw new ConversationConflict('identity-conflict');
        await publish(tx, chatId, { kind: 'response', id: uuidSchema.parse(responseId) }, actor);
      }
      await settle(tx, row, status);
      await notifyConversationChange(tx, { workspaceId, conversationId: chatId, turnId: row.turn_id });
      const outcome = {
        requestId,
        revision: row.revision,
        status,
        responseId: status === 'answered' ? responseId : null,
      };
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_commands')} (membership_id,command_id,operation,conversation_id,input_digest,outcome) VALUES ($1,$2,$3,$4,$5,$6)`,
        [actor.membershipId, input.commandId, operation, chatId, hash, outcome],
      );
      return outcome;
    });
  }

  async function read(workspaceId: string, userId: string, chatIdInput: string, requestIdInput: string) {
    const chatId = uuidSchema.parse(chatIdInput),
      requestId = uuidSchema.parse(requestIdInput);
    return transaction(workspaceId, async tx => {
      const actor = await resolveHuman(tx, userId);
      await owned(tx, actor, chatId);
      const row = await request(tx, chatId, requestId);
      await requireRequestSources(tx, actor, row);
      if (row.status === 'pending' && row.expired) await settle(tx, row, 'expired');
      const result = z
        .object({
          id: uuidSchema,
          turnId: uuidSchema,
          revision: z.number().int(),
          prompt: z.string(),
          answerSchema: answerDefinitionSchema,
          status: requestViewSchema.shape.status,
          expiresAt: z.date(),
          response: z.unknown(),
        })
        .parse(
          (
            await tx.client.query(
              `SELECT r.id,r.turn_id AS "turnId",r.revision,r.prompt,r.answer_schema AS "answerSchema",r.status,r.expires_at AS "expiresAt", CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'answer',s.answer,'createdAt',s.created_at) END AS response FROM ${table(tx, 'tf_conversation_requests')} r LEFT JOIN ${table(tx, 'tf_conversation_responses')} s ON s.request_id=r.id WHERE r.id=$1`,
              [requestId],
            )
          ).rows[0],
        );
      return requestViewSchema.parse({ ...result, expiresAt: result.expiresAt.toISOString() });
    });
  }

  async function expire(workspaceId: string) {
    return transaction(workspaceId, async tx => {
      const due = z
        .array(z.object({ id: uuidSchema, conversation_id: uuidSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT id,conversation_id FROM ${table(tx, 'tf_conversation_requests')} WHERE status='pending' AND expires_at <= clock_timestamp() ORDER BY conversation_id,id LIMIT 50`,
            )
          ).rows,
        );
      let expired = 0;
      for (const item of due) {
        await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
          item.conversation_id,
        ]);
        const row = await request(tx, item.conversation_id, item.id);
        if (row.status !== 'pending' || !row.expired) continue;
        await settle(tx, row, 'expired');
        await notifyConversationChange(tx, { workspaceId, conversationId: item.conversation_id, turnId: row.turn_id });
        expired++;
      }
      return { expired };
    });
  }

  async function readForRuntime(value: unknown, requestIdInput: string) {
    const fence = internalFenceSchema.parse(value),
      requestId = uuidSchema.parse(requestIdInput);
    if (fence.origin.kind !== 'linked') throw new AccessDenied();
    const origin = fence.origin;
    return transaction(fence.workspaceId, async tx => {
      await lockInternalFence(tx, fence);
      const row = await request(tx, origin.conversationId, requestId);
      if (
        row.turn_id !== origin.turnId ||
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_conversation_requests')} WHERE id=$1 AND internal_id=$2`,
            [requestId, fence.runId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      const response = z
        .object({ answer: answerSchema })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT answer FROM ${table(tx, 'tf_conversation_responses')} WHERE request_id=$1`, [
              requestId,
            ])
          ).rows[0],
        );
      return { requestId, revision: row.revision, status: row.status, answer: response?.answer ?? null };
    });
  }

  return {
    create,
    createForChat,
    read,
    expire,
    readForRuntime,
    answer: (
      workspaceId: string,
      userId: string,
      chatId: string,
      requestId: string,
      responseId: string,
      value: unknown,
    ) => resolve(workspaceId, userId, chatId, requestId, 'answer', value, responseId),
    cancel: (workspaceId: string, userId: string, chatId: string, requestId: string, value: unknown) =>
      resolve(workspaceId, userId, chatId, requestId, 'cancel-request', value),
  };
}
