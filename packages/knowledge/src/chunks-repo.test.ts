import { ambientTransactionPort, type Queryable, withTransaction } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { PgKnowledgeChunkRepo, toPrefixTsQuery } from "./chunks-repo";

/** Records every statement so a test can assert on the SQL and the bound parameters. */
function recordingQueryable(): Queryable & { calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable & { calls: { sql: string; params: unknown[] }[] };
}

describe("PgKnowledgeChunkRepo transaction ownership", () => {
  it("opens and commits its own transaction for a standalone pg Pool", async () => {
    const client = { ...recordingQueryable(), release: vi.fn() };
    const pool = { ...recordingQueryable(), connect: vi.fn(async () => client) };
    await new PgKnowledgeChunkRepo(pool).replaceForPage("page", []);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      "SELECT id FROM knowledge_pages WHERE id = $1 FOR UPDATE",
      "DELETE FROM knowledge_chunks WHERE page_id = $1",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("leaves commit and rollback to the enclosing pg lease transaction", async () => {
    const client = { ...recordingQueryable(), release: vi.fn() };
    const pool = { ...recordingQueryable(), connect: vi.fn(async () => client) };
    await expect(
      withTransaction(pool, async (tx) => {
        await new PgKnowledgeChunkRepo(tx, ambientTransactionPort(tx)).replaceForPage("page", [
          {
            chunkIndex: 0,
            content: "New generation",
            contentHash: "hash",
            embedding: null,
            model: null,
            dim: null,
          },
        ]);
        throw new Error("lease fence lost");
      })
    ).rejects.toThrow("lease fence lost");
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.calls.map(({ sql }) => sql.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "SELECT",
      "DELETE",
      "INSERT",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("toPrefixTsQuery", () => {
  it("turns each alphanumeric term into a prefix term", () => {
    expect(toPrefixTsQuery("google auth")).toBe("google:* & auth:*");
  });

  it("yields an empty string when the query holds no usable terms", () => {
    expect(toPrefixTsQuery("   ?!  ")).toBe("");
  });
});

describe("PgKnowledgeChunkRepo.searchLexical", () => {
  it("binds prefix terms so a shorter term still matches a longer stem", async () => {
    const q = recordingQueryable();
    await new PgKnowledgeChunkRepo(q).searchLexical("google auth", 10, {});

    expect(q.calls).toHaveLength(1);
    // `auth:*` is what lets the chunk containing "authentication" match; `websearch_to_tsquery`
    // bound the raw phrase and matched nothing.
    expect(q.calls[0]?.params[0]).toBe("google:* & auth:*");
    expect(q.calls[0]?.sql).toContain("to_tsquery('english', $1)");
    expect(q.calls[0]?.sql).not.toContain("websearch_to_tsquery");
  });

  it("returns no hits without querying when the query has no usable terms", async () => {
    const q = recordingQueryable();
    // `to_tsquery('english', '')` raises in Postgres, so this must never reach the database.
    await expect(new PgKnowledgeChunkRepo(q).searchLexical("  !!  ", 10, {})).resolves.toEqual([]);
    expect(q.calls).toHaveLength(0);
  });
});
