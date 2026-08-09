import type { Queryable } from "../db";

export interface ConversationDoc {
  _id: string;
  userId?: string;
  agentId?: string;
  // Conversation-level configured default model (tier name or model id). The
  // per-turn `model` override bypasses this without mutating it.
  // TODO: agent-config-derived default model is deferred to a later ticket.
  model?: string;
  // Quick-model title derived from the first message; null until the async generator fills it in.
  title?: string;
  // User-pinned flag (Chats page). Defaults to false; the Chats page sorts starred chats first.
  starred?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepo {
  create(doc: ConversationDoc): Promise<void>;
  findById(id: string): Promise<ConversationDoc | null>;
  touch(id: string): Promise<void>;
  /** Persist the conversation's active agent after an explicit agent handoff. */
  setAgent(id: string, agentId: string): Promise<void>;
  /**
   * Persist the title. Does not bump `updated_at`, so it works both for the async title generator
   * (lands after the turn, out of band) and a manual rename (which should not reorder the list).
   */
  setTitle(id: string, title: string): Promise<void>;
  /** Persist the user-pinned flag (Chats page star toggle). Does not bump `updated_at`. */
  setStarred(id: string, starred: boolean): Promise<void>;
  /**
   * A user's conversations, newest-first, for the Recent chats sidebar and the Chats page. An
   * optional `q` filters by title (case-insensitive substring); rows with no title are excluded.
   */
  list(userId: string, limit: number, q?: string): Promise<ConversationDoc[]>;
  /** Owner-scoped hard delete. Active Turns reject deletion until they settle. */
  deleteOwned(id: string, userId: string): Promise<ConversationDeleteOutcome>;
}

export type ConversationDeleteOutcome = "deleted" | "not_found" | "active_turn";

export class ConversationOwnerlessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationOwnerlessError";
  }
}

function rowToConversation(row: Record<string, unknown>): ConversationDoc {
  return {
    _id: row.id as string,
    userId: (row.user_id as string | null) ?? undefined,
    agentId: (row.agent_id as string | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    title: (row.title as string | null) ?? undefined,
    starred: (row.starred as boolean | null) ?? false,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export class PgConversationRepo implements ConversationRepo {
  constructor(private readonly q: Queryable) {}

  async create(doc: ConversationDoc): Promise<void> {
    if (doc.userId == null && doc.agentId == null) {
      throw new ConversationOwnerlessError("conversation must have a userId or agentId");
    }
    try {
      await this.q.query(
        "INSERT INTO conversations (id, user_id, agent_id, model, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          doc._id,
          doc.userId ?? null,
          doc.agentId ?? null,
          doc.model ?? null,
          doc.createdAt,
          doc.updatedAt,
        ]
      );
    } catch (err) {
      // DB CHECK is the safety net behind the app-level guard above.
      if ((err as { code?: string }).code === "23514") {
        throw new ConversationOwnerlessError("conversation must have a userId or agentId");
      }
      throw err;
    }
  }

  async findById(id: string): Promise<ConversationDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM conversations WHERE id = $1", [id]);
    return rows.length > 0 ? rowToConversation(rows[0]) : null;
  }

  async touch(id: string): Promise<void> {
    await this.q.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [id]);
  }

  async setAgent(id: string, agentId: string): Promise<void> {
    await this.q.query("UPDATE conversations SET agent_id = $2, updated_at = now() WHERE id = $1", [
      id,
      agentId,
    ]);
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.q.query("UPDATE conversations SET title = $2 WHERE id = $1", [id, title]);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    await this.q.query("UPDATE conversations SET starred = $2 WHERE id = $1", [id, starred]);
  }

  async list(userId: string, limit: number, q?: string): Promise<ConversationDoc[]> {
    // `$3::text IS NULL` short-circuits to the unfiltered list; otherwise a case-insensitive
    // substring match on the title (null-title rows are excluded by the ILIKE).
    const { rows } = await this.q.query(
      `SELECT * FROM conversations
       WHERE user_id = $1 AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')
       ORDER BY updated_at DESC LIMIT $2`,
      [userId, limit, q ?? null]
    );
    return rows.map(rowToConversation);
  }

  async deleteOwned(id: string, userId: string): Promise<ConversationDeleteOutcome> {
    const { rows } = await this.q.query(
      `WITH target AS (
         SELECT c.id,
                EXISTS (
                  SELECT 1 FROM conversation_turns t
                  WHERE t.conversation_id = c.id AND t.status IN ('pending', 'running')
                ) AS active_turn
         FROM conversations c
         WHERE c.id = $1 AND c.user_id = $2
       ), deleted AS (
         DELETE FROM conversations c
         USING target
         WHERE c.id = target.id AND NOT target.active_turn
         RETURNING c.id
       )
       SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'not_found'
         WHEN EXISTS (SELECT 1 FROM deleted) THEN 'deleted'
         ELSE 'active_turn'
       END AS outcome`,
      [id, userId]
    );
    return (rows[0]?.outcome as ConversationDeleteOutcome | undefined) ?? "not_found";
  }
}
