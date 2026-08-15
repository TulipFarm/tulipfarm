interface CursorState {
  createdAt: string;
  _id: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(doc: { createdAt: Date; _id: string }): string {
  const state: CursorState = { createdAt: doc.createdAt.toISOString(), _id: doc._id };
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

export function decodeCursor(cursor: string): { createdAt: Date; _id: string } | null {
  try {
    const state = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (
      typeof state !== "object" ||
      state === null ||
      typeof (state as CursorState).createdAt !== "string" ||
      typeof (state as CursorState)._id !== "string"
    ) {
      return null;
    }
    const parsed = state as CursorState;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, _id: parsed._id };
  } catch {
    return null;
  }
}

export function parsePaginationQuery(query: Record<string, unknown>): {
  limit: number;
  after?: { createdAt: Date; _id: string };
} {
  const rawLimit = Number(query.limit);
  const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(Math.floor(rawLimit), 1), 100);

  if (typeof query.cursor !== "string" || query.cursor === "") {
    return { limit };
  }

  const after = decodeCursor(query.cursor);
  return after ? { limit, after } : { limit };
}

/** Builds keyset pages from `limit + 1` over-fetch; cursor is the last kept item. */
export function toPage<T extends { createdAt: Date; _id: string }>(
  rows: T[],
  limit: number
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
  return { items, nextCursor };
}
