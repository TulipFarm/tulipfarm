import { accountDefinitionForIntegration, McpAccountAuthority } from "@tulipfarm/integrations";
import { McpAccountStore } from "@tulipfarm/storage";
import type { L3McpFixture } from "../case.ts";
import type { EvalSoul } from "../eval-soul.ts";
import type { EvalDatabase } from "./database.ts";
import { EVAL_MCP_SERVER } from "./mcp-provider.ts";

export async function evalMcpAccounts(
  database: EvalDatabase,
  soul: EvalSoul,
  conversationId: string | undefined,
  fixture?: L3McpFixture
) {
  const accounts = new McpAccountStore(database.queryable, database.transactions);
  const authority = new McpAccountAuthority(accounts, {
    isActivePrincipal: async (businessId, principalId) => {
      const result = await database.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active'",
        [principalId]
      );
      return businessId === "eval" && result.rows.length === 1;
    },
    isTeamMember: async () => false,
    canManageShared: async (businessId, principalId) => {
      const result = await database.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active' AND role = 'admin'",
        [principalId]
      );
      return businessId === "eval" && result.rows.length === 1;
    },
  });
  if (fixture === undefined) return { accounts, authority };
  const definition = soul.loader.integrations.get(EVAL_MCP_SERVER)?.mcp;
  if (definition === undefined) throw new Error("The Eval Soul has no MCP provider definition.");
  const accountDefinition = accountDefinitionForIntegration(definition);
  if (accountDefinition.authentication !== "none") {
    throw new Error("The Eval MCP provider must explicitly use unauthenticated transport.");
  }
  const { definitionDigest } = accountDefinition;
  const at = "2026-01-01T00:00:00.000Z";
  for (const account of fixture.accounts) {
    const saved = await accounts.save({
      id: account.id,
      businessId: "eval",
      integrationKey: EVAL_MCP_SERVER,
      definitionDigest,
      label: account.id,
      owner:
        account.scope === "personal"
          ? { scope: "personal", principalId: "eval" }
          : { scope: "shared" },
      status: account.status,
      authentication: accountDefinition.authentication,
      isDefault: account.isDefault ?? false,
      revision: 1,
      secretBindings: {},
      expiresAt: account.expiresAt ?? null,
      createdAt: at,
      updatedAt: at,
    });
    if (!saved) throw new Error(`Could not seed MCP account ${account.id}.`);
  }
  for (const accountId of fixture.sharedGrants ?? []) {
    const saved = await accounts.saveGrant({
      businessId: "eval",
      accountId,
      accountRevision: 1,
      subject: { kind: "user", id: "eval" },
      grantedBy: "eval",
      grantedAt: at,
    });
    if (!saved) throw new Error(`Could not seed MCP shared grant ${accountId}.`);
  }
  if (fixture.selection !== undefined) {
    if (conversationId === undefined) {
      throw new Error("MCP Chat account selection requires a real Conversation.");
    }
    const saved = await accounts.saveSelection({
      businessId: "eval",
      conversationId,
      principalId: "eval",
      integrationKey: EVAL_MCP_SERVER,
      accountId: fixture.selection.accountId,
      accountRevision: 1,
      definitionDigest,
      sharedConsent: fixture.selection.sharedConsent,
      selectedAt: at,
    });
    if (!saved) throw new Error("Could not seed the persisted MCP account selection.");
  }
  return { accounts, authority };
}
