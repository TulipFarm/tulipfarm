import type {
  McpAccountCreate,
  McpSetupCredentials,
  McpSetupEligibility,
  McpSetupStart,
  McpSetupStatus,
} from "@tulipfarm/schema";
import { apiGet, apiWrite } from "./api";

export type {
  McpSetupCredentials as McpSetupResume,
  McpSetupEligibility,
  McpSetupStart,
  McpSetupStatus as McpSetupOperation,
};

const setupPath = (id: string) => `/api/v1/integration-setups/${encodeURIComponent(id)}`;

export function getMcpSetupEligibility(integrationKey: string): Promise<McpSetupEligibility> {
  return apiGet(`/api/v1/integrations/${encodeURIComponent(integrationKey)}/setup`);
}

export function startMcpSetup(id: string, input: McpSetupStart): Promise<McpSetupStatus> {
  return apiWrite("POST", setupPath(id), input);
}

export function getMcpSetup(id: string): Promise<McpSetupStatus> {
  return apiGet(setupPath(id));
}

export function resumeMcpSetup(
  id: string,
  input: McpSetupCredentials = {}
): Promise<McpSetupStatus> {
  return apiWrite("POST", `${setupPath(id)}/resume`, input);
}

export async function listMcpSetups(
  integrationKey: string,
  accountId: string
): Promise<McpSetupStatus[]> {
  const query = new URLSearchParams({ integrationKey, accountId });
  return (await apiGet<{ operations: McpSetupStatus[] }>(`/api/v1/integration-setups?${query}`))
    .operations;
}

export function setupAccountInput(
  input: McpAccountCreate
): Pick<McpSetupStart, "account" | "values" | "clientSecret" | "confirmShared"> {
  return {
    account: {
      label: input.label,
      scope: input.scope,
      authentication: input.authentication,
      ...(input.oauthClient
        ? {
            oauthClient: {
              clientId: input.oauthClient.clientId,
              tokenEndpointAuthMethod: input.oauthClient.tokenEndpointAuthMethod,
            },
          }
        : {}),
    },
    ...(input.values ? { values: input.values } : {}),
    ...(input.oauthClient?.clientSecret ? { clientSecret: input.oauthClient.clientSecret } : {}),
    ...(input.scope === "shared" ? { confirmShared: true } : {}),
  };
}
