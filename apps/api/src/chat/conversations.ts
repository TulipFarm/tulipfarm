import type { Queryable } from "../db";

interface ConversationCursorState {
  updatedAt: string;
  _id: string;
}

export interface ConversationCursor {
  updatedAt: Date;
  _id: string;
}

export interface ConversationPage {
  items: ConversationDoc[];
  nextCursor: string | null;
}

/**
 * Opaque keyset cursor over the `list` newest-first order (`updated_at DESC, id DESC`). Distinct
 * from `pg/pagination.ts`'s `createdAt`-keyed cursor: the Recent chats / Chats page order is
 * `updated_at`, which that helper does not encode.
 */
export function encodeConversationCursor(doc: ConversationCursor): string {
  const state: ConversationCursorState = { updatedAt: doc.updatedAt.toISOString(), _id: doc._id };
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

export function decodeConversationCursor(cursor: string): ConversationCursor | null {
  try {
    const state = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (
      typeof state !== "object" ||
      state === null ||
      typeof (state as ConversationCursorState).updatedAt !== "string" ||
      typeof (state as ConversationCursorState)._id !== "string"
    ) {
      return null;
    }
    const parsed = state as ConversationCursorState;
    const updatedAt = new Date(parsed.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, _id: parsed._id };
  } catch {
    // An unparseable cursor is treated as absent; pagination restarts from the newest chat.
    return null;
  }
}

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
  /**
   * Persist a generated title, but only while the conversation still has none.
   *
   * The async title generator lands after the turn it names. The top bar offers a rename the
   * moment a chat exists, which is inside that window, so an unconditional write would silently
   * overwrite a title the user had just typed.
   */
  setTitleIfUnset(id: string, title: string): Promise<void>;
  /** Persist the user-pinned flag (Chats page star toggle). Does not bump `updated_at`. */
  setStarred(id: string, starred: boolean): Promise<void>;
  /**
   * A user's conversations, newest-first, for the Recent chats sidebar and the Chats page. An
   * optional `q` filters by title (case-insensitive substring, across all matching conversations
   * rather than just the loaded page); rows with no title are excluded from a `q` search. `after`
   * keyset-paginates past a previously returned page's cursor.
   */
  list(
    userId: string,
    limit: number,
    opts?: { q?: string; after?: ConversationCursor }
  ): Promise<ConversationPage>;
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

  async setTitleIfUnset(id: string, title: string): Promise<void> {
    await this.q.query("UPDATE conversations SET title = $2 WHERE id = $1 AND title IS NULL", [
      id,
      title,
    ]);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    await this.q.query("UPDATE conversations SET starred = $2 WHERE id = $1", [id, starred]);
  }

  async list(
    userId: string,
    limit: number,
    opts?: { q?: string; after?: ConversationCursor }
  ): Promise<ConversationPage> {
    // `$3::text IS NULL` short-circuits to the unfiltered list; otherwise a case-insensitive
    // substring match on the title (null-title rows are excluded by the ILIKE). `$4::timestamptz
    // IS NULL` likewise short-circuits the keyset filter for the first page. `updated_at DESC, id
    // DESC` keeps the tuple comparison below (row values, not per-column) consistent with the
    // sort so `<` always names "the next page", including ties on `updated_at`.
    const { rows } = await this.q.query(
      `SELECT * FROM conversations
       WHERE user_id = $1
         AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')
         AND ($4::timestamptz IS NULL OR (updated_at, id) < ($4, $5))
       ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [userId, limit + 1, opts?.q ?? null, opts?.after?.updatedAt ?? null, opts?.after?._id ?? null]
    );
    const items = rows.map(rowToConversation);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeConversationCursor(last) : null;
    return { items: page, nextCursor };
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
