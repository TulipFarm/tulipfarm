import { InMemoryAuditEventRepo, verifyChain } from "@tulipfarm/audit";
import {
  McpAccountAuthority,
  McpAccountLifecycle,
  type McpAccountRepository,
} from "@tulipfarm/integrations";
import type { McpAccount, McpAccountGrant, McpChatAccountSelection } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../../audit/service";
import { createMcpAccountAudit } from "./audit";

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
  async setDefault() {
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
  const repo = new InMemoryAuditEventRepo();
  const audit = createMcpAccountAudit(new AuditService(repo, "business"));
  const accounts = new Accounts();
  const authority = new McpAccountAuthority(accounts, {
    isActivePrincipal: async () => true,
    isTeamMember: async () => false,
    canManageShared: async () => false,
  });
  const probe = vi.fn(async (_account: McpAccount, authorize: () => Promise<void>) => authorize());
  const lifecycle = new McpAccountLifecycle({
    accounts,
    authority,
    probe,
    audit,
    definition: async () => ({
      integrationKey: "github-mcp",
      definitionDigest: "a".repeat(64),
      authentication: "token",
      requiredSlots: ["accessToken"],
      sharedAllowed: false,
    }),
    secrets: {
      write: async () => ({ accessToken: "secret://00000000-0000-4000-8000-000000000001" }),
      remove: async () => {},
    },
  });
  return { repo, audit, accounts, probe, lifecycle };
}

const input = {
  label: "GitHub account",
  scope: "personal" as const,
  authentication: "token" as const,
  values: { accessToken: "synthetic-not-a-provider-token" },
};

describe("production MCP account audit adapter", () => {
  it("audits token creation and connection without an optional grant subject", async () => {
    const f = setup();
    const account = await f.lifecycle.create("business", "github-mcp", "user", input);
    expect(account.status).toBe("active");
    expect(f.probe).toHaveBeenCalledOnce();
    expect(account).not.toHaveProperty("secretBindings");
    const chain = await f.repo.listChain("business");
    expect(chain.map((event) => event.action)).toEqual([
      "integration.account.created",
      "integration.account.connected",
    ]);
    expect(chain.map((event) => event.safeMetadata)).toEqual([
      { accountRevision: 1 },
      { accountRevision: 1 },
    ]);
    expect(verifyChain(chain).issues).toEqual([]);
    expect(JSON.stringify(chain)).not.toContain(input.values.accessToken);
  });

  it.each(["integration.account.grant_added", "integration.account.grant_revoked"])(
    "audits %s without an optional account revision",
    async (action) => {
      const f = setup();
      await f.audit({
        action,
        businessId: "business",
        principalId: "admin",
        accountId: "shared-account",
        subject: { kind: "user", id: "member" },
      });
      const [event] = await f.repo.listChain("business");
      expect(event?.safeMetadata).toEqual({ subject: { kind: "user", id: "member" } });
      expect(event?.actor.principalId).toBe("admin");
      expect(event?.target).toBe("integration-account:shared-account");
    }
  );

  it("omits both absent metadata fields and preserves refusal codes", async () => {
    const f = setup();
    await f.audit({
      action: "integration.account.refused",
      businessId: "business",
      principalId: "user",
      accountId: "account",
      code: "account_access_denied",
    });
    const [event] = await f.repo.listChain("business");
    expect(event?.safeMetadata).toEqual({});
    expect(event?.reasonCodes).toEqual(["account_access_denied"]);
  });

  it("does not swallow audit failures, and repairs the same pending account through credential replacement", async () => {
    const f = setup();
    vi.spyOn(f.repo, "append").mockRejectedValueOnce(new Error("Audit storage unavailable"));
    await expect(f.lifecycle.create("business", "github-mcp", "user", input)).rejects.toThrow(
      "Audit storage unavailable"
    );
    expect(f.probe).not.toHaveBeenCalled();
    const pending = [...f.accounts.documents.values()][0];
    expect(pending?.status).toBe("pending");
    if (!pending) throw new Error("Expected the persisted pending account");
    await expect(
      f.lifecycle.update("business", "github-mcp", pending.id, "other-user", {
        values: { accessToken: "synthetic-replacement-token" },
      })
    ).rejects.toMatchObject({ code: "account_access_denied" });
    expect(f.probe).not.toHaveBeenCalled();
    const repaired = await f.lifecycle.update("business", "github-mcp", pending.id, "user", {
      values: { accessToken: "synthetic-replacement-token" },
    });
    expect(repaired).toMatchObject({
      id: pending.id,
      status: "active",
      revision: 2,
      owner: { scope: "personal", principalId: "user" },
    });
    expect(repaired).not.toHaveProperty("secretBindings");
    expect(f.accounts.documents.size).toBe(1);
    expect(f.probe).toHaveBeenCalledOnce();
    expect((await f.repo.listChain("business")).map((event) => event.action)).toEqual([
      "integration.account.credentials_replaced",
      "integration.account.connected",
    ]);
  });

  it("a provider rejection remains action-required and never becomes an unaudited success", async () => {
    const f = setup();
    f.probe.mockRejectedValueOnce(new Error("Synthetic probe refusal"));
    await expect(f.lifecycle.create("business", "github-mcp", "user", input)).rejects.toMatchObject(
      { code: "probe_failed" }
    );
    expect([...f.accounts.documents.values()][0]?.status).toBe("action_required");
    expect((await f.repo.listChain("business")).map((event) => event.action)).toEqual([
      "integration.account.created",
      "integration.account.probe_failed",
    ]);
  });

  it("preserves audit validation rather than sanitizing invalid supplied metadata", async () => {
    const f = setup();
    await expect(
      f.audit({
        action: "integration.account.created",
        businessId: "business",
        principalId: "user",
        accountId: "account",
        revision: Number.NaN,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await f.repo.listChain("business")).toEqual([]);
  });
});
