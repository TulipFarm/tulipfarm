import { createHash, randomBytes } from "node:crypto";
import type { McpAccount } from "@tulipfarm/schema";
import type { McpOAuthAttempt } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { McpAccountAuthority, type McpAccountRepository } from "./authority";
import { McpAccountLifecycle } from "./lifecycle";
import {
  McpOAuthLifecycle,
  type McpOAuthLifecycleDeps,
  type McpOAuthProtocol,
  type McpOAuthVault,
} from "./oauth";

function fixture() {
  let account: McpAccount = {
    id: "account",
    businessId: "business",
    integrationKey: "example",
    definitionDigest: "a".repeat(64),
    label: "Muskan Vijayvargiya",
    owner: { scope: "personal", principalId: "owner" },
    authentication: "oauth",
    status: "pending",
    isDefault: false,
    revision: 1,
    secretBindings: {},
    expiresAt: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
  const accounts: McpAccountRepository = {
    get: vi.fn(async () => structuredClone(account)),
    list: vi.fn(async () => [structuredClone(account)]),
    save: vi.fn(async (next, revision) => {
      if (account.revision !== revision) return false;
      account = structuredClone(next);
      return true;
    }),
    setDefault: vi.fn(async () => true),
    grants: vi.fn(async () => []),
    saveGrant: vi.fn(async () => true),
    revokeGrant: vi.fn(async () => {}),
    selection: vi.fn(async () => undefined),
    saveSelection: vi.fn(async () => true),
  };
  const secrets = new Map<string, string>();
  let sequence = 0;
  const vault: McpOAuthVault = {
    async write(values) {
      return Object.fromEntries(
        Object.entries(values).map(([slot, value]) => {
          const reference = `secret://00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
          secrets.set(reference, value);
          return [slot, reference];
        })
      );
    },
    async remove(bindings) {
      for (const reference of Object.values(bindings)) secrets.delete(reference);
    },
    async use(bindings, _scope, authorize, callback) {
      await authorize();
      return callback(
        Object.fromEntries(
          Object.entries(bindings).map(([slot, reference]) => {
            const value = secrets.get(reference);
            if (!value) throw new Error("Secret unavailable");
            return [slot, value];
          })
        )
      );
    },
  };
  const authority = new McpAccountAuthority(accounts, {
    isActivePrincipal: async () => true,
    isTeamMember: async () => false,
    canManageShared: async () => false,
  });
  const definition = async () => ({
    integrationKey: "example",
    definitionDigest: "a".repeat(64),
    authentication: "oauth" as const,
    requiredSlots: [],
    sharedAllowed: true,
    serverUrl: "https://mcp.example.test/mcp",
  });
  const lifecycle = new McpAccountLifecycle({
    accounts,
    authority,
    secrets: vault,
    definition,
    probe: async (_account, authorize) => authorize(),
    audit: async () => {},
  });
  const protocol: McpOAuthProtocol = {
    discover: vi.fn(async () => ({
      serverUrl: "https://mcp.example.test/mcp",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://issuer.example.test",
      authorizationEndpoint: "https://issuer.example.test/authorize",
      tokenEndpoint: "https://issuer.example.test/token",
      codeChallengeMethodsSupported: ["S256"],
    })),
    register: vi.fn(async () => ({
      clientId: "client",
      clientSecret: "client-secret",
      tokenEndpointAuthMethod: "client_secret_basic" as const,
    })),
    start: vi.fn(async (input) => {
      const codeVerifier = randomBytes(48).toString("base64url");
      const url = new URL(input.metadata.authorizationEndpoint);
      url.searchParams.set("state", input.state);
      url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(codeVerifier).digest("base64url")
      );
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("redirect_uri", input.callbackUrl);
      url.searchParams.set("client_id", input.client.clientId);
      url.searchParams.set("response_type", "code");
      return { authorizationUrl: url.toString(), codeVerifier };
    }),
    exchange: vi.fn(async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    })),
    refresh: vi.fn(async () => ({ accessToken: "new-access-token", expiresIn: 3600 })),
  };
  const rows = new Map<string, McpOAuthAttempt>();
  const attempts: McpOAuthLifecycleDeps["attempts"] = {
    async create(attempt) {
      rows.set(attempt.stateDigest, attempt);
      return true;
    },
    async consume(digest, binding, now) {
      const attempt = rows.get(digest);
      if (
        !attempt ||
        Date.parse(attempt.expiresAt) <= now.getTime() ||
        Object.entries(binding).some(
          ([key, value]) =>
            Object.entries(attempt.binding).find(([name]) => name === key)?.[1] !== value
        )
      ) {
        return undefined;
      }
      rows.delete(digest);
      return attempt;
    },
    claimRefresh: vi.fn(async () => undefined),
    currentRefresh: vi.fn(async () => false),
    publishRefresh: vi.fn(async () => false),
    failRefresh: vi.fn(async () => false),
    releaseRefresh: vi.fn(async () => {}),
  };
  let now = new Date("2026-09-18T00:00:00.000Z");
  const oauth = new McpOAuthLifecycle({
    accounts,
    lifecycle,
    attempts,
    secrets: vault,
    protocol,
    definition,
    callbackUrl: () =>
      "https://api.example.test/api/v1/integrations/example/accounts/account/oauth/callback",
    audit: async () => {},
    now: () => now,
  });
  const actor = { businessId: "business", principalId: "owner", sessionId: "session" };
  return {
    oauth,
    actor,
    accounts,
    protocol,
    attempts,
    rows,
    secrets,
    account: () => account,
    advance: () => {
      now = new Date(now.getTime() + 11 * 60_000);
    },
  };
}

describe("MCP OAuth lifecycle", () => {
  it("shows the account callback for app registration without discovery or Secret access", async () => {
    const f = fixture();
    await expect(f.oauth.configuration(f.actor, "example", "account")).resolves.toEqual({
      callbackUrl:
        "https://api.example.test/api/v1/integrations/example/accounts/account/oauth/callback",
    });
    expect(f.protocol.discover).not.toHaveBeenCalled();
    expect(f.protocol.register).not.toHaveBeenCalled();
    expect(f.secrets.size).toBe(0);
    await expect(
      f.oauth.configuration({ ...f.actor, principalId: "other-user" }, "example", "account")
    ).rejects.toMatchObject({ code: "account_access_denied" });
  });

  it("never reuses registered client credentials after the server definition changes", async () => {
    const f = fixture();
    f.account().definitionDigest = "b".repeat(64);
    f.account().oauthClient = {
      clientId: "registered-client",
      tokenEndpointAuthMethod: "none",
    };
    await expect(f.oauth.start(f.actor, "example", "account")).rejects.toMatchObject({
      code: "definition_changed",
    });
    expect(f.protocol.discover).not.toHaveBeenCalled();
    expect(f.protocol.start).not.toHaveBeenCalled();
  });

  it("uses an existing OAuth app without requiring dynamic registration", async () => {
    const f = fixture();
    const reference = "secret://00000000-0000-4000-8000-999999999999";
    f.secrets.set(reference, "registered-client-secret");
    f.account().oauthClient = {
      clientId: "registered-client",
      tokenEndpointAuthMethod: "client_secret_post",
    };
    f.account().secretBindings = { oauthClientSecret: reference };
    const started = await f.oauth.start(f.actor, "example", "account");
    expect(f.protocol.register).not.toHaveBeenCalled();
    expect(f.protocol.start).toHaveBeenCalledWith(
      expect.objectContaining({
        client: {
          clientId: "registered-client",
          clientSecret: "registered-client-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      })
    );
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
      "registered-client"
    );
    expect(JSON.stringify(started)).not.toContain("registered-client-secret");
    expect(JSON.stringify([...f.rows.values()])).not.toContain("registered-client-secret");
  });

  it("does not replace missing registered client credentials with dynamic registration", async () => {
    const f = fixture();
    f.account().oauthClient = {
      clientId: "registered-client",
      tokenEndpointAuthMethod: "client_secret_basic",
    };
    await expect(f.oauth.start(f.actor, "example", "account")).rejects.toMatchObject({
      code: "oauth_refresh_required",
    });
    expect(f.protocol.register).not.toHaveBeenCalled();
    expect(f.protocol.start).not.toHaveBeenCalled();
  });

  it("uses random one-use state and S256 while keeping verifier and client secrets out of durable metadata", async () => {
    const f = fixture();
    const started = await f.oauth.start(f.actor, "example", "account");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = [...f.rows.values()][0];
    expect(stored).toBeDefined();
    expect(stored?.stateDigest).toBe(
      createHash("sha256")
        .update(state ?? "")
        .digest("hex")
    );
    expect(JSON.stringify(stored)).not.toContain("client-secret");
    const secret: unknown = JSON.parse(f.secrets.get(stored?.secretRef ?? "") ?? "{}");
    expect(secret).toMatchObject({ client: { clientSecret: "client-secret" } });
    expect(new URL(started.authorizationUrl).searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    );
    expect(f.account().revision).toBe(2);
    expect(f.account().status).toBe("pending");
  });

  it("refuses session substitution and permits only one valid callback", async () => {
    const f = fixture();
    const started = await f.oauth.start(f.actor, "example", "account");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    await expect(
      f.oauth.complete({ ...f.actor, sessionId: "another-session" }, "example", "account", {
        state,
        code: "code",
      })
    ).rejects.toMatchObject({ code: "oauth_invalid_state" });
    expect(f.protocol.exchange).not.toHaveBeenCalled();
    const result = await f.oauth.complete(f.actor, "example", "account", { state, code: "code" });
    expect(result.status).toBe("active");
    expect(f.protocol.exchange).toHaveBeenCalledOnce();
    await expect(
      f.oauth.complete(f.actor, "example", "account", { state, code: "code" })
    ).rejects.toMatchObject({ code: "oauth_invalid_state" });
    expect(JSON.stringify(f.account())).not.toContain("access-token");
  });

  it("rejects issuer mix-up before code exchange and destroys the attempt Secret", async () => {
    const f = fixture();
    const started = await f.oauth.start(f.actor, "example", "account");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    await expect(
      f.oauth.complete(f.actor, "example", "account", {
        state,
        code: "code",
        iss: "https://attacker.example.test",
      })
    ).rejects.toMatchObject({ code: "oauth_issuer_mismatch" });
    expect(f.protocol.exchange).not.toHaveBeenCalled();
    expect(f.secrets.size).toBe(0);
  });

  it("rejects expired state and superseded account revisions", async () => {
    const expired = fixture();
    const started = await expired.oauth.start(expired.actor, "example", "account");
    expired.advance();
    await expect(
      expired.oauth.complete(expired.actor, "example", "account", {
        state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
        code: "code",
      })
    ).rejects.toMatchObject({ code: "oauth_invalid_state" });
    const f = fixture();
    const first = await f.oauth.start(f.actor, "example", "account");
    await f.oauth.start(f.actor, "example", "account");
    await expect(
      f.oauth.complete(f.actor, "example", "account", {
        state: new URL(first.authorizationUrl).searchParams.get("state") ?? "",
        code: "code",
      })
    ).rejects.toMatchObject({ code: "account_binding_changed" });
    expect(f.protocol.exchange).not.toHaveBeenCalled();
  });

  it("refreshes only under a fenced claim without changing the account revision", async () => {
    const f = fixture();
    const started = await f.oauth.start(f.actor, "example", "account");
    await f.oauth.complete(f.actor, "example", "account", {
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      code: "code",
    });
    const before = structuredClone(f.account());
    vi.mocked(f.attempts.claimRefresh).mockResolvedValue({
      businessId: "business",
      accountId: "account",
      accountRevision: before.revision,
      generation: 1,
      claimId: "claim",
    });
    vi.mocked(f.attempts.currentRefresh).mockResolvedValue(true);
    vi.mocked(f.attempts.publishRefresh).mockImplementation(async (_claim, next) =>
      f.accounts.save(next, before.revision)
    );
    await f.oauth.refresh(before, "owner", async () => {});
    expect(f.account().revision).toBe(before.revision);
    expect(f.account().secretBindings.accessToken).not.toBe(before.secretBindings.accessToken);
    expect(f.secrets.has(before.secretBindings.accessToken ?? "")).toBe(false);
    expect(f.protocol.refresh).toHaveBeenCalledOnce();
    expect(f.attempts.releaseRefresh).toHaveBeenCalledOnce();
  });

  it("does not refresh or retry when another caller holds the refresh claim", async () => {
    const f = fixture();
    const started = await f.oauth.start(f.actor, "example", "account");
    await f.oauth.complete(f.actor, "example", "account", {
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      code: "code",
    });
    await expect(f.oauth.refresh(f.account(), "owner", async () => {})).rejects.toMatchObject({
      code: "oauth_refresh_busy",
    });
    expect(f.protocol.refresh).not.toHaveBeenCalled();
  });
});
