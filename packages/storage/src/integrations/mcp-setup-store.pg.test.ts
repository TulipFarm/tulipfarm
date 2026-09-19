import { PGlite } from "@electric-sql/pglite";
import type { McpSetupOperation } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MCP_SETUP_STORAGE_STATEMENTS, McpSetupStore } from "./mcp-setup-store";

const operation: McpSetupOperation = {
  id: "operation",
  businessId: "business",
  principalId: "user",
  integrationKey: "github-mcp",
  accountId: "account",
  intentDigest: "a".repeat(64),
  baseline: {
    server: {
      id: "github-mcp",
      label: "GitHub",
      transport: { type: "streamable-http", url: "https://example.com/mcp" },
      authentication: { type: "token" },
    },
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  },
  baseRevision: null,
  initializePolicy: true,
  confirmShared: false,
  status: "retry",
};

describe("durable MCP setup store", () => {
  let db: PGlite;
  let store: McpSetupStore;
  beforeAll(async () => {
    db = new PGlite();
    for (const statement of MCP_SETUP_STORAGE_STATEMENTS) await db.exec(statement);
    store = new McpSetupStore(db);
  });
  beforeEach(async () => {
    await db.exec("TRUNCATE mcp_setup_operations");
  });
  afterAll(async () => {
    await db.close();
  });

  it("keeps original intent and reserved identity across insertion retries and process reconstruction", async () => {
    await store.insert(operation);
    await store.insert({
      ...operation,
      accountId: "replacement",
      legacyEmptyPolicyConsent: "use_standard_access",
    });
    expect(await new McpSetupStore(db).get("business", "operation")).toEqual(operation);
    expect(await store.get("another-business", "operation")).toBeUndefined();
    expect(await store.list("business", "user", "github-mcp", "account")).toEqual([operation]);
    expect(await store.list("business", "other-user", "github-mcp", "account")).toEqual([]);
  });
  it("fences expired and superseded workers, including stale release", async () => {
    await store.insert(operation);
    expect(await store.claim("business", "operation", "first")).toBe(true);
    expect(await store.claim("business", "operation", "second")).toBe(false);
    await db.exec("UPDATE mcp_setup_operations SET lease_until=now()-interval '1 second'");
    await expect(store.save({ ...operation, status: "done" }, "first")).rejects.toThrow(
      "lease expired"
    );
    expect(await store.claim("business", "operation", "second")).toBe(true);
    await store.release("business", "operation", "first");
    await expect(store.save(operation, "first")).rejects.toThrow("lease expired");
    await store.save({ ...operation, status: "done" }, "second");
    expect((await store.get("business", "operation"))?.status).toBe("done");
    await store.release("business", "operation", "second");
    expect(await store.claim("business", "operation", "third")).toBe(true);
  });
  it("rejects credential-bearing or corrupted operation documents", async () => {
    await expect(
      store.insert({ ...operation, values: { accessToken: "synthetic" } } as McpSetupOperation)
    ).rejects.toMatchObject({ name: "TulipFarmValidationError" });
    await store.insert(operation);
    await db.exec("UPDATE mcp_setup_operations SET document=document-'principalId'");
    await expect(store.get("business", "operation")).rejects.toMatchObject({
      name: "TulipFarmValidationError",
    });
  });
});
