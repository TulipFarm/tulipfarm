import { PGlite } from "@electric-sql/pglite";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DOCUMENT_STORAGE_STATEMENTS, MemoryDocumentRepo } from "./store";
import { updateMemoryTool } from "./tool";

const BUSINESS = "business-1";
const USER = "user-1";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("update_memory", () => {
  let database: PGlite;
  let documents: MemoryDocumentRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of MEMORY_DOCUMENT_STORAGE_STATEMENTS) await database.exec(sql);
    documents = new MemoryDocumentRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM user_memory_revisions; DELETE FROM user_memory");
  });

  function call(args: unknown) {
    return updateMemoryTool.handler(args, {
      businessId: BUSINESS,
      userId: USER,
      documents,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
  }

  it("records a fact and renders it into the document", async () => {
    await expect(call({ section: "identity", add: ["Lives in Bangalore"] })).resolves.toEqual({
      success: true,
      data: { section: "identity", added: 1, removed: 0 },
    });
    expect(await documents.render(BUSINESS, USER)).toBe("## Identity\n\nLives in Bangalore");
  });

  it("corrects a fact in one call", async () => {
    await call({ section: "identity", add: ["Lives in Bangalore"] });
    await call({
      section: "identity",
      add: ["Lives in Pune"],
      remove: ["Lives in Bangalore"],
    });
    expect(await documents.render(BUSINESS, USER)).toBe("## Identity\n\nLives in Pune");
  });

  // Exact matching can miss a paraphrase, so a model told only "success" would assure the user
  // something was forgotten while it is still on file.
  it("tells the model when a removal matched nothing", async () => {
    await call({ section: "identity", add: ["Lives in Bangalore"] });
    const result = await call({ section: "identity", remove: ["Lives in Mumbai"] });
    expect(result).toMatchObject({
      success: true,
      data: { unmatched: ["Lives in Mumbai"], removed: 0 },
    });
    expect((result as { data: { note: string } }).data.note).toMatch(/not.*forgotten/i);
  });

  it("returns a repairable error rather than throwing on forged structure", async () => {
    await expect(call({ section: "identity", add: ["## Preferences"] })).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });

  it("rejects an unknown section and an edit that changes nothing", async () => {
    await expect(call({ section: "invented", add: ["x"] })).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    await expect(call({ section: "identity" })).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });

  // The model has no whole-section overwrite: every write names its own entries.
  it("offers no mode that could overwrite entries the model never saw", () => {
    const properties = (updateMemoryTool.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties).sort()).toEqual(["add", "remove", "section"]);
  });

  it("tells the model to write, not only to apply what it reads", () => {
    expect(updateMemoryTool.description).toMatch(/without being asked/i);
    expect(updateMemoryTool.description).toMatch(/would want to know it next week/i);
  });
});
