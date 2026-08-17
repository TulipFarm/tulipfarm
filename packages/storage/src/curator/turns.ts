import type { Queryable } from "../ports";

/** One pinned Turn as the Curator prompt renders it. */
export interface CuratorPromptTurn {
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText?: string;
}

interface Row {
  turn_id: string;
  role: string;
  content: string;
}

/**
 * Reads the pinned Turns as the Curator is allowed to see them.
 *
 * Only `user` and completed `assistant` text, mirroring {@link listMessages}: a Tool result or an
 * Integration payload can never become a citation, because content that arrived from outside the
 * person is content an attacker can choose.
 */
export class PgCuratorTurnReader {
  constructor(private readonly db: Queryable) {}

  async read(_businessId: string, turnIds: readonly string[]): Promise<CuratorPromptTurn[]> {
    if (turnIds.length === 0) return [];
    const { rows } = await this.db.query<Row>(
      `SELECT m.turn_id, m.role, m.content #>> '{}' AS content
         FROM messages m
        WHERE m.turn_id = ANY($1::text[])
          AND jsonb_typeof(m.content) = 'string'
          AND (
            m.role = 'user'
            OR (m.role = 'assistant' AND EXISTS (
                 SELECT 1 FROM turn_completions c
                  WHERE c.turn_id = m.turn_id AND c.message_id = m.id))
          )
        ORDER BY m.created_at, m.id`,
      [[...turnIds]]
    );
    const byTurn = new Map<string, { user: string[]; assistant: string[] }>();
    for (const row of rows) {
      const entry = byTurn.get(row.turn_id) ?? { user: [], assistant: [] };
      (row.role === "user" ? entry.user : entry.assistant).push(row.content);
      byTurn.set(row.turn_id, entry);
    }
    // Ordered by the manifest, not by the database, so the prompt a Worker builds from one job is
    // byte-identical on a retry and cannot silently reorder the evidence.
    return turnIds.flatMap((turnId) => {
      const entry = byTurn.get(turnId);
      if (!entry) return [];
      const assistantText = entry.assistant.join("\n");
      return [
        {
          turnId,
          userText: entry.user.join("\n"),
          ...(assistantText ? { assistantText } : {}),
        },
      ];
    });
  }
}
