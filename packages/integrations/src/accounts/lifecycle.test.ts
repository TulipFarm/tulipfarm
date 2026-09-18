import type { McpAccount, McpAccountGrant, McpChatAccountSelection } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { McpAccountAuthority, type McpAccountRepository } from "./authority";
import { McpAccountLifecycle } from "./lifecycle";

class Accounts implements McpAccountRepository {
  readonly documents = new Map<string, McpAccount>();

  async get(businessId: string, id: string) {
    const account = this.documents.get(id);
    return account?.businessId === businessId ? structuredClone(account) : undefined;
  }
  async list(businessId: string, integrationKey: string) {
    return [...this.documents.values()]
      .filter(
        (account) => account.businessId === businessId && account.integrationKey === integrationKey
      )
      .map((account) => structuredClone(account));
  }
  async save(account: McpAccount, expectedRevision?: number) {
    if (this.documents.get(account.id)?.revision !== expectedRevision) return false;
    this.documents.set(account.id, structuredClone(account));
    return true;
  }
  async setDefault(businessId: string, id: string, revision: number, isDefault: boolean) {
    const account = await this.get(businessId, id);
    if (!account || account.revision !== revision || account.status !== "active") return false;
    account.isDefault = isDefault;
    this.documents.set(id, account);
    return true;
  }
  async grants(): Promise<McpAccountGrant[]> {
    return [];
  }
  async saveGrant() {
    return true;
  }
  async revokeGrant() {}
  async selection(): Promise<McpChatAccountSelection | undefined> {
    return undefined;
  }
  async saveSelection() {
    return true;
  }
}

function setup() {
  const accounts = new Accounts();
  const authorization = {
    isActivePrincipal: vi.fn(async () => true),
    isTeamMember: vi.fn(async () => false),
    canManageShared: vi.fn(async () => false),
  };
  const authority = new McpAccountAuthority(accounts, authorization);
  let secretSequence = 0;
  const secrets = {
    write: vi.fn(async (values: Readonly<Record<string, string>>) =>
      Object.fromEntries(
        Object.keys(values).map((slot) => [
          slot,
          `secret://00000000-0000-4000-8000-${String(++secretSequence).padStart(12, "0")}`,
        ])
      )
    ),
    remove: vi.fn(async (_bindings: Readonly<Record<string, string>>) => {}),
  };
  const probe = vi.fn(async (_account: McpAccount, authorize: () => Promise<void>) => authorize());
  const definition = vi.fn(async () => ({
    integrationKey: "example",
    definitionDigest: "a".repeat(64),
    authentication: "token" as const,
    requiredSlots: ["accessToken"],
    sharedAllowed: true,
  }));
  const lifecycle = new McpAccountLifecycle({
    accounts,
    authority,
    secrets,
    definition,
    probe,
    audit: vi.fn(async () => {}),
  });
  return { accounts, authorization, secrets, probe, definition, lifecycle };
}

describe("MCP account lifecycle", () => {
  it("does not activate an account until the real probe succeeds", async () => {
    const f = setup();
    f.probe.mockImplementationOnce(async (account, authorize) => {
      expect((await f.accounts.get("business", account.id))?.status).toBe("pending");
      await authorize();
    });
    const result = await f.lifecycle.create("business", "example", "owner", {
      label: "My account",
      scope: "personal",
      authentication: "token",
      values: { accessToken: "private-token" },
      isDefault: true,
    });
    expect(result.status).toBe("active");
    expect(result.isDefault).toBe(true);
    expect(result).not.toHaveProperty("secretBindings");
    expect(JSON.stringify([...f.accounts.documents.values()])).not.toContain("private-token");
  });

  it("keeps a failed probe action-required rather than claiming a verified identity", async () => {
    const f = setup();
    f.probe.mockRejectedValueOnce(new Error("provider quoted private-token"));
    await expect(
      f.lifecycle.create("business", "example", "owner", {
        label: "My account",
        scope: "personal",
        authentication: "token",
        values: { accessToken: "private-token" },
      })
    ).rejects.toMatchObject({ code: "probe_failed" });
    expect([...f.accounts.documents.values()][0]?.status).toBe("action_required");
  });

  it("uses the authorizer for shared creation and never admits another personal owner", async () => {
    const f = setup();
    await expect(
      f.lifecycle.create("business", "example", "owner", {
        label: "Shared",
        scope: "shared",
        authentication: "token",
        values: { accessToken: "token" },
      })
    ).rejects.toMatchObject({ code: "account_access_denied" });
    expect(f.secrets.write).not.toHaveBeenCalled();
    const account = await f.lifecycle.create("business", "example", "owner", {
      label: "Private",
      scope: "personal",
      authentication: "token",
      values: { accessToken: "token" },
    });
    await expect(
      f.lifecycle.update("business", "example", account.id, "another-user", { label: "Take over" })
    ).rejects.toMatchObject({ code: "account_access_denied" });
  });

  it("increments revision before replacement and denies the old binding during verification", async () => {
    const f = setup();
    const account = await f.lifecycle.create("business", "example", "owner", {
      label: "Private",
      scope: "personal",
      authentication: "token",
      values: { accessToken: "old-token" },
    });
    f.probe.mockImplementationOnce(async (replacement, authorize) => {
      expect(replacement.revision).toBe(2);
      expect((await f.accounts.get("business", account.id))?.status).toBe("pending");
      await authorize();
    });
    const updated = await f.lifecycle.update("business", "example", account.id, "owner", {
      values: { accessToken: "new-token" },
    });
    expect(updated.revision).toBe(2);
    expect(f.secrets.remove).toHaveBeenCalledOnce();
  });

  it("persists revocation before removing Secrets and cannot reactivate after a racing probe", async () => {
    const f = setup();
    f.probe.mockImplementationOnce(async (account, authorize) => {
      f.secrets.remove.mockImplementationOnce(async () => {
        expect((await f.accounts.get("business", account.id))?.status).toBe("revoked");
      });
      await f.lifecycle.revoke("business", "example", account.id, "owner");
      await authorize();
    });
    await expect(
      f.lifecycle.create("business", "example", "owner", {
        label: "Private",
        scope: "personal",
        authentication: "token",
        values: { accessToken: "token" },
      })
    ).rejects.toMatchObject({ code: "conflict" });
    expect([...f.accounts.documents.values()][0]?.status).toBe("revoked");
  });

  it("does not accept undeclared slots or pretend a pasted token is OAuth", async () => {
    const f = setup();
    await expect(
      f.lifecycle.create("business", "example", "owner", {
        label: "Private",
        scope: "personal",
        authentication: "token",
        values: { accessToken: "token", HOST_SECRET: "not-allowed" },
      })
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(
      f.lifecycle.create("business", "example", "owner", {
        label: "Private",
        scope: "personal",
        authentication: "oauth",
      })
    ).rejects.toMatchObject({ code: "authentication_mismatch" });
  });
});
