import { McpAccountAccessError } from "@tulipfarm/integrations";
import type { McpAccount } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../../identity/principal";
import { createIntegrationSecretMetadata } from "./secret-metadata";

const KEY = "00000000-0000-4000-8000-000000000001";
const principal: RequestPrincipal = {
  id: "owner",
  businessId: "business",
  kind: "user",
  credential: "session",
  authMethods: [],
  authenticatedAt: new Date(),
};
const account: McpAccount = {
  id: "account",
  businessId: "business",
  integrationKey: "github-mcp",
  label: "My GitHub",
  definitionDigest: "a".repeat(64),
  owner: { scope: "personal", principalId: "owner" },
  status: "active",
  authentication: "token",
  isDefault: true,
  revision: 2,
  secretBindings: { accessToken: `secret://${KEY}` },
  expiresAt: null,
  createdAt: "2026-09-18T08:00:00.000Z",
  updatedAt: "2026-09-19T08:00:00.000Z",
};

function fixture(accounts: McpAccount[] = [account]) {
  const assertManage = vi.fn(async () => {});
  const findBySecretKeys = vi.fn(async () => accounts);
  return {
    assertManage,
    findBySecretKeys,
    metadata: createIntegrationSecretMetadata({
      accounts: { findBySecretKeys },
      authority: { assertManage },
      integrationLabel: () => "GitHub",
    }),
  };
}

describe("integration Secret metadata", () => {
  it("maps only the requested current binding after checking account management", async () => {
    const { metadata, assertManage, findBySecretKeys } = fixture();
    const result = await metadata([KEY], principal);
    expect(findBySecretKeys).toHaveBeenCalledWith([KEY]);
    expect(assertManage).toHaveBeenCalledWith(account, "owner");
    expect(result.get(KEY)).toEqual({
      key: "github-mcp",
      label: "GitHub",
      accountId: "account",
      accountLabel: "My GitHub",
      accountCreatedAt: account.createdAt,
      scope: "personal",
      field: "accessToken",
    });
    expect(await metadata(["unrelated"], principal)).toEqual(new Map());
  });

  it.each(["account_access_denied", "principal_inactive"] as const)(
    "hides credentials when account authority reports %s",
    async (code) => {
      const { metadata, assertManage } = fixture();
      assertManage.mockRejectedValue(new McpAccountAccessError(code));
      expect((await metadata([KEY], principal)).get(KEY)).toBeNull();
    }
  );

  it("hides accounts from other businesses and service callers without invoking management", async () => {
    const { metadata, assertManage } = fixture();
    expect((await metadata([KEY], { ...principal, businessId: "other" })).get(KEY)).toBeNull();
    expect((await metadata([KEY], { ...principal, kind: "service" })).get(KEY)).toBeNull();
    expect(assertManage).not.toHaveBeenCalled();
  });

  it("includes shared credential metadata only after the same management check", async () => {
    const { metadata, assertManage } = fixture([{ ...account, owner: { scope: "shared" } }]);
    expect((await metadata([KEY], principal)).get(KEY)?.scope).toBe("shared");
    expect(assertManage).toHaveBeenCalledOnce();
  });

  it("propagates infrastructure failures instead of presenting credentials as custom", async () => {
    const { metadata, assertManage } = fixture();
    assertManage.mockRejectedValue(new Error("database unavailable"));
    await expect(metadata([KEY], principal)).rejects.toThrow("database unavailable");
  });
});
