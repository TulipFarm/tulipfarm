import type { Queryable } from "../db";

/**
 * A Turn paused on a `request_input` Tool call. The row records the pending Tool-call id and
 * awaited input schema; the next Chat request resumes the same Run.
 */
export interface PendingInteraction {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  awaitedSchema: Record<string, unknown>;
  surfaceId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface PendingInteractionRepo {
  create(row: PendingInteraction): Promise<void>;
  /** The single open (unresolved) interaction for a conversation, or null. */
  findOpenByConversation(conversationId: string): Promise<PendingInteraction | null>;
  /** Mark an interaction resolved (idempotent). */
  resolve(id: string): Promise<void>;
}

function rowToInteraction(row: Record<string, unknown>): PendingInteraction {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    toolCallId: row.tool_call_id as string,
    toolName: row.tool_name as string,
    awaitedSchema: (row.awaited_schema as Record<string, unknown>) ?? {},
    surfaceId: (row.surface_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
  };
}

export class PgPendingInteractionRepo implements PendingInteractionRepo {
  constructor(private readonly q: Queryable) {}

  async create(row: PendingInteraction): Promise<void> {
    await this.q.query(
      `INSERT INTO pending_interactions
         (id, conversation_id, tool_call_id, tool_name, awaited_schema, surface_id, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        row.id,
        row.conversationId,
        row.toolCallId,
        row.toolName,
        JSON.stringify(row.awaitedSchema),
        row.surfaceId,
        row.createdAt,
        row.resolvedAt,
      ]
    );
  }

  async findOpenByConversation(conversationId: string): Promise<PendingInteraction | null> {
    const { rows } = await this.q.query(
      `SELECT * FROM pending_interactions
       WHERE conversation_id = $1 AND resolved_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId]
    );
    return rows[0] ? rowToInteraction(rows[0]) : null;
  }

  async resolve(id: string): Promise<void> {
    await this.q.query(
      "UPDATE pending_interactions SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL",
      [id]
    );
  }
}

/** In-memory implementation for tests and the default `buildApp` wiring. */
export class MemoryPendingInteractionRepo implements PendingInteractionRepo {
  readonly rows: PendingInteraction[] = [];

  async create(row: PendingInteraction): Promise<void> {
    this.rows.push({ ...row });
  }

  async findOpenByConversation(conversationId: string): Promise<PendingInteraction | null> {
    const open = this.rows
      .filter((r) => r.conversationId === conversationId && r.resolvedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return open[0] ?? null;
  }

  async resolve(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row && row.resolvedAt === null) row.resolvedAt = new Date();
  }
}
