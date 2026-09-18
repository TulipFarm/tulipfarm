import { PGlite } from "@electric-sql/pglite";
import type { McpAccount } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { MCP_ACCOUNT_STORAGE_STATEMENTS, McpAccountStore } from "./mcp-account-store";
import {
  MCP_OAUTH_STORAGE_STATEMENTS,
  type McpOAuthBinding,
  McpOAuthStore,
} from "./mcp-oauth-store";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const EXPIRES = new Date(NOW.getTime() + 60_000);
const REF = "secret://00000000-0000-4000-8000-000000000001";
const NEXT_REF = "secret://00000000-0000-4000-8000-000000000002";
const ACCOUNT: McpAccount = {
  id: "account",
  businessId: "business",
  integrationKey: "github-mcp",
  definitionDigest: "a".repeat(64),
  label: "Personal GitHub",
  owner: { scope: "personal", principalId: "user" },
  status: "active",
  authentication: "oauth",
  isDefault: true,
  revision: 1,
  secretBindings: { oauth: REF },
  expiresAt: NOW.toISOString(),
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
const BINDING: McpOAuthBinding = {
  businessId: ACCOUNT.businessId,
  integrationKey: ACCOUNT.integrationKey,
  accountId: ACCOUNT.id,
  accountRevision: ACCOUNT.revision,
  definitionDigest: ACCOUNT.definitionDigest,
  principalId: "user",
  sessionId: "session",
  callbackUrl: "https://tulip.test/oauth/callback",
  issuer: "https://provider.test",
};

describe("McpOAuthStore", () => {
  let database: PGlite;
  let accounts: McpAccountStore;
  let store: McpOAuthStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [...MCP_ACCOUNT_STORAGE_STATEMENTS, ...MCP_OAUTH_STORAGE_STATEMENTS])
      await database.exec(statement);
    accounts = new McpAccountStore(database, transactionPort(database));
    store = new McpOAuthStore(database);
  });
  afterAll(async () => database.close());
  beforeEach(async () => {
    await database.exec("TRUNCATE mcp_accounts CASCADE");
    await accounts.save(ACCOUNT);
  });

  it("consumes browser state once and only for its exact session and callback", async () => {
    const attempt = {
      stateDigest: "state",
      binding: BINDING,
      secretRef: REF,
      expiresAt: EXPIRES.toISOString(),
    };
    expect(await store.create(attempt)).toBe(true);
    expect(await store.create(attempt)).toBe(false);
    expect(
      await store.consume("state", { ...BINDING, sessionId: "another-session" }, NOW)
    ).toBeUndefined();
    expect(
      await store.consume("state", { ...BINDING, callbackUrl: "https://other.test" }, NOW)
    ).toBeUndefined();
    expect(await store.consume("state", BINDING, NOW)).toEqual(attempt);
    expect(await store.consume("state", BINDING, NOW)).toBeUndefined();
  });

  it("fences refresh publication and release after another worker takes the expired claim", async () => {
    const first = await store.claimRefresh("business", "account", 1, "first", NOW, EXPIRES);
    if (!first) throw new Error("First refresh claim was not acquired");
    expect(
      await store.claimRefresh("business", "account", 1, "second", NOW, EXPIRES)
    ).toBeUndefined();
    const nextExpiry = new Date(EXPIRES.getTime() + 60_000);
    const second = await store.claimRefresh(
      "business",
      "account",
      1,
      "second",
      EXPIRES,
      nextExpiry
    );
    if (!second) throw new Error("Replacement refresh claim was not acquired");
    const refreshed = { ...ACCOUNT, secretBindings: { oauth: NEXT_REF } };
    expect(await store.publishRefresh(first, refreshed, EXPIRES)).toBe(false);
    expect(await store.failRefresh(first, REF, EXPIRES)).toBe(false);
    await store.releaseRefresh(first);
    expect(await store.currentRefresh(second, EXPIRES)).toBe(true);
    expect(await store.publishRefresh(second, refreshed, EXPIRES)).toBe(true);
    expect((await accounts.get("business", "account"))?.secretBindings).toEqual({
      oauth: NEXT_REF,
    });
  });

  it("refuses publication after the account authority revision changes", async () => {
    const claim = await store.claimRefresh("business", "account", 1, "worker", NOW, EXPIRES);
    if (!claim) throw new Error("Refresh claim was not acquired");
    await accounts.save({ ...ACCOUNT, revision: 2, status: "revoked" }, 1);
    expect(await store.currentRefresh(claim, NOW)).toBe(false);
    expect(await store.publishRefresh(claim, ACCOUNT, NOW)).toBe(false);
    expect(await store.failRefresh(claim, REF, NOW)).toBe(false);
    expect((await accounts.get("business", "account"))?.status).toBe("revoked");
  });

  it("does not let an expired refresh claim disable an account", async () => {
    const claim = await store.claimRefresh("business", "account", 1, "worker", NOW, EXPIRES);
    if (!claim) throw new Error("Refresh claim was not acquired");
    expect(await store.failRefresh(claim, REF, EXPIRES)).toBe(false);
    expect((await accounts.get("business", "account"))?.status).toBe("active");
  });
});
