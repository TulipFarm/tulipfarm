import type { Queryable } from "@tulipfarm/storage";

/**
 * Turns a Page's recorded author into something a reader can act on.
 *
 * A principal id answers "who changed this?" with a UUID, which is no answer at all — the reader is
 * trying to decide whether to trust the Page, and that needs a person's name.
 *
 * Identity lives in `apps/api`, not in `packages/knowledge`, so this resolution happens at the route
 * boundary rather than inside the Knowledge repos.
 */
export class AuthorLabeller {
  constructor(private readonly q: Queryable) {}

  /**
   * @returns the label for each *user* id supplied, keyed by id. An id with no matching user is
   * absent from the map rather than mapped to a placeholder — a Page attributed to a deleted
   * account is unattributed, not attributed to "Unknown User".
   */
  async labels(userIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)].filter((id) => id.length > 0);
    if (ids.length === 0) return new Map();

    const { rows } = await this.q.query(
      `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    const out = new Map<string, string>();
    for (const r of rows) {
      const row = r as { id: string; name: string | null; email: string };
      // An account with no name is still identifiable by the address colleagues already know them by.
      out.set(row.id, row.name?.trim() || row.email);
    }
    return out;
  }

  /**
   * @param kind `"agent"` short-circuits: an Agent's id *is* its name, and looking it up in `users`
   * would either miss or, worse, collide with a person.
   */
  async label(
    kind: string | null | undefined,
    id: string | null | undefined
  ): Promise<string | null> {
    if (!kind || !id) return null;
    if (kind === "agent") return id;
    return (await this.labels([id])).get(id) ?? null;
  }
}
