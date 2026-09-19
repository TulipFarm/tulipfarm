import type { McpAccountSummary } from "@tulipfarm/schema";
import type { McpAccountConfiguration } from "~/lib/mcp-accounts";
import { getMcpAccountConfiguration, listMcpAccounts } from "~/lib/mcp-accounts";

export interface McpConnectionData {
  accounts: McpAccountSummary[];
  configuration: McpAccountConfiguration | null;
  error: string | null;
}

export async function loadMcpConnectionData(id: string): Promise<McpConnectionData> {
  try {
    const [accounts, configuration] = await Promise.all([
      listMcpAccounts(id),
      getMcpAccountConfiguration(id),
    ]);
    return { accounts, configuration, error: null };
  } catch (error) {
    return {
      accounts: [],
      configuration: null,
      error: error instanceof Error ? error.message : "Account status could not be loaded.",
    };
  }
}

export function mcpConnectionState(data?: McpConnectionData) {
  if (!data || data.error || !data.configuration?.definitionDigest) {
    return {
      action: "Retry" as const,
      description: "Account status unavailable",
      connected: false,
    };
  }
  if (data.configuration.authentication === "none") {
    return { action: "Manage" as const, description: "No sign-in required", connected: false };
  }
  const current = data.accounts.filter(
    (account) =>
      account.status === "active" &&
      account.definitionDigest === data.configuration?.definitionDigest &&
      (!account.expiresAt || Date.parse(account.expiresAt) > Date.now())
  );
  const personal = current.some((account) => account.owner.scope === "personal");
  return {
    action: personal ? ("Manage" as const) : ("Connect" as const),
    description: personal
      ? "Personal account connected"
      : current.some((account) => account.owner.scope === "shared")
        ? "Shared account visible · personal account not connected"
        : "Personal account not connected",
    connected: personal,
  };
}
