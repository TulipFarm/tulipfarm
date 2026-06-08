import type { Queryable } from "../db";

export interface ConversationDoc {
  _id: string;
  userId?: string;
  agentId?: string;
  // Conversation-level configured default model (tier name or model id). The
  // per-turn `model` override bypasses this without mutating it.
  // TODO: agent-config-derived default model is deferred to a later ticket.
  model?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepo {
  create(doc: ConversationDoc): Promise<void>;
  findById(id: string): Promise<ConversationDoc | null>;
  touch(id: string): Promise<void>;
}

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
}
