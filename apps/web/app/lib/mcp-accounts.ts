import type {
  McpAccountCreate,
  McpAccountGrant,
  McpAccountSelectionRequest,
  McpAccountSummary,
  McpOAuthConfiguration,
} from "@tulipfarm/schema";
import { apiDelete, apiGet, apiWrite } from "./api";
import { mcpPath } from "./mcp-integrations";

export const mcpAccountsPath = (key: string) => `${mcpPath(key)}/accounts`;
export const mcpAccountPath = (key: string, id: string) =>
  `${mcpAccountsPath(key)}/${encodeURIComponent(id)}`;

export type McpAccountConfiguration = {
  authentication: McpAccountCreate["authentication"];
  requiredSlots: string[];
  sharedAllowed: boolean;
};

export function getMcpAccountConfiguration(key: string): Promise<McpAccountConfiguration> {
  return apiGet(`${mcpAccountsPath(key)}/configuration`);
}

export function listMcpAccounts(key: string): Promise<McpAccountSummary[]> {
  return apiGet(mcpAccountsPath(key));
}

export function getMcpChatAccount(chatId: string, key: string): Promise<McpAccountSummary> {
  return apiGet(
    `/api/v1/chats/${encodeURIComponent(chatId)}/integrations/${encodeURIComponent(key)}/account`
  );
}

export type McpAccountGrantSummary = McpAccountGrant & { status: "active" | "stale" };

export function listMcpAccountGrants(key: string, id: string): Promise<McpAccountGrantSummary[]> {
  return apiGet(`${mcpAccountPath(key, id)}/grants`);
}

export function grantMcpAccount(
  key: string,
  id: string,
  subject: { kind: McpAccountGrant["subject"]["kind"]; id: string }
): Promise<McpAccountGrant> {
  return apiWrite("POST", `${mcpAccountPath(key, id)}/grants`, subject);
}

export function revokeMcpAccountGrant(
  key: string,
  id: string,
  subject: McpAccountGrant["subject"]
): Promise<void> {
  return apiDelete(
    `${mcpAccountPath(key, id)}/grants/${subject.kind}/${encodeURIComponent(subject.id)}`
  );
}

export function createMcpAccount(key: string, input: McpAccountCreate): Promise<McpAccountSummary> {
  return apiWrite("POST", mcpAccountsPath(key), input);
}

export function updateMcpAccount(
  key: string,
  id: string,
  input: { label?: string; isDefault?: boolean; values?: Record<string, string> }
): Promise<McpAccountSummary> {
  return apiWrite("PATCH", mcpAccountPath(key, id), input);
}

export function revokeMcpAccount(key: string, id: string): Promise<void> {
  return apiDelete(mcpAccountPath(key, id));
}

export function getMcpAccountOAuthConfiguration(
  key: string,
  id: string
): Promise<McpOAuthConfiguration> {
  return apiGet(`${mcpAccountPath(key, id)}/oauth/configuration`);
}

export async function startMcpAccountOAuth(key: string, id: string): Promise<void> {
  const result = await apiWrite<{ authorizationUrl: string }>(
    "POST",
    `${mcpAccountPath(key, id)}/oauth/start`,
    {}
  );
  const url = new URL(result.authorizationUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("The server returned an unsupported sign-in URL.");
  }
  window.location.assign(url.toString());
}

export async function selectMcpChatAccount(
  chatId: string,
  key: string,
  input: McpAccountSelectionRequest
): Promise<void> {
  await apiWrite(
    "PUT",
    `/api/v1/chats/${encodeURIComponent(chatId)}/integrations/${encodeURIComponent(key)}/account`,
    input
  );
}
