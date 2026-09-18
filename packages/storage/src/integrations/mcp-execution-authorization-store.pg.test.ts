import { PGlite } from "@electric-sql/pglite";
import type { McpExecutionAuthorization } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_EXECUTION_AUTHORIZATION_STORAGE_STATEMENTS,
  McpExecutionAuthorizationStore,
} from "./mcp-execution-authorization-store";

function authorization(): McpExecutionAuthorization {
  return {
    businessId: "business",
    caller: {
      principal: { kind: "user", id: "owner" },
      conversationId: "chat",
      runId: "run",
    },
    capability: { kind: "tool", name: "read_file" },
    contextDigest: "a".repeat(64),
    binding: {
      serverId: "github",
      serverRevision: "b".repeat(64),
      accountId: "personal",
      accountRevision: "1",
      subjectId: "owner",
      authorizationId: "c".repeat(64),
    },
  };
}

describe("MCP execution authorization persistence", () => {
  let db: PGlite;
  let store: McpExecutionAuthorizationStore;
  beforeAll(async () => {
    db = new PGlite();
    for (const statement of MCP_EXECUTION_AUTHORIZATION_STORAGE_STATEMENTS) {
      await db.exec(statement);
    }
    store = new McpExecutionAuthorizationStore(db);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("TRUNCATE mcp_execution_authorizations");
  });

  it("recovers the exact caller and capability through another repository instance", async () => {
    const input = authorization();
    expect(await store.save(input)).toBe(true);
    const resumed = new McpExecutionAuthorizationStore(db);
    expect(await resumed.get(input.businessId, input.binding.authorizationId)).toEqual(input);
    expect(await resumed.get("other-business", input.binding.authorizationId)).toBeUndefined();
  });

  it("allows an identical retry but never overwrites an issued authorization", async () => {
    const input = authorization();
    expect(await store.save(input)).toBe(true);
    expect(await store.save(structuredClone(input))).toBe(true);
    expect(
      await store.save({
        ...input,
        binding: { ...input.binding, accountId: "shared" },
      })
    ).toBe(false);
    expect(
      await store.save({ ...input, capability: { kind: "tool", name: "delete_repository" } })
    ).toBe(false);
    expect(await store.get(input.businessId, input.binding.authorizationId)).toEqual(input);
  });

  it("rejects malformed persisted context instead of inventing an authorized caller", async () => {
    const input = authorization();
    await store.save(input);
    await db.query(
      `UPDATE mcp_execution_authorizations SET document = document - 'caller'
       WHERE business_id = $1 AND authorization_id = $2`,
      [input.businessId, input.binding.authorizationId]
    );
    await expect(store.get(input.businessId, input.binding.authorizationId)).rejects.toMatchObject({
      name: "TulipFarmValidationError",
    });
  });
});
