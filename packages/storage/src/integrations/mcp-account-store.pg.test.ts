import { PGlite } from "@electric-sql/pglite";
import type { McpAccount, McpAccountGrant, McpChatAccountSelection } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { MCP_ACCOUNT_STORAGE_STATEMENTS, McpAccountStore } from "./mcp-account-store";

const DIGEST = "a".repeat(64);
const NOW = "2026-09-18T12:00:00.000Z";

function account(id: string, overrides: Partial<McpAccount> = {}): McpAccount {
  return {
    id,
    businessId: "business",
    integrationKey: "github",
    definitionDigest: DIGEST,
    label: id,
    owner: { scope: "personal", principalId: "user-1" },
    status: "active",
    authentication: "token",
    isDefault: false,
    revision: 1,
    secretBindings: { token: "secret://00000000-0000-4000-8000-000000000001" },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function selection(accountId: string): McpChatAccountSelection {
  return {
    businessId: "business",
    conversationId: "chat",
    principalId: "user-1",
    integrationKey: "github",
    accountId,
    accountRevision: 1,
    definitionDigest: DIGEST,
    sharedConsent: false,
    selectedAt: NOW,
  };
}

describe("McpAccountStore", () => {
  let database: PGlite;
  let store: McpAccountStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of MCP_ACCOUNT_STORAGE_STATEMENTS) await database.exec(statement);
    store = new McpAccountStore(database, transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE mcp_chat_account_selections, mcp_account_grants, mcp_accounts");
  });

  it("round-trips accounts while isolating business and personal owners", async () => {
    await store.save(account("mine"));
    await store.save(account("other", { owner: { scope: "personal", principalId: "other-user" } }));
    await store.save(account("shared", { owner: { scope: "shared" } }));
    expect(await store.get("another-business", "mine")).toBeUndefined();
    expect((await store.list("business", "github", "user-1")).map((row) => row.id)).toEqual([
      "mine",
      "shared",
    ]);
    expect(await store.get("business", "mine")).toEqual(account("mine"));
  });

  it("fences revisions and refuses changing account ownership in place", async () => {
    expect(await store.save(account("mine"))).toBe(true);
    expect(await store.save(account("mine"))).toBe(false);
    expect(await store.save(account("mine", { revision: 2 }), 1)).toBe(true);
    expect(await store.save(account("mine", { revision: 3 }), 1)).toBe(false);
    expect(await store.save(account("mine", { owner: { scope: "shared" }, revision: 3 }), 2)).toBe(
      false
    );
  });

  it("finds only accounts bound to the requested secret keys for metadata authorization", async () => {
    await store.save(account("mine"));
    await store.save(
      account("other", {
        secretBindings: { accessToken: "secret://00000000-0000-4000-8000-000000000002" },
      })
    );
    expect(
      (await store.findBySecretKeys(["00000000-0000-4000-8000-000000000001"])).map((a) => a.id)
    ).toEqual(["mine"]);
    expect(await store.findBySecretKeys([])).toEqual([]);
    expect(await store.findBySecretKeys(["not-stored"])).toEqual([]);
  });

  it("moves the default atomically without changing an existing Chat selection", async () => {
    await store.save(account("first"));
    await store.save(account("second"));
    await store.saveSelection(selection("first"));
    expect(await store.setDefault("business", "first", 1, true)).toBe(true);
    expect(await store.setDefault("business", "second", 1, true)).toBe(true);
    expect(
      (await store.list("business", "github", "user-1"))
        .filter((row) => row.isDefault)
        .map((row) => row.id)
    ).toEqual(["second"]);
    expect(await store.selection("business", "chat", "user-1", "github")).toEqual(
      selection("first")
    );
  });

  it("does not let automatic default pinning overwrite an explicit selection", async () => {
    await store.save(account("first"));
    await store.save(account("second"));
    expect(await store.saveSelection(selection("first"))).toBe(true);
    expect(await store.saveSelection(selection("second"), false)).toBe(false);
    expect((await store.selection("business", "chat", "user-1", "github"))?.accountId).toBe(
      "first"
    );
    expect(await store.saveSelection(selection("second"), true)).toBe(true);
  });

  it("cannot pin an obsolete account revision or a changed server definition", async () => {
    await store.save(account("mine", { revision: 2 }));
    expect(await store.saveSelection(selection("mine"))).toBe(false);
    expect(
      await store.saveSelection({
        ...selection("mine"),
        accountRevision: 2,
        definitionDigest: "b".repeat(64),
      })
    ).toBe(false);
    expect(await store.saveSelection({ ...selection("mine"), accountRevision: 2 })).toBe(true);
  });

  it("persists only active shared-account grants at the exact account revision", async () => {
    await store.save(account("mine"));
    await store.save(account("shared", { owner: { scope: "shared" } }));
    const grant: McpAccountGrant = {
      businessId: "business",
      accountId: "shared",
      accountRevision: 1,
      subject: { kind: "user", id: "user-1" },
      grantedBy: "admin",
      grantedAt: NOW,
    };
    expect(await store.saveGrant({ ...grant, accountId: "mine" })).toBe(false);
    expect(await store.saveGrant({ ...grant, accountRevision: 2 })).toBe(false);
    expect(await store.saveGrant(grant)).toBe(true);
    expect(await store.grants("business", "shared")).toEqual([grant]);
    await store.revokeGrant("business", "shared", "user", "user-1");
    expect(await store.grants("business", "shared")).toEqual([]);
  });
});
