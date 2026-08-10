import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "../db";
import type {
  ConversationStore,
  PersistedMessage,
  PersistedTurn,
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
  content: string;
  metadata: Record<string, unknown> | null;
  attempt: number | null;
  created_at: Date;
}

interface CompletionRow {
  turn_id: string;
  attempt: number;
  status: string;
  message_id: string | null;
  cursor: string | number;
  created_at: Date;
}

const TURN_COLUMNS = `id, conversation_id, idempotency_key, request_message_id, status, attempt,
  run_id, cursor, superseded_run_ids, created_at, updated_at`;

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
    // `bigint` arrives as a string from `pg` and as a number from PGlite.
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
    content: row.content,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    ...(row.attempt === null ? {} : { attempt: row.attempt }),
    createdAt: row.created_at,
  };
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
  };
}

/**
 * `ConversationStore` over the existing `messages` table and the `conversation_turns` table added
 * in migration 16. Turn rows are the durable record of a submitted request: written before dispatch,
 * looked up by idempotency key so a retried request resolves to the same Turn instead of appending a
 * second Message.
 */
export class PgConversationStore implements ConversationStore {
  constructor(private readonly q: Queryable) {}

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

  async findTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE id = $1`,
      [turnId]
    );
    const row = rows[0] as unknown as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
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
    // `content` is jsonb, and a Turn message is always text — `JSON.stringify` makes it a JSON
    // string, matching what `PgMessageRepo` writes for a user message.
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

  async saveTurn(turn: PersistedTurn): Promise<void> {
    assertDeploymentBusiness(turn.businessId);
    await this.q.query(
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

  async listMessages(
    businessId: string,
    conversationId: string
  ): Promise<readonly PersistedMessage[]> {
    assertDeploymentBusiness(businessId);
    // Only Turn messages, and only the text ones: rows predating migration 16 have a NULL
    // `turn_id`, and tool/summary rows hold part arrays that are not a Turn's request or reply.
    //
    // An assistant Message additionally has to be the one an attempt *completed* its Turn with. A
    // Worker killed after writing its reply leaves that reply behind, and the retry writes its own
    // under a new attempt — replaying both would show the conversation answering itself twice.
    const { rows } = await this.q.query(
      `SELECT m.id, m.conversation_id, m.turn_id, m.role,
              m.content #>> '{}' AS content, m.metadata, m.attempt, m.created_at
         FROM messages m
        WHERE m.conversation_id = $1
          AND m.turn_id IS NOT NULL
          AND jsonb_typeof(m.content) = 'string'
          AND (
            m.role = 'user'
            OR (m.role = 'assistant' AND EXISTS (
                 SELECT 1 FROM turn_completions c
                  WHERE c.turn_id = m.turn_id AND c.message_id = m.id))
          )
        ORDER BY m.created_at, m.id`,
      [conversationId]
    );
    return (rows as unknown as MessageRow[]).map(toMessage);
  }

  async findCompletion(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined> {
    assertDeploymentBusiness(businessId);
    const { rows } = await this.q.query(
      `SELECT turn_id, attempt, status, message_id, cursor, created_at
         FROM turn_completions WHERE turn_id = $1 AND attempt = $2`,
      [turnId, attempt]
    );
    const row = rows[0] as unknown as CompletionRow | undefined;
    return row ? toCompletion(row) : undefined;
  }

  async saveCompletion(completion: TurnCompletion): Promise<void> {
    assertDeploymentBusiness(completion.businessId);
    // `DO NOTHING`, not `DO UPDATE`: an attempt states its outcome once. A redelivered completion
    // must leave the recorded answer — and the Message it names — exactly as it stands.
    await this.q.query(
      `INSERT INTO turn_completions (turn_id, attempt, status, message_id, cursor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (turn_id, attempt) DO NOTHING`,
      [
        completion.turnId,
        completion.attempt,
        completion.status,
        completion.messageId,
        completion.cursor,
        completion.createdAt,
      ]
    );
  }
}
