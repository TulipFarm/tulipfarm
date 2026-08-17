import { PGlite } from "@electric-sql/pglite";
import { MEMORY_DOCUMENT_STORAGE_STATEMENTS, MemoryDocumentRepo } from "@tulipfarm/memory";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryErasureService } from "./erasure";

const BUSINESS = "business-1";
const USER = "3f6b2c1e-0d4a-4b8e-9c1f-2a7d5e8b3c40";
const OTHER = "9a1c4d2b-6e3f-4a7c-8d5b-1f2e3c4a5b60";
const NOW = new Date("2026-01-01T00:00:00Z");

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("MemoryErasureService (PostgreSQL)", () => {
  let database: PGlite;
  let erasure: MemoryErasureService;
  let documents: MemoryDocumentRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of MEMORY_DOCUMENT_STORAGE_STATEMENTS) await database.exec(sql);
    erasure = new MemoryErasureService(transactionPort(database));
    documents = new MemoryDocumentRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  /** Two writes, so the user has revision history to erase and not just a current document. */
  async function seed(userId: string, tag: string): Promise<void> {
    await documents.applyDelta({
      businessId: BUSINESS,
      userId,
      delta: { section: "identity", add: [`Lives in ${tag}`] },
      writer: "tool",
      now: NOW,
    });
    await documents.applyDelta({
      businessId: BUSINESS,
      userId,
      delta: { section: "preferences", add: [`Replies about ${tag}`] },
      writer: "tool",
      now: NOW,
    });
  }

  async function surviving(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of ["user_memory", "user_memory_revisions"]) {
      const { rows } = await database.query(`SELECT count(*)::int AS n FROM ${table}`);
      counts[table] = (rows[0] as { n: number }).n;
    }
    return counts;
  }

  beforeEach(async () => {
    await database.exec("DELETE FROM user_memory_revisions; DELETE FROM user_memory");
  });

  // Leaving the revisions would report success while every superseded copy of the same fact
  // survived — the document is only the newest of them.
  it("erases the document and its whole revision history", async () => {
    await seed(USER, "bangalore");

    const counts = await erasure.eraseUser(BUSINESS, USER);

    expect(counts).toEqual({ documents: 1, revisions: 2 });
    expect(await surviving()).toEqual({ user_memory: 0, user_memory_revisions: 0 });
    expect(await documents.render(BUSINESS, USER)).toBe("");
  });

  it("touches nobody else", async () => {
    await seed(USER, "bangalore");
    await seed(OTHER, "berlin");

    await erasure.eraseUser(BUSINESS, USER);

    expect(await surviving()).toEqual({ user_memory: 1, user_memory_revisions: 2 });
    expect(await documents.render(BUSINESS, OTHER)).toContain("Lives in berlin");
  });

  it("is idempotent, so a retried erase is not an error", async () => {
    await seed(USER, "bangalore");
    await erasure.eraseUser(BUSINESS, USER);

    const second = await erasure.eraseUser(BUSINESS, USER);

    expect(second).toEqual({ documents: 0, revisions: 0 });
  });

  it("reports nothing erased for a user who never had a document", async () => {
    expect(await erasure.eraseUser(BUSINESS, USER)).toEqual({ documents: 0, revisions: 0 });
  });
});
