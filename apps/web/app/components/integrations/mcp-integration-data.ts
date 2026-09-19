import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import {
  getMcpAccountConfiguration,
  listMcpAccounts,
  type McpAccountConfiguration,
} from "~/lib/mcp-accounts";
import { getMcpIntegration } from "~/lib/mcp-integrations";
import { getMcpSetupEligibility, type McpSetupEligibility } from "~/lib/mcp-setup";
import { mcpError } from "./mcp-form";

export interface McpIntegrationData {
  definition: McpIntegrationDefinition;
  accounts: { items: McpAccountSummary[]; error: string | null };
  configuration: { value: McpAccountConfiguration | null; error: string | null };
  eligibility: { value: McpSetupEligibility | null; error: string | null };
}

/** Observes the revision before credential fields so later definition changes reject submission. */
export async function loadMcpIntegrationData(serverId: string): Promise<McpIntegrationData> {
  const eligibility = await getMcpSetupEligibility(serverId)
    .then((value) => ({ value, error: null }))
    .catch((error: unknown) => ({ value: null, error: mcpError(error) }));
  const [definition, accounts, configuration] = await Promise.all([
    getMcpIntegration(serverId),
    listMcpAccounts(serverId)
      .then((items) => ({ items, error: null }))
      .catch((error: unknown) => ({ items: [], error: mcpError(error) })),
    getMcpAccountConfiguration(serverId)
      .then((value) => ({ value, error: null }))
      .catch((error: unknown) => ({ value: null, error: mcpError(error) })),
  ]);
  return { definition, accounts, configuration, eligibility };
}
