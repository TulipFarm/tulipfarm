import { contentText, normalizeMessageContent } from "@tulipfarm/schema";
import type { Queryable } from "../ports";

/** Where one person's curation got to, and how it has been going. */
export interface MemoryCurationWatermark {
  readonly curatedThrough: Date;
  readonly lastRunAt?: Date;
  readonly failures: number;
}

/** A person with unread Turns, and the newest Turn time seen for them in this scan. */
export interface MemoryCurationCandidate {
  readonly userId: string;
  readonly newestTurnAt: Date;
}

/** One Turn's worth of what the person typed. */
export interface MemoryCurationTurn {
  readonly turnId: string;
  readonly createdAt: Date;
  readonly userText: string;
}

/** Before any run has happened, everything is new. */
export const MEMORY_CURATION_EPOCH = new Date(0);

/**
 * The Curator's view of Conversations and its own watermark.
 *
 * Reads only what the person themselves typed. Assistant text is deliberately unreachable from
 * here: it echoes whatever a Tool or an Integration returned, so reading it would let a hostile
 * support email or web page write a sentence into somebody's durable memory.
 */
export class PgMemoryCurationStore {
  constructor(private readonly db: Queryable) {}

  /**
   * People whose Conversations gained a Turn since they were last curated, oldest backlog first.
   *
   * Oldest first is fairness, and it is also what makes backfill drain: a person catching up from
   * `epoch` keeps their place at the front until they reach the present, rather than being pushed
   * behind everyone who spoke more recently.
   */
  async listUsersWithNewTurns(
    businessId: string,
    limit: number
  ): Promise<MemoryCurationCandidate[]> {
    const { rows } = await this.db.query<{ user_id: string; newest: Date }>(
      `SELECT c.user_id::text AS user_id, MAX(t.created_at) AS newest
         FROM conversation_turns t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN users u ON u.id = c.user_id
         LEFT JOIN memory_curation_watermark w
                ON w.business_id = $1 AND w.user_id = c.user_id::text
        WHERE t.created_at > COALESCE(w.curated_through, to_timestamp(0))
        GROUP BY c.user_id
        ORDER BY MAX(t.created_at)
        LIMIT $2`,
      [businessId, limit]
    );
    return rows.map((row) => ({ userId: row.user_id, newestTurnAt: new Date(row.newest) }));
  }

  /**
   * One bounded window of what a person said after `after`, oldest first.
   *
   * Bounded rather than complete on purpose: a person with a year of history is curated over
   * successive hours, each carrying the document forward, instead of one call that would exceed
   * any context window and cost a year of tokens at once.
   */
  async readWindow(input: {
    userId: string;
    after: Date;
    limit: number;
  }): Promise<MemoryCurationTurn[]> {
    const { rows } = await this.db.query<{
      turn_id: string;
      created_at: Date;
      content: unknown;
    }>(
      `SELECT t.id AS turn_id, t.created_at, m.content
         FROM conversation_turns t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN messages m ON m.turn_id = t.id AND m.role = 'user'
        WHERE c.user_id = $1::uuid AND t.created_at > $2
        ORDER BY t.created_at, t.id, m.created_at
        LIMIT $3`,
      [input.userId, input.after, input.limit]
    );
    const byTurn = new Map<string, MemoryCurationTurn>();
    for (const row of rows) {
      const text = contentText(normalizeMessageContent(row.content));
      if (text.length === 0) continue;
      const existing = byTurn.get(row.turn_id);
      byTurn.set(row.turn_id, {
        turnId: row.turn_id,
        createdAt: new Date(row.created_at),
        userText: existing ? `${existing.userText}\n${text}` : text,
      });
    }
    return [...byTurn.values()];
  }

  async readWatermark(businessId: string, userId: string): Promise<MemoryCurationWatermark> {
    const { rows } = await this.db.query<{
      curated_through: Date;
      last_run_at: Date | null;
      failures: number;
    }>(
      `SELECT curated_through, last_run_at, failures
         FROM memory_curation_watermark
        WHERE business_id = $1 AND user_id = $2`,
      [businessId, userId]
    );
    const row = rows[0];
    if (!row) return { curatedThrough: MEMORY_CURATION_EPOCH, failures: 0 };
    return {
      curatedThrough: new Date(row.curated_through),
      ...(row.last_run_at === null ? {} : { lastRunAt: new Date(row.last_run_at) }),
      failures: Number(row.failures),
    };
  }

  /**
   * Moves the mark forward and clears the failure count.
   *
   * `GREATEST` rather than a plain assignment: two ticks overlapping must never move the mark
   * backwards, because everything between the two positions would then be read a second time and
   * the same facts re-proposed.
   */
  async advanceWatermark(input: {
    businessId: string;
    userId: string;
    curatedThrough: Date;
    now: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO memory_curation_watermark
         (business_id, user_id, curated_through, last_run_at, failures)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (business_id, user_id) DO UPDATE
         SET curated_through = GREATEST(memory_curation_watermark.curated_through, EXCLUDED.curated_through),
             last_run_at = EXCLUDED.last_run_at,
             failures = 0`,
      [input.businessId, input.userId, input.curatedThrough, input.now]
    );
  }

  /**
   * Records that a window could not be curated, and reports how many times it now has not been.
   *
   * The mark stays where it is, so the same window is retried on the next tick. The count is what
   * lets the caller give up: a window nothing can consume would otherwise block that person's
   * memory permanently, and a person stuck forever is worse than one lost hour.
   */
  async recordFailure(input: { businessId: string; userId: string; now: Date }): Promise<number> {
    const { rows } = await this.db.query<{ failures: number }>(
      `INSERT INTO memory_curation_watermark
         (business_id, user_id, curated_through, last_run_at, failures)
       VALUES ($1, $2, to_timestamp(0), $3, 1)
       ON CONFLICT (business_id, user_id) DO UPDATE
         SET failures = memory_curation_watermark.failures + 1,
             last_run_at = EXCLUDED.last_run_at
       RETURNING failures`,
      [input.businessId, input.userId, input.now]
    );
    return Number(rows[0]?.failures ?? 1);
  }
}
