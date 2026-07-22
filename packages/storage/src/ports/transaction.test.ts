import { describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "./transaction";

// A journalled fake proves the transaction port's contract: commit on success,
// rollback on throw — without importing `pg` or any provider-specific type.
function fakeTransactionPort(journal: string[]): TransactionPort {
  const tx: Queryable = {
    query: async (text: string) => {
      journal.push(`query:${text}`);
      return { rows: [] };
    },
  };
  return {
    withTransaction: async (fn) => {
      journal.push("BEGIN");
      try {
        const result = await fn(tx);
        journal.push("COMMIT");
        return result;
      } catch (error) {
        journal.push("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("TransactionPort", () => {
  it("commits when the callback resolves", async () => {
    const journal: string[] = [];
    const port = fakeTransactionPort(journal);
    const result = await port.withTransaction(async (tx) => {
      await tx.query("insert 1");
      return 42;
    });
    expect(result).toBe(42);
    expect(journal).toEqual(["BEGIN", "query:insert 1", "COMMIT"]);
  });

  it("rolls back and re-throws when the callback rejects", async () => {
    const journal: string[] = [];
    const port = fakeTransactionPort(journal);
    await expect(
      port.withTransaction(async (tx) => {
        await tx.query("insert 1");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(journal).toEqual(["BEGIN", "query:insert 1", "ROLLBACK"]);
  });
});
