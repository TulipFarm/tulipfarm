import type {
  McpCapabilityReview,
  McpConfigure,
  McpIntegrationDefinition,
  McpServerDefinition,
} from "@tulipfarm/schema";
import { apiDelete, apiGet, apiWrite } from "./api";

export interface McpCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly url: string;
  readonly publisherEvidence: string;
  readonly authentication: readonly ("oauth" | "token")[];
  readonly setup: readonly string[];
  readonly limitations: readonly string[];
  readonly knowledgeSync: "excluded" | "requires-reviewed-adapter";
  readonly localPreset?: McpServerDefinition;
}

export type McpRequestContext =
  | { chatId: string; accountId?: never }
  | { accountId: string; chatId?: never };

export const mcpPath = (id: string) => `/api/v1/integrations/${encodeURIComponent(id)}`;

export async function listMcpCatalog(): Promise<McpCatalogEntry[]> {
  return (await apiGet<{ entries: McpCatalogEntry[] }>("/api/v1/integrations/catalog")).entries;
}

export async function listMcpIntegrations(): Promise<McpIntegrationDefinition[]> {
  return (await apiGet<{ servers: McpIntegrationDefinition[] }>("/api/v1/integrations")).servers;
}

export async function getMcpIntegration(id: string): Promise<McpIntegrationDefinition> {
  return (await apiGet<{ server: McpIntegrationDefinition }>(mcpPath(id))).server;
}

export async function configureMcpIntegration(
  id: string,
  input: McpConfigure
): Promise<McpIntegrationDefinition> {
  return (await apiWrite<{ server: McpIntegrationDefinition }>("PUT", mcpPath(id), input)).server;
}

export function removeMcpIntegration(id: string): Promise<void> {
  return apiDelete(mcpPath(id));
}

export async function discoverMcpCapabilities(
  id: string,
  context?: McpRequestContext
): Promise<McpCapabilityReview> {
  return (
    await apiWrite<{ capabilities: McpCapabilityReview }>(
      "POST",
      `${mcpPath(id)}/discover`,
      context ?? {}
    )
  ).capabilities;
}

export async function reviewMcpCapabilities(
  id: string,
  input: McpCapabilityReview,
  context?: McpRequestContext
): Promise<McpIntegrationDefinition> {
  return (
    await apiWrite<{ server: McpIntegrationDefinition }>(
      "PUT",
      `${mcpPath(id)}/capabilities${context?.chatId ? `?chatId=${encodeURIComponent(context.chatId)}` : context?.accountId ? `?accountId=${encodeURIComponent(context.accountId)}` : ""}`,
      input
    )
  ).server;
}

export function readMcpResource(
  id: string,
  uri: string,
  context?: McpRequestContext
): Promise<{ contents: Record<string, unknown>[] }> {
  return apiWrite("POST", `${mcpPath(id)}/resources/read`, { uri, ...(context ?? {}) });
}

export function renderMcpPrompt(
  id: string,
  name: string,
  args: Record<string, string>,
  context?: McpRequestContext
): Promise<{
  description?: string;
  messages: { role: "user" | "assistant"; content: Record<string, unknown> }[];
}> {
  return apiWrite("POST", `${mcpPath(id)}/prompts/render`, {
    name,
    arguments: args,
    ...(context ?? {}),
  });
}
