import type { ModelFailureDiagnostic } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { normalizeMessageContent } from "@tulipfarm/schema";
import { findLatestConversationTurn } from "@tulipfarm/storage";
import type { ConversationRepo } from "../chat/conversations";
import type { MessageRepo } from "../chat/messages";
import type { Queryable } from "../db";
import { withTransaction } from "../db";
import type {
  AssistantAttemptStatus,
  AssistantMessageWriteResult,
  CompleteTurnInput,
  CompleteTurnResult,
  ContextMessage,
  ConversationStore,
  NewConversation,
  PersistedMessage,
  PersistedTurn,
  SettleTerminalTurnInput,
  TurnCompletion,
  TurnCompletionStatus,
  TurnStatus,
} from "./service";

/**
 * A `businessId` other than this deployment's would silently write rows that carry no business
 * column and therefore could never be told apart again. Fail loudly instead.
 */
function assertDeploymentBusiness(businessId: string): void {
  if (businessId !== DEPLOYMENT_BUSINESS_ID) {
    throw new Error(`conversation_store_business_mismatch:${businessId}`);
  }
}

interface TurnRow {
  id: string;
  conversation_id: string;
  idempotency_key: string;
  request_message_id: string;
  status: string;
  attempt: number;
  run_id: string | null;
  cursor: string | number;
  superseded_run_ids: string[];
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  role: string;
  content: unknown;
  metadata: Record<string, unknown> | null;
  attempt: number | null;
  created_at: Date;
  attempt_status?: string | null;
}

interface CompletionRow {
  turn_id: string;
  attempt: number;
  status: string;
  message_id: string | null;
  cursor: string | number;
  created_at: Date;
  reason: string | null;
  model_failure: unknown | null;
}

const TURN_COLUMNS = `id, conversation_id, idempotency_key, request_message_id, status, attempt,
  run_id, cursor, superseded_run_ids, created_at, updated_at`;

async function saveTurnWith(q: Queryable, turn: PersistedTurn): Promise<void> {
  await q.query(
    `INSERT INTO conversation_turns (
       id, conversation_id, idempotency_key, request_message_id, status, attempt, run_id,
       cursor, superseded_run_ids, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       attempt = EXCLUDED.attempt,
       run_id = EXCLUDED.run_id,
       cursor = EXCLUDED.cursor,
       superseded_run_ids = EXCLUDED.superseded_run_ids,
       updated_at = EXCLUDED.updated_at`,
    [
      turn.id,
      turn.conversationId,
      turn.idempotencyKey,
      turn.requestMessageId,
      turn.status,
      turn.attempt,
      turn.runId,
      turn.cursor,
      [...turn.supersededRunIds],
      turn.createdAt,
      turn.updatedAt,
    ]
  );
}

function toTurn(row: TurnRow): PersistedTurn {
  return {
    id: row.id,
    businessId: DEPLOYMENT_BUSINESS_ID,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    requestMessageId: row.request_message_id,
    status: row.status as TurnStatus,
    attempt: row.attempt,
    runId: row.run_id,
    cursor: Number(row.cursor),
    supersededRunIds: row.superseded_run_ids,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): PersistedMessage {
  return {
    id: row.id,
    businessId: DEPLOYMENT_BUSINESS_ID,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    role: row.role as PersistedMessage["role"],
    content: normalizeMessageContent(row.content),
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    ...(row.attempt === null ? {} : { attempt: row.attempt }),
    createdAt: row.created_at,
  };
}

function toContextMessage(row: MessageRow): ContextMessage {
  const message = toMessage(row);
  return row.attempt_status === null || row.attempt_status === undefined
    ? message
    : { ...message, attemptStatus: row.attempt_status as AssistantAttemptStatus };
}

function toCompletion(row: CompletionRow): TurnCompletion {
  return {
    businessId: DEPLOYMENT_BUSINESS_ID,
    turnId: row.turn_id,
    attempt: row.attempt,
    status: row.status as TurnCompletionStatus,
    messageId: row.message_id,
    cursor: Number(row.cursor),
    createdAt: row.created_at,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.model_failure === null
      ? {}
      : { modelFailure: row.model_failure as ModelFailureDiagnostic }),
  };
}

