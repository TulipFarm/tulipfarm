import { PGlite } from "@electric-sql/pglite";
import type { McpKnowledgeSelectionDocument } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  MCP_KNOWLEDGE_STORAGE_STATEMENTS,
  McpKnowledgeFenceError,
  McpKnowledgeStore,
} from "./mcp-knowledge-store";

function selection(): McpKnowledgeSelectionDocument {
  return {
    id: "selection",
    revision: "1",
    binding: {
      businessId: "business",
      integrationId: "github",
      accountId: "account",
      accountRevision: 1,
      configurationRevision: "digest",
      ownerUserId: "owner",
      externalAccountId: "42",
    },
    visibility: "personal",
    enabled: true,
    files: [{ owner: "example", repo: "docs", path: "guide.md", ref: "refs/heads/main" }],
  };
}

describe("McpKnowledgeStore", () => {
  let db: PGlite;
  let store: McpKnowledgeStore;
  beforeAll(async () => {
    db = new PGlite();
    for (const statement of MCP_KNOWLEDGE_STORAGE_STATEMENTS) await db.exec(statement);
    store = new McpKnowledgeStore(db, transactionPort(db));
  });
  beforeEach(async () => {
    await db.exec("TRUNCATE mcp_knowledge_source_links,mcp_knowledge_selections");
  });
  afterAll(async () => db.close());

  it("persists exact selections and resumable progress through reconstruction", async () => {
    await store.save(selection());
    const now = new Date();
    const claim = await store.claimDue("business", "lease-1", now);
    if (!claim) throw new Error("missing claim");
    const checkpoint = {
      selectionRevision: "1",
      nextIndex: 1,
      synced: 1,
      failed: 0,
      complete: true,
      failures: [],
      updatedAt: now.toISOString(),
    };
    await store.checkpoint(claim, checkpoint, now);
    const reconstructed = new McpKnowledgeStore(db, transactionPort(db));
    expect((await reconstructed.get("business", "account"))?.checkpoint).toEqual(checkpoint);
    expect(await reconstructed.get("other-business", "account")).toBeUndefined();
    expect(await reconstructed.claimDue("business", "second-lease", now)).toBeUndefined();
  });

  it("keeps a newer Sync now due when the old job finishes", async () => {
    await store.save(selection());
    const now = new Date();
    const claim = await store.claimDue("business", "lease-1", now);
    if (!claim) throw new Error("missing claim");
    await store.requestSync("business", "account", 1);
    await store.finish(claim, now, new Date(now.getTime() + 900_000), null, true);
    expect((await store.claimDue("business", "lease-2", now))?.leaseId).toBe("lease-2");
  });

  it("rolls back stale revision writes and retains durable erasure until it succeeds", async () => {
    await store.save(selection());
    const now = new Date();
    const claim = await store.claimDue("business", "lease-1", now);
    if (!claim) throw new Error("missing claim");
    await store.withLease(claim, now, (tx) =>
      store.linkSource(tx, claim, "source", "00000000-0000-4000-8000-000000000001")
    );
    await store.disable("business", "account", 1);
    await expect(store.withLease(claim, now, async () => "stale")).rejects.toBeInstanceOf(
      McpKnowledgeFenceError
    );
    await expect(store.finish(claim, now, now, null, true)).rejects.toBeInstanceOf(
      McpKnowledgeFenceError
    );
    await expect(
      store.cleanupBatch("business", async () => {
        throw new Error("purge unavailable");
      })
    ).rejects.toThrow();
    expect((await store.get("business", "account"))?.cleanupPending).toBe(1);
    expect(await store.cleanupBatch("business", async () => {})).toBe(1);
    expect((await store.get("business", "account"))?.cleanupPending).toBe(0);
  });

  it("fences an expired lease even when no other worker has claimed it", async () => {
    await store.save(selection());
    const now = new Date();
    const claim = await store.claimDue("business", "lease-1", now);
    if (!claim) throw new Error("missing claim");
    await expect(
      store.withLease(claim, new Date(now.getTime() + 120_001), async () => true)
    ).rejects.toBeInstanceOf(McpKnowledgeFenceError);
  });

  it("refuses stale edits and never changes a selection's account owner", async () => {
    await store.save(selection());
    await expect(store.save({ ...selection(), revision: "2" }, 2)).rejects.toBeInstanceOf(
      McpKnowledgeFenceError
    );
    await expect(
      store.save(
        {
          ...selection(),
          revision: "2",
          binding: { ...selection().binding, ownerUserId: "other" },
        },
        1
      )
    ).rejects.toBeInstanceOf(McpKnowledgeFenceError);
    await store.markAccountCleanup("business", "account");
    expect((await store.get("business", "account"))?.selection.enabled).toBe(false);
    await expect(store.requestSync("business", "account", 1)).rejects.toBeInstanceOf(
      McpKnowledgeFenceError
    );
  });
});
