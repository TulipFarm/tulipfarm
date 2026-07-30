import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "../db";
import type { ConversationStore, PersistedMessage, PersistedTurn, TurnStatus } from "./service";

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

  async appendMessage(message: PersistedMessage): Promise<void> {
    assertDeploymentBusiness(message.businessId);
    // `content` is jsonb, and a Turn message is always text — `JSON.stringify` makes it a JSON
    // string, matching what `PgMessageRepo` writes for a user message.
    await this.q.query(
      `INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        message.id,
        message.conversationId,
        message.turnId,
        message.role,
        JSON.stringify(message.content),
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
    const { rows } = await this.q.query(
      `SELECT id, conversation_id, turn_id, role, content #>> '{}' AS content, created_at
         FROM messages
        WHERE conversation_id = $1
          AND turn_id IS NOT NULL
          AND role IN ('user', 'assistant')
          AND jsonb_typeof(content) = 'string'
        ORDER BY created_at, id`,
      [conversationId]
    );
    return (rows as unknown as MessageRow[]).map(toMessage);
  }
}
