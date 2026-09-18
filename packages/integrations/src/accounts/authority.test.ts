import type { McpAccount, McpAccountGrant, McpChatAccountSelection } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import {
  McpAccountAuthority,
  type McpAccountRepository,
  type McpAccountUseContext,
  type McpChatAccountContext,
} from "./authority";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const USER = "user-1";

function account(id = "personal", overrides: Partial<McpAccount> = {}): McpAccount {
  return {
    id,
    businessId: "business",
    integrationKey: "github",
    definitionDigest: DIGEST,
    label: id,
    owner: { scope: "personal", principalId: USER },
    status: "active",
    authentication: "token",
    isDefault: false,
    revision: 1,
    secretBindings: { token: "secret://00000000-0000-4000-8000-000000000001" },
    expiresAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const chat: McpChatAccountContext = {
  kind: "chat",
  businessId: "business",
  integrationKey: "github",
  definitionDigest: DIGEST,
  conversationId: "chat-1",
  principalId: USER,
  visibility: "private",
};

function grant(subject: McpAccountGrant["subject"]): McpAccountGrant {
  return {
    businessId: "business",
    accountId: "shared",
    accountRevision: 1,
    subject,
    grantedBy: "admin",
    grantedAt: NOW.toISOString(),
  };
}

function fixture(initialAccounts: McpAccount[], initialGrants: McpAccountGrant[] = []) {
  const rows = new Map(initialAccounts.map((row) => [row.id, row]));
  const grants = [...initialGrants];
  const selections = new Map<string, McpChatAccountSelection>();
  const key = (business: string, conversation: string, principal: string, integration: string) =>
    JSON.stringify([business, conversation, principal, integration]);
  const repository: McpAccountRepository = {
    get: async (business, id) => {
      const row = rows.get(id);
      return row?.businessId === business ? row : undefined;
    },
    list: async (business, integration, principal) =>
      [...rows.values()].filter(
        (row) =>
          row.businessId === business &&
          row.integrationKey === integration &&
          (row.owner.scope === "shared" || row.owner.principalId === principal)
      ),
    save: async () => true,
    setDefault: async () => true,
    grants: async (business, id) =>
      grants.filter((value) => value.businessId === business && value.accountId === id),
    saveGrant: async () => true,
    revokeGrant: async () => {},
    selection: async (business, conversation, principal, integration) =>
      selections.get(key(business, conversation, principal, integration)),
    saveSelection: vi.fn(async (value, replace = true) => {
      const selectionKey = key(
        value.businessId,
        value.conversationId,
        value.principalId,
        value.integrationKey
      );
      if (!replace && selections.has(selectionKey)) return false;
      selections.set(selectionKey, value);
      return true;
    }),
  };
  const authorization = {
    isActivePrincipal: vi.fn(async () => true),
    isTeamMember: vi.fn(async () => false),
    canManageShared: vi.fn(async () => false),
  };
  return {
    authority: new McpAccountAuthority(repository, authorization, () => NOW),
    repository,
    authorization,
    rows,
    grants,
    selections,
  };
}

function shared(): McpAccount {
  return account("shared", { owner: { scope: "shared" }, isDefault: true });
}

function routine(
  overrides: Partial<Extract<McpAccountUseContext, { kind: "routine" }>> = {}
): Extract<McpAccountUseContext, { kind: "routine" }> {
  return {
    kind: "routine",
    businessId: "business",
    integrationKey: "github",
    definitionDigest: DIGEST,
    routineId: "daily-review",
    ownerPrincipalId: USER,
    visibility: "shared",
    accountId: "shared",
    accountRevision: 1,
    configurationDigest: DIGEST,
    ...overrides,
  };
}

describe("MCP account authority", () => {
  it("resolves private settings without inventing or pinning a Chat", async () => {
    const f = fixture([account(), shared()]);
    await expect(
      f.authority.resolve({
        kind: "interactive",
        businessId: chat.businessId,
        integrationKey: chat.integrationKey,
        definitionDigest: DIGEST,
        principalId: USER,
        purpose: "content",
      })
    ).resolves.toMatchObject({ id: "personal" });
    expect(f.repository.saveSelection).not.toHaveBeenCalled();
  });

  it("requires an explicit shared account and admin authority for setup discovery", async () => {
    const f = fixture([shared()]);
    const context = {
      kind: "interactive" as const,
      businessId: chat.businessId,
      integrationKey: chat.integrationKey,
      definitionDigest: DIGEST,
      principalId: USER,
      purpose: "discovery" as const,
    };
    await expect(f.authority.resolve(context)).rejects.toMatchObject({
      code: "account_required",
    });
    await expect(f.authority.resolve({ ...context, accountId: "shared" })).rejects.toMatchObject({
      code: "account_access_denied",
    });
    f.authorization.canManageShared.mockResolvedValue(true);
    await expect(f.authority.resolve({ ...context, accountId: "shared" })).resolves.toMatchObject({
      id: "shared",
    });
    await expect(
      f.authority.resolve({ ...context, accountId: "shared", purpose: "content" })
    ).rejects.toMatchObject({ code: "shared_consent_required" });
  });

  it("keeps all access checks when admitting an expired OAuth account for refresh", async () => {
    const f = fixture([
      account("personal", { authentication: "oauth", expiresAt: NOW.toISOString() }),
    ]);
    await expect(f.authority.resolve(chat)).rejects.toMatchObject({
      code: "account_expired",
    });
    await expect(f.authority.resolveForRefresh(chat)).resolves.toMatchObject({
      id: "personal",
    });
    await expect(
      f.authority.resolveForRefresh({ ...chat, visibility: "shared" })
    ).rejects.toMatchObject({ code: "private_context_required" });
    f.authorization.isActivePrincipal.mockResolvedValue(false);
    await expect(f.authority.resolveForRefresh(chat)).rejects.toMatchObject({
      code: "principal_inactive",
    });
  });

  it("does not admit an expired token account through the OAuth refresh gate", async () => {
    const f = fixture([account("personal", { expiresAt: NOW.toISOString() })]);
    await expect(f.authority.resolveForRefresh(chat)).rejects.toMatchObject({
      code: "account_expired",
    });
  });

  it("chooses and pins the personal account rather than a shared default", async () => {
    const { authority, selections } = fixture(
      [account(), shared()],
      [grant({ kind: "user", id: USER })]
    );
    expect((await authority.resolve(chat)).id).toBe("personal");
    expect([...selections.values()]).toMatchObject([
      { accountId: "personal", sharedConsent: false },
    ]);
  });

  it("retains the exact pinned account when defaults change", async () => {
    const { authority, rows } = fixture([account("first", { isDefault: true }), account("second")]);
    expect((await authority.resolve(chat)).id).toBe("first");
    rows.set("first", account("first"));
    rows.set("second", account("second", { isDefault: true }));
    expect((await authority.resolve(chat)).id).toBe("first");
  });

  it.each(["pending", "action_required", "revoked"] as const)(
    "never treats a %s personal account as permission to use a shared account",
    async (status) => {
      const { authority } = fixture(
        [account("personal", { status }), shared()],
        [grant({ kind: "user", id: USER })]
      );
      await expect(authority.resolve(chat)).rejects.toMatchObject({ code: "account_unavailable" });
    }
  );

  it("refuses expired credentials at the exact expiry instant", async () => {
    const { authority } = fixture([account("personal", { expiresAt: NOW.toISOString() })]);
    await expect(authority.resolve(chat)).rejects.toMatchObject({ code: "account_expired" });
  });

  it("requires a choice between multiple personal accounts without a default", async () => {
    const { authority } = fixture([account("first"), account("second")]);
    await expect(authority.resolve(chat)).rejects.toMatchObject({
      code: "account_selection_required",
    });
  });

  it("does not automatically select a shared account when personal credentials are absent", async () => {
    const { authority } = fixture([shared()], [grant({ kind: "user", id: USER })]);
    await expect(authority.resolve(chat)).rejects.toMatchObject({ code: "account_required" });
    await expect(authority.selectChatAccount(chat, "shared", false)).rejects.toMatchObject({
      code: "shared_consent_required",
    });
  });

  it("permits an explicit approved shared choice even while personal credentials work", async () => {
    const { authority } = fixture([account(), shared()], [grant({ kind: "user", id: USER })]);
    const summary = await authority.selectChatAccount(chat, "shared", true);
    expect(summary.id).toBe("shared");
    expect(summary).not.toHaveProperty("secretBindings");
    expect((await authority.resolve(chat)).id).toBe("shared");
    await expect(authority.resolve({ ...chat, conversationId: "another" })).resolves.toMatchObject({
      id: "personal",
    });
  });

  it("requires a grant even for an administrator with explicit shared consent", async () => {
    const { authority, authorization } = fixture([shared()]);
    authorization.canManageShared.mockResolvedValue(true);
    await expect(authority.selectChatAccount(chat, "shared", true)).rejects.toMatchObject({
      code: "account_access_denied",
    });
  });

  it("forbids personal credentials in a shared channel", async () => {
    const { authority } = fixture([account()]);
    await expect(authority.resolve({ ...chat, visibility: "shared" })).rejects.toMatchObject({
      code: "private_context_required",
    });
  });

  it("cannot select or manage another user's personal account, including as an admin", async () => {
    const other = account("other", { owner: { scope: "personal", principalId: "other-user" } });
    const { authority, authorization } = fixture([other]);
    authorization.canManageShared.mockResolvedValue(true);
    await expect(authority.selectChatAccount(chat, "other", false)).rejects.toMatchObject({
      code: "account_access_denied",
    });
    await expect(authority.assertManage(other, USER)).rejects.toMatchObject({
      code: "account_access_denied",
    });
  });

  it("rechecks Team membership on every call after consent", async () => {
    const { authority, authorization } = fixture([shared()], [grant({ kind: "team", id: "team" })]);
    authorization.isTeamMember.mockResolvedValue(true);
    await authority.selectChatAccount(chat, "shared", true);
    await expect(authority.resolve(chat)).resolves.toMatchObject({ id: "shared" });
    authorization.isTeamMember.mockResolvedValue(false);
    await expect(authority.resolve(chat)).rejects.toMatchObject({ code: "account_access_denied" });
  });

  it("stops subsequent calls after grant or principal revocation", async () => {
    const { authority, grants, authorization } = fixture(
      [shared()],
      [grant({ kind: "user", id: USER })]
    );
    await authority.selectChatAccount(chat, "shared", true);
    grants.length = 0;
    await expect(authority.resolve(chat)).rejects.toMatchObject({ code: "account_access_denied" });
    authorization.isActivePrincipal.mockResolvedValue(false);
    await expect(authority.resolve(chat)).rejects.toMatchObject({ code: "principal_inactive" });
  });

  it("does not substitute user grants for a Routine approval", async () => {
    const { authority } = fixture([shared()], [grant({ kind: "user", id: USER })]);
    await expect(authority.resolve(routine())).rejects.toMatchObject({
      code: "routine_approval_required",
    });
  });

  it("binds shared Routine approval to its current material configuration", async () => {
    const { authority } = fixture(
      [shared()],
      [grant({ kind: "routine", id: "daily-review", configurationDigest: DIGEST })]
    );
    await expect(authority.resolve(routine())).resolves.toMatchObject({ id: "shared" });
    await expect(
      authority.resolve(routine({ configurationDigest: OTHER_DIGEST }))
    ).rejects.toMatchObject({
      code: "routine_approval_required",
    });
  });

  it("keeps personal Routine output private and does not transfer the former owner's account", async () => {
    const { authority } = fixture([account()]);
    await expect(authority.resolve(routine({ accountId: "personal" }))).rejects.toMatchObject({
      code: "private_context_required",
    });
    await expect(
      authority.resolve(routine({ accountId: "personal", visibility: "owner" }))
    ).resolves.toMatchObject({
      id: "personal",
    });
    await expect(
      authority.resolve(
        routine({ accountId: "personal", visibility: "owner", ownerPrincipalId: "new-owner" })
      )
    ).rejects.toMatchObject({ code: "account_access_denied" });
  });

  it("invalidates consent after a manual credential revision", async () => {
    const { authority, rows } = fixture([account()]);
    await authority.resolve(chat);
    rows.set("personal", account("personal", { revision: 2 }));
    await expect(authority.resolve(chat)).rejects.toMatchObject({
      code: "account_binding_changed",
    });
  });

  it("refuses changed server definitions and delegated account substitutions", async () => {
    const { authority } = fixture([account(), account("other", { isDefault: true })]);
    await authority.selectChatAccount(chat, "personal", false);
    await expect(
      authority.resolve({ ...chat, definitionDigest: OTHER_DIGEST })
    ).rejects.toMatchObject({
      code: "definition_changed",
    });
    await expect(
      authority.resolve({
        ...chat,
        pinned: { accountId: "other", accountRevision: 1, definitionDigest: DIGEST },
      })
    ).rejects.toMatchObject({ code: "account_binding_changed" });
  });

  it("keeps shared Knowledge sync approvals separate from Routine and Chat grants", async () => {
    const { authority, grants } = fixture([shared()], [grant({ kind: "user", id: USER })]);
    const context: McpAccountUseContext = {
      kind: "knowledge_sync",
      businessId: "business",
      integrationKey: "github",
      definitionDigest: DIGEST,
      syncId: "source-1",
      ownerPrincipalId: USER,
      visibility: "shared",
      accountId: "shared",
      accountRevision: 1,
      configurationDigest: DIGEST,
    };
    await expect(authority.resolve(context)).rejects.toMatchObject({
      code: "knowledge_approval_required",
    });
    grants.push(grant({ kind: "knowledge_sync", id: "source-1", configurationDigest: DIGEST }));
    await expect(authority.resolve(context)).resolves.toMatchObject({ id: "shared" });
  });
});
