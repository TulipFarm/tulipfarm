import { apiDelete, apiGet, apiWrite } from "./api";

/*
 * Client for the integrations API (INT-V1 / MCP-V1-001). V1 supports type=mcp only.
 * Lifecycle: scan a git repo → install → connect (write env + start MCP server) → disconnect → delete.
 */

export type McpConnectionStatus = "connected" | "connecting" | "error" | "disconnected";

export type IntegrationSummary = {
  name: string;
  type: string;
  description?: string;
  version?: string;
  maintainer?: string;
  status: McpConnectionStatus;
  errorMessage?: string;
};

export type RequiredEnvVar = {
  name: string;
  label: string;
  description?: string;
  secret?: boolean;
};

export type IntegrationDetail = IntegrationSummary & {
  manifest: {
    required_env?: RequiredEnvVar[];
    entry: Record<string, unknown>;
  };
  connected: boolean;
};

export type ScannedIntegration = {
  name: string;
  type: string;
  description?: string;
  installed: boolean;
  updateAvailable: boolean;
};

export type ScanResult = { scanId: string; integrations: ScannedIntegration[] };

export type MarketplaceIntegration = {
  name: string;
  description?: string;
  verified?: boolean;
  installed: boolean;
  updateAvailable: boolean;
};

export type MarketplaceCatalog = {
  scanId: string;
  source: string;
  integrations: MarketplaceIntegration[];
};

export type IntegrationInstallStatus = { installed: boolean; updateAvailable: boolean };

export async function listIntegrations(): Promise<IntegrationSummary[]> {
  const body = await apiGet<{ integrations: IntegrationSummary[] }>("/api/v1/integrations");
  return body.integrations;
}

export async function getIntegration(name: string): Promise<IntegrationDetail> {
  return apiGet<IntegrationDetail>(`/api/v1/integrations/${encodeURIComponent(name)}`);
}

export async function scanIntegrations(source: string): Promise<ScanResult> {
  return apiWrite<ScanResult>("POST", "/api/v1/integrations/scan", { source });
}

export async function installIntegrations(
  scanId: string,
  names: string[]
): Promise<{ installed: string[] }> {
  return apiWrite<{ installed: string[] }>("POST", "/api/v1/integrations/install", {
    scanId,
    names,
  });
}

export async function connectIntegration(
  name: string,
  env: Record<string, string>
): Promise<{ status: McpConnectionStatus; toolCount: number }> {
  return apiWrite<{ status: McpConnectionStatus; toolCount: number }>(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/connect`,
    { env }
  );
}

export async function disconnectIntegration(name: string): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/disconnect`,
    {}
  );
}

export async function deleteIntegration(name: string): Promise<void> {
  return apiDelete(`/api/v1/integrations/${encodeURIComponent(name)}`);
}

export async function marketplaceIntegrations(): Promise<MarketplaceCatalog> {
  return apiGet<MarketplaceCatalog>("/api/v1/integrations/marketplace");
}
