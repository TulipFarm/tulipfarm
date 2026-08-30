import type { Queryable } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
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
