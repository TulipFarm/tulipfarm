import type { Queryable } from "../ports";

export const CONVERSATION_CONTEXT_SUMMARY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS conversation_context_summaries (
    business_id       text NOT NULL,
    conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    through_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    through_created_at timestamptz NOT NULL,
    summary           text NOT NULL CHECK (length(summary) BETWEEN 1 AND 10000),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, conversation_id)
  )`,
];

export interface ConversationContextSummary {
  readonly throughMessageId: string;
  readonly summary: string;
}

export class ConversationContextSummaryStore {
  constructor(private readonly queryable: Queryable) {}

  async find(
    businessId: string,
    conversationId: string,
    throughMessageId?: string
  ): Promise<ConversationContextSummary | undefined> {
    const { rows } = await this.queryable.query<{
      through_message_id: string;
      summary: string;
    }>(
      `SELECT s.through_message_id, s.summary
         FROM conversation_context_summaries s
        WHERE s.business_id = $1
          AND s.conversation_id = $2
          AND (
            $3::uuid IS NULL
            OR (s.through_created_at, s.through_message_id) <= (
              SELECT m.created_at, m.id FROM messages m WHERE m.id = $3
            )
          )`,
      [businessId, conversationId, throughMessageId ?? null]
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { throughMessageId: row.through_message_id, summary: row.summary };
  }

  async save(input: {
    readonly businessId: string;
    readonly conversationId: string;
    readonly throughMessageId: string;
    readonly summary: string;
  }): Promise<void> {
    await this.queryable.query(
      `INSERT INTO conversation_context_summaries (
         business_id, conversation_id, through_message_id, through_created_at, summary
       )
       SELECT $1, $2, m.id, m.created_at, $4
         FROM messages m
        WHERE m.id = $3 AND m.conversation_id = $2
       ON CONFLICT (business_id, conversation_id) DO UPDATE
         SET through_message_id = EXCLUDED.through_message_id,
             through_created_at = EXCLUDED.through_created_at,
             summary = EXCLUDED.summary,
             updated_at = now()
       WHERE (conversation_context_summaries.through_created_at,
              conversation_context_summaries.through_message_id)
             < (EXCLUDED.through_created_at, EXCLUDED.through_message_id)`,
      [input.businessId, input.conversationId, input.throughMessageId, input.summary]
    );
  }
}