/**
 * `ConversationStore` over the existing `messages` table and the `conversation_turns` table added
 * in migration 16. Turn rows are the durable record of a submitted request: written before
 * dispatch, looked up by idempotency key so a retried request resolves to the same Turn instead of
 * appending a second Message.
 */
export class PgConversationStore implements ConversationStore {
  constructor(
    private readonly q: Queryable,
    private readonly messageRepoOver?: (queryable: Queryable) => MessageRepo,
    private readonly conversationRepoOver?: (
      queryable: Queryable
    ) => Pick<ConversationRepo, "create" | "deleteOwned" | "setAgent" | "touch">
  ) {}

  async withTransaction<T>(
    operation: (store: ConversationStore, transaction: Queryable) => Promise<T>
  ): Promise<T> {
    return withTransaction(this.q, (transaction) =>
      operation(
        new PgConversationStore(transaction, this.messageRepoOver, this.conversationRepoOver),
        transaction
      )
    );
  }

  async findTurnByIdempotencyKey(
    businessId: string,
    key: string
  ): Promise<PersistedTurn | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE idempotency_key = $1`,
      [key]
    );
    const row = rows[0] as unknown as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  async lockTurnByIdempotencyKey(
    businessId: string,
    key: string
  ): Promise<PersistedTurn | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT ${TURN_COLUMNS}
         FROM conversation_turns
        WHERE idempotency_key = $1
        FOR UPDATE`,
      [key]
    );
    const row = rows[0] as unknown as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  async findTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE id = $1`,
      [turnId]
    );
    const row = rows[0] as unknown as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  async lockTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE id = $1 FOR UPDATE`,
      [turnId]
    );
    const row = rows[0] as unknown as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  async findLatestTurn(businessId: string, conversationId: string) {
    assertDeploymentBusiness(businessId);
    return findLatestConversationTurn(this.q, conversationId);
  }

  async findTurnByRunId(businessId: string, runId: string): Promise<PersistedTurn | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE run_id = $1`,
      [runId]
    );
    const row = rows[0] as unknown as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  async appendMessage(message: PersistedMessage): Promise<void> {
    assertDeploymentBusiness(message.businessId);
    await this.q.query(
      `INSERT INTO messages (id, conversation_id, turn_id, role, content, metadata, attempt, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
      [
        message.id,
        message.conversationId,
        message.turnId,
        message.role,
        JSON.stringify(message.content),
        message.metadata === undefined ? null : JSON.stringify(message.metadata),
        message.attempt ?? null,
        message.createdAt,
      ]
    );
  }

  async appendAssistantMessage(input: {
    readonly message: PersistedMessage;
    readonly runId: string;
    readonly attempt: number;
    readonly expectedLeaseGeneration?: number;
  }): Promise<AssistantMessageWriteResult> {
    assertDeploymentBusiness(input.message.businessId);
    return withTransaction(this.q, async (transaction) => {
      if (
        input.expectedLeaseGeneration !== undefined &&
        !(await lockOwnedRun(
          transaction,
          input.message.businessId,
          input.runId,
          input.expectedLeaseGeneration
        ))
      ) {
        return { status: "ownership_lost" as const, messageId: null };
      }
      const scoped = new PgConversationStore(
        transaction,
        this.messageRepoOver,
        this.conversationRepoOver
      );
      const turn = await scoped.lockTurn(input.message.businessId, input.message.turnId);
      if (turn === undefined || turn.runId !== input.runId || turn.attempt !== input.attempt) {
        return { status: "stale" as const, messageId: null };
      }

      const existing = await transaction.query(
        `SELECT id
           FROM messages
          WHERE turn_id = $1 AND role = 'assistant' AND attempt = $2
          ORDER BY created_at, id
          LIMIT 1`,
        [input.message.turnId, input.attempt]
      );
      const row = existing.rows[0] as { id: string } | undefined;
      if (row !== undefined) {
        await transaction.query(
          `UPDATE messages
              SET content = $2::jsonb,
                  metadata = $3::jsonb
            WHERE id = $1`,
          [
            row.id,
            JSON.stringify(input.message.content),
            input.message.metadata === undefined ? null : JSON.stringify(input.message.metadata),
          ]
        );
        return { status: "recorded" as const, messageId: row.id };
      }

      await scoped.appendMessage(input.message);
      return { status: "recorded" as const, messageId: input.message.id };
    });
  }

  async findAttemptMessage(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<PersistedMessage | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT id, conversation_id, turn_id, role, content, metadata, attempt, created_at
         FROM messages
        WHERE turn_id = $1 AND role = 'assistant' AND attempt = $2
        ORDER BY created_at, id
        LIMIT 1`,
      [turnId, attempt]
    );
    const row = rows[0] as unknown as MessageRow | undefined;
    return row === undefined ? undefined : toMessage(row);
  }

  async reserveTurn(input: {
    readonly message: PersistedMessage;
    readonly turn: PersistedTurn;
    readonly requestFingerprint?: string;
    readonly newConversation?: NewConversation;
    readonly conversationUpdate?: { readonly agentId?: string };
  }): Promise<{
    readonly turn: PersistedTurn;
    readonly outcome: "created" | "replayed" | "conflict";
    readonly conversationCreated: boolean;
  }> {
    assertDeploymentBusiness(input.turn.businessId);
    assertDeploymentBusiness(input.message.businessId);
    if (
      input.message.id !== input.turn.requestMessageId ||
      input.message.turnId !== input.turn.id ||
      input.message.conversationId !== input.turn.conversationId
    ) {
      throw new Error("conversation_turn_reservation_mismatch");
    }

    let conversationCreated = false;
    if (input.newConversation !== undefined) {
      if (input.newConversation.id !== input.turn.conversationId) {
        throw new Error("conversation_turn_new_conversation_mismatch");
      }
      const conversations = this.conversationRepoOver?.(this.q);
      if (conversations === undefined) {
        throw new Error("conversation_transaction_repo_missing");
      }
      await conversations.create({
        _id: input.newConversation.id,
        userId: input.newConversation.userId,
        ...(input.newConversation.agentId === undefined
          ? {}
          : { agentId: input.newConversation.agentId }),
        createdAt: input.newConversation.createdAt,
        updatedAt: input.newConversation.updatedAt,
      });
      conversationCreated = true;
    }

    await this.q.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [
      input.turn.conversationId,
    ]);
    const ordered = await this.q.query(
      `SELECT GREATEST(
         $2::timestamptz,
         COALESCE(MAX(created_at) + interval '1 millisecond', $2::timestamptz)
       ) AS created_at
       FROM conversation_turns
       WHERE conversation_id = $1`,
      [input.turn.conversationId, input.turn.createdAt]
    );
    const createdAt = (ordered.rows[0] as { created_at: Date } | undefined)?.created_at;
    if (createdAt === undefined) throw new Error("conversation_turn_order_unavailable");

    const inserted = await this.q.query(
      `INSERT INTO conversation_turns (
         id, conversation_id, idempotency_key, request_message_id, status, attempt, run_id,
         cursor, superseded_run_ids, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${TURN_COLUMNS}`,
      [
        input.turn.id,
        input.turn.conversationId,
        input.turn.idempotencyKey,
        input.turn.requestMessageId,
        input.turn.status,
        input.turn.attempt,
        input.turn.runId,
        input.turn.cursor,
        [...input.turn.supersededRunIds],
        createdAt,
        createdAt,
      ]
    );
    const insertedRow = inserted.rows[0] as unknown as TurnRow | undefined;
    if (insertedRow !== undefined) {
      await this.appendMessage({ ...input.message, createdAt });
      if (input.conversationUpdate !== undefined) {
        const conversations = this.conversationRepoOver?.(this.q);
        if (conversations === undefined) {
          throw new Error("conversation_transaction_repo_missing");
        }
        if (input.conversationUpdate.agentId === undefined) {
          await conversations.touch(input.turn.conversationId);
        } else {
          await conversations.setAgent(input.turn.conversationId, input.conversationUpdate.agentId);
        }
      }
      return {
        turn: toTurn(insertedRow),
        outcome: "created",
        conversationCreated,
      };
    }

    const existing = await this.findTurnByIdempotencyKey(
      input.turn.businessId,
      input.turn.idempotencyKey
    );
    if (existing === undefined) throw new Error("conversation_turn_conflict_without_turn");
    if (conversationCreated && input.newConversation !== undefined) {
      const conversations = this.conversationRepoOver?.(this.q);
      const deleted = await conversations?.deleteOwned(
        input.newConversation.id,
        input.newConversation.userId
      );
      if (deleted !== "deleted") throw new Error("conversation_replay_cleanup_failed");
    }

    if (input.requestFingerprint !== undefined) {
      const request = await this.q.query<{
        content: unknown;
        metadata: Record<string, unknown> | null;
      }>("SELECT content, metadata FROM messages WHERE id = $1", [existing.requestMessageId]);
      const row = request.rows[0];
      if (row === undefined) throw new Error("conversation_turn_request_message_missing");
      const existingFingerprint = row.metadata?.submissionFingerprint;
      const equivalent =
        existingFingerprint === input.requestFingerprint ||
        (existingFingerprint === undefined &&
          JSON.stringify(normalizeMessageContent(row.content)) ===
            JSON.stringify(input.message.content));
      if (!equivalent) {
        return { turn: existing, outcome: "conflict", conversationCreated: false };
      }
    }
    return { turn: existing, outcome: "replayed", conversationCreated: false };
  }

  async saveTurn(turn: PersistedTurn): Promise<void> {
    assertDeploymentBusiness(turn.businessId);
    await saveTurnWith(this.q, turn);
  }

  async listMessages(
    businessId: string,
    conversationId: string,
    throughRequestMessageId?: string
  ): Promise<readonly PersistedMessage[]> {
    assertDeploymentBusiness(businessId);
    // Only Turn messages: rows predating migration 16 have a NULL turn_id. `content` stays raw
    // jsonb because a row may hold a bare string or parts; filtering to one shape here would
    // silently drop every Message carrying a File.
    //
    // `appendAssistantMessage` and `completeTurn` are two separate writes; a crash between them
    // (a guard timeout, a killed process) leaves a real, already-shown reply with no completion
    // row. Gating existence on that row would hide it from every reload forever — the reply is
    // not "not yet decided", it is durable and simply never got its completion recorded. So an
    // assistant Message also surfaces when its own Turn has no completion at or after its
    // attempt and it is the latest attempt the Turn has: exactly the orphaned case, without
    // resurrecting an earlier attempt's abandoned draft once a later attempt went on to complete.
    const { rows } = await this.q.query(
      `SELECT m.id, m.conversation_id, m.turn_id, m.role,
              m.content, m.metadata, m.attempt, m.created_at
         FROM messages m
        WHERE m.conversation_id = $1
          AND m.turn_id IS NOT NULL
          AND (
            $2::uuid IS NULL
            OR EXISTS (
              SELECT 1
                FROM conversation_turns current_turn
                JOIN conversation_turns message_turn ON message_turn.id = m.turn_id
               WHERE current_turn.conversation_id = $1
                 AND current_turn.request_message_id = $2
                 AND (
                   (message_turn.created_at, message_turn.id)
                     < (current_turn.created_at, current_turn.id)
                   OR (
                     message_turn.id = current_turn.id
                     AND m.id = current_turn.request_message_id
                   )
                 )
            )
          )
          AND (
            m.role = 'user'
            OR (m.role = 'assistant' AND (
                 EXISTS (
                   SELECT 1 FROM turn_completions c
                    WHERE c.turn_id = m.turn_id AND c.message_id = m.id
                 )
                 OR (
                   m.attempt IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM turn_completions c2
                      WHERE c2.turn_id = m.turn_id AND c2.attempt >= m.attempt
                   )
                   AND m.attempt = (
                     SELECT MAX(m2.attempt) FROM messages m2
                      WHERE m2.turn_id = m.turn_id AND m2.role = 'assistant'
                   )
                 )
               ))
          )
        ORDER BY m.created_at, m.id`,
      [conversationId, throughRequestMessageId ?? null]
    );
    return (rows as unknown as MessageRow[]).map(toMessage);
  }

  async listContextMessages(
    businessId: string,
    conversationId: string,
    throughRequestMessageId?: string,
    afterMessageId?: string
  ): Promise<readonly ContextMessage[]> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT m.id, m.conversation_id, m.turn_id, m.role,
              m.content, m.metadata, m.attempt, m.created_at,
              CASE
                WHEN m.role <> 'assistant' THEN NULL
                WHEN completed.status = 'succeeded' THEN 'succeeded'
                WHEN completed.status = 'failed' THEN
                  CASE
                    WHEN m.metadata #>> '{turnAttempt,outcome}' = 'cancelled' THEN 'cancelled'
                    ELSE 'failed'
                  END
                WHEN m.attempt IS NOT NULL AND m.attempt < message_turn.attempt THEN
                  CASE
                    WHEN m.metadata #>> '{turnAttempt,outcome}' = 'cancelled' THEN 'cancelled'
                    WHEN m.metadata #>> '{turnAttempt,outcome}' = 'failed' THEN 'failed'
                    ELSE 'superseded'
                  END
                WHEN m.metadata #>> '{turnAttempt,outcome}' = 'cancelled' THEN 'cancelled'
                WHEN m.metadata #>> '{turnAttempt,outcome}' = 'failed' THEN 'failed'
                WHEN m.metadata #>> '{turnAttempt,outcome}' = 'succeeded' THEN 'succeeded'
                ELSE 'incomplete'
              END AS attempt_status
         FROM messages m
         JOIN conversation_turns message_turn ON message_turn.id = m.turn_id
         LEFT JOIN turn_completions completed
           ON completed.turn_id = m.turn_id AND completed.message_id = m.id
        WHERE m.conversation_id = $1
          AND (
            $3::uuid IS NULL
            OR (m.created_at, m.id) > (
              SELECT previous.created_at, previous.id
                FROM messages previous
               WHERE previous.id = $3
                 AND previous.conversation_id = $1
            )
          )
          AND (
            $2::uuid IS NULL
            OR EXISTS (
              SELECT 1
                FROM conversation_turns current_turn
               WHERE current_turn.conversation_id = $1
                 AND current_turn.request_message_id = $2
                 AND (
                   (message_turn.created_at, message_turn.id)
                     < (current_turn.created_at, current_turn.id)
                   OR (
                     message_turn.id = current_turn.id
                     AND m.id = current_turn.request_message_id
                   )
                 )
            )
          )
        ORDER BY m.created_at, m.id`,
      [conversationId, throughRequestMessageId ?? null, afterMessageId ?? null]
    );
    return (rows as unknown as MessageRow[]).map(toContextMessage);
  }

  async findCompletion(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT turn_id, attempt, status, message_id, cursor, created_at, reason, model_failure
         FROM turn_completions WHERE turn_id = $1 AND attempt = $2`,
      [turnId, attempt]
    );
    const row = rows[0] as unknown as CompletionRow | undefined;
    return row ? toCompletion(row) : undefined;
  }

  async completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult> {
    assertDeploymentBusiness(input.completion.businessId);
    return withTransaction(this.q, async (tx) => {
      if (
        input.expectedLeaseGeneration !== undefined &&
        !(await lockOwnedRun(
          tx,
          input.completion.businessId,
          input.runId,
          input.expectedLeaseGeneration
        ))
      ) {
        return { completionInserted: false, status: "ownership_lost" };
      }
      const scoped = new PgConversationStore(tx, this.messageRepoOver, this.conversationRepoOver);
      const turn = await scoped.lockTurn(input.completion.businessId, input.completion.turnId);
      if (
        turn === undefined ||
        turn.runId !== input.runId ||
        turn.attempt !== input.completion.attempt
      ) {
        return { completionInserted: false, status: "stale" };
      }

      const inserted = await tx.query(
        `INSERT INTO turn_completions (
           turn_id, attempt, status, message_id, cursor, created_at, reason, model_failure
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (turn_id, attempt) DO NOTHING
         RETURNING turn_id`,
        [
          input.completion.turnId,
          input.completion.attempt,
          input.completion.status,
          input.completion.messageId,
          input.completion.cursor,
          input.completion.createdAt,
          input.completion.reason ?? null,
          input.completion.modelFailure === undefined
            ? null
            : JSON.stringify(input.completion.modelFailure),
        ]
      );
      const completionInserted = inserted.rows.length > 0;
      if (!completionInserted) {
        return { completionInserted: false, status: "replayed" };
      }

      if (input.surfaceMessage !== undefined) {
        const messages = this.messageRepoOver?.(tx);
        if (messages === undefined) throw new Error("conversation_surface_message_repo_missing");
        await messages.create(input.surfaceMessage);
      }

      await tx.query(
        `UPDATE conversation_turns
            SET status = $2, cursor = $3, updated_at = $4
          WHERE id = $1 AND run_id = $5 AND attempt = $6`,
        [
          input.completion.turnId,
          input.completion.status,
          input.completion.cursor,
          input.completion.createdAt,
          input.runId,
          input.completion.attempt,
        ]
      );
      return { completionInserted: true, status: "recorded" };
    });
  }

  async settleTerminalTurn(input: SettleTerminalTurnInput): Promise<CompleteTurnResult> {
    assertDeploymentBusiness(input.businessId);
    return withTransaction(this.q, async (tx) => {
      const scoped = new PgConversationStore(tx, this.messageRepoOver);
      const turn = await scoped.lockTurn(input.businessId, input.turnId);
      if (turn === undefined || turn.runId !== input.runId || turn.attempt !== input.attempt) {
        return { completionInserted: false, status: "stale" };
      }

      const existing = await scoped.findCompletion(input.businessId, input.turnId, input.attempt);
      if (existing !== undefined) {
        return { completionInserted: false, status: "replayed" };
      }

      const messages = await tx.query(
        `SELECT id, metadata
           FROM messages
          WHERE turn_id = $1 AND role = 'assistant' AND attempt = $2
          ORDER BY created_at, id
          LIMIT 1`,
        [input.turnId, input.attempt]
      );
      const message = messages.rows[0] as
        | { id: string; metadata: Record<string, unknown> | null }
        | undefined;
      if (message !== undefined) {
        const currentAttempt = record(message.metadata?.turnAttempt) ?? {};
        const settledAttempt = { ...currentAttempt };
        delete settledAttempt.wait;
        const metadata = {
          ...(message.metadata ?? {}),
          turnAttempt: {
            ...settledAttempt,
            runId: input.runId,
            attempt: input.attempt,
            cursor: input.cursor,
            outcome: input.historyOutcome,
            complete: true,
          },
        };
        await tx.query("UPDATE messages SET metadata = $2::jsonb WHERE id = $1", [
          message.id,
          JSON.stringify(metadata),
        ]);
      }

      const inserted = await tx.query(
        `INSERT INTO turn_completions (
           turn_id, attempt, status, message_id, cursor, created_at, reason, model_failure
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         ON CONFLICT (turn_id, attempt) DO NOTHING
         RETURNING turn_id`,
        [
          input.turnId,
          input.attempt,
          input.status,
          message?.id ?? null,
          input.cursor,
          input.createdAt,
          input.reason ?? null,
        ]
      );
      if (inserted.rows.length === 0) {
        return { completionInserted: false, status: "replayed" };
      }
      await tx.query(
        `UPDATE conversation_turns
            SET status = $2, cursor = $3, updated_at = $4
          WHERE id = $1 AND run_id = $5 AND attempt = $6`,
        [input.turnId, input.status, input.cursor, input.createdAt, input.runId, input.attempt]
      );
      return { completionInserted: true, status: "recorded" };
    });
  }
}

async function lockOwnedRun(
  transaction: Queryable,
  businessId: string,
  runId: string,
  leaseGeneration: number
): Promise<boolean> {
  const result = await transaction.query(
    `SELECT 1
       FROM runs
      WHERE business_id = $1
        AND id = $2
        AND status = 'running'
        AND lease_generation = $3
      FOR UPDATE`,
    [businessId, runId, leaseGeneration]
  );
  return result.rows.length === 1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
