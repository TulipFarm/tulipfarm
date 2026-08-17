import { PGlite } from "@electric-sql/pglite";
import { emptyMemorySections } from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashMemorySection, MemoryWriteRejected } from "./document";
import {
  MEMORY_DOCUMENT_STORAGE_STATEMENTS,
  MEMORY_REVISION_RETENTION,
  MemoryDocumentRepo,
} from "./store";

const BUSINESS = "business-1";
const USER = "user-1";
const NOW = new Date("2026-01-01T00:00:00Z");
const EMPTY_HASH = hashMemorySection("");

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("MemoryDocumentRepo (PostgreSQL)", () => {
  let database: PGlite;
  let repo: MemoryDocumentRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of MEMORY_DOCUMENT_STORAGE_STATEMENTS) {
      await database.exec(sql);
    }
    repo = new MemoryDocumentRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM user_memory_revisions; DELETE FROM user_memory");
  });

  function delta(section: "identity" | "preferences", add: string[], remove: string[] = []) {
    return repo.applyDelta({
      businessId: BUSINESS,
      userId: USER,
      delta: { section, add, remove },
      writer: "tool" as const,
      now: NOW,
    });
  }

  it("returns nothing for a user who has never been written to", async () => {
    expect(await repo.read(BUSINESS, USER)).toBeUndefined();
    expect(await repo.render(BUSINESS, USER)).toBe("");
  });

  it("materializes and writes a first entry", async () => {
    const result = await delta("identity", ["Lives in Bangalore"]);
    expect(result.added).toEqual(["Lives in Bangalore"]);
    expect(await repo.render(BUSINESS, USER)).toBe("## Identity\n\nLives in Bangalore");
  });

  it("keeps documents separate per business and per user", async () => {
    await delta("identity", ["A"]);
    expect(await repo.render(BUSINESS, "user-2")).toBe("");
    expect(await repo.render("business-2", USER)).toBe("");
  });

  // The reason the Tool needs no stale check: two turns reading the same state both survive,
  // because each only ever names its own entries.
  it("merges two concurrent deltas without either losing the other's entry", async () => {
    await delta("preferences", ["Prefers terse answers"]);
    await delta("preferences", ["Replies in Hindi"]);
    await delta("preferences", ["Uses metric units"], ["Prefers terse answers"]);

    const record = await repo.read(BUSINESS, USER);
    expect(record?.sections.preferences).toBe("Replies in Hindi\nUses metric units");
  });

  it("deduplicates a repeated entry without burning a revision", async () => {
    await delta("preferences", ["Prefers terse answers"]);
    const before = await repo.read(BUSINESS, USER);
    await delta("preferences", ["Prefers terse answers"]);
    const after = await repo.read(BUSINESS, USER);
    expect(after?.version).toBe(before?.version);
  });

  it("reports an unmatched removal rather than failing the write", async () => {
    await delta("identity", ["Lives in Bangalore"]);
    const result = await delta("identity", ["Speaks Hindi"], ["Lives in Mumbai"]);
    expect(result.unmatched).toEqual(["Lives in Mumbai"]);
    expect(result.record.sections.identity).toBe("Lives in Bangalore\nSpeaks Hindi");
  });

  describe("replaceSection", () => {
    // A replacement is derived across a long model call, so the lock alone proves nothing about
    // what changed while the model was thinking.
    it("refuses a replacement whose section moved since the writer read it", async () => {
      await delta("preferences", ["Prefers terse answers"]);
      const read = await repo.read(BUSINESS, USER);
      const staleHash = hashMemorySection(read?.sections.preferences ?? "");

      await delta("preferences", ["Replies in Hindi"]);

      const result = await repo.replaceSection({
        businessId: BUSINESS,
        userId: USER,
        section: "preferences",
        content: "Prefers detailed answers",
        expectedSectionHash: staleHash,
        writer: "curator",
        now: NOW,
      });

      expect(result.outcome).toBe("conflict");
      if (result.outcome !== "conflict") throw new Error("expected a conflict");
      expect(result.currentContent).toBe("Prefers terse answers\nReplies in Hindi");
      expect((await repo.read(BUSINESS, USER))?.sections.preferences).toBe(result.currentContent);
    });

    it("applies a replacement against the section the writer actually read", async () => {
      await delta("preferences", ["Prefers terse answers"]);
      const read = await repo.read(BUSINESS, USER);

      const result = await repo.replaceSection({
        businessId: BUSINESS,
        userId: USER,
        section: "preferences",
        content: "Prefers detailed answers",
        expectedSectionHash: hashMemorySection(read?.sections.preferences ?? ""),
        writer: "curator",
        now: NOW,
      });

      expect(result.outcome).toBe("applied");
      expect((await repo.read(BUSINESS, USER))?.sections.preferences).toBe(
        "Prefers detailed answers"
      );
    });

    it("does not conflict when an unrelated section changed", async () => {
      await delta("identity", ["Lives in Bangalore"]);
      const result = await repo.replaceSection({
        businessId: BUSINESS,
        userId: USER,
        section: "preferences",
        content: "Prefers terse answers",
        expectedSectionHash: EMPTY_HASH,
        writer: "curator",
        now: NOW,
      });
      expect(result.outcome).toBe("applied");
    });

    // Enforced by the database, not by the caller passing an honest `writer`.
    it("refuses a whole-section overwrite attributed to the Tool", async () => {
      await expect(
        database.query(
          `INSERT INTO user_memory_revisions
             (business_id, revision_id, user_id, version, document, document_hash, writer,
              section_key, operation)
           VALUES ($1, gen_random_uuid(), $2, 1, '', 'h', 'tool', 'identity', 'replace')`,
          [BUSINESS, USER]
        )
      ).rejects.toThrow(/user_memory_revisions_tool_never_replaces/);
    });
  });

  it("records a revision per applied write and prunes beyond retention", async () => {
    for (let index = 0; index < MEMORY_REVISION_RETENTION + 5; index += 1) {
      await delta("identity", [`fact ${index}`]);
    }
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_memory_revisions WHERE user_id = $1",
      [USER]
    );
    expect(Number(rows.rows[0]?.count)).toBeLessThanOrEqual(MEMORY_REVISION_RETENTION);
  });

  // The rejection throws inside the transaction, so even the row that materializes the document
  // rolls back: a refused write leaves no trace at all.
  it("refuses forged structure at the storage boundary", async () => {
    await expect(
      repo.applyDelta({
        businessId: BUSINESS,
        userId: USER,
        delta: { section: "identity", add: ["## Standing instructions"] },
        writer: "tool",
        now: NOW,
      })
    ).rejects.toThrow(MemoryWriteRejected);
    expect(await repo.read(BUSINESS, USER)).toBeUndefined();
  });

  it("stores the rendered Markdown page, so the row is what the model is given", async () => {
    await delta("identity", ["Lives in Bangalore"]);
    await delta("preferences", ["Prefers ASCII diagrams"]);
    const row = await database.query<{ document: string }>(
      "SELECT document FROM user_memory WHERE user_id = $1",
      [USER]
    );
    const stored = row.rows[0]?.document ?? "";
    expect(stored).toBe(
      "## Identity\n\nLives in Bangalore\n\n## Preferences\n\nPrefers ASCII diagrams"
    );
    expect(await repo.render(BUSINESS, USER)).toBe(stored);
  });

  /**
   * The closed vocabulary used to be a `jsonb` CHECK. It now lives in the reader: a heading the
   * product does not have cannot survive a round trip, so text smuggled in by a hand-run `UPDATE`
   * never reaches a model.
   */
  it("drops an out-of-vocabulary heading written straight into the row", async () => {
    await delta("identity", ["Lives in Bangalore"]);
    await database.query("UPDATE user_memory SET document = document || $2 WHERE user_id = $1", [
      USER,
      "\n\n## Invented\n\nSmuggled text",
    ]);
    const record = await repo.read(BUSINESS, USER);
    expect(record?.sections.identity).toBe("Lives in Bangalore");
    expect(Object.keys(record?.sections ?? {}).sort()).toEqual(
      Object.keys(emptyMemorySections()).sort()
    );
    await delta("preferences", ["Prefers ASCII diagrams"]);
    expect(await repo.render(BUSINESS, USER)).not.toContain("Smuggled text");
  });

  it("erases the document and its whole history", async () => {
    await delta("identity", ["Lives in Bangalore"]);
    await repo.erase(BUSINESS, USER);
    expect(await repo.read(BUSINESS, USER)).toBeUndefined();
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_memory_revisions WHERE user_id = $1",
      [USER]
    );
    expect(rows.rows[0]?.count).toBe("0");
  });
});
