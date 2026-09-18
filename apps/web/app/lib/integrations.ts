import { apiGet, apiWrite } from "./api";
import { listMcpAccounts } from "./mcp-accounts";
import { listMcpIntegrations } from "./mcp-integrations";

export type McpConnectionStatus = "connected" | "connecting" | "error" | "disconnected";

export type IntegrationSummary = {
  name: string;
  title?: string;
  type: string;
  description?: string;
  category?: string;
  homepage?: string;
  iconSlug?: string;
  iconPath?: string;
  iconColor?: string;
  installed: boolean;
  status: McpConnectionStatus;
  errorMessage?: string;
};

export type RequiredEnvVar = {
  name: string;
  label: string;
  description?: string;
  secret?: boolean;
  setup_url?: string;
  steps?: string[];
};

export type IntegrationGrant = {
  label: string;
  access?: string;
  description?: string;
};

export type IntegrationDetail = IntegrationSummary & {
  capabilities?: string[];
  grants: IntegrationGrant[];
  manifest: {
    required_env?: RequiredEnvVar[];
    install_manifest?: string;
  };
  auth: AuthStepSummary[];
  connected: boolean;
  setupGuide?: string;
  ingress?: { enabled: boolean; webhookUrl: string | null };
};

export type AuthStepKind = "fields" | "app_manifest" | "oauth2" | "install" | "webhook";
export type AuthStepSummary = {
  index: number;
  kind: AuthStepKind;
  title?: string;
  description?: string;
  satisfied: boolean;
  producesEnv: boolean;
  fields?: RequiredEnvVar[];
  supportsOrgTarget?: boolean;
  personal?: boolean;
};

export type AuthStartAction =
  | { action: "collect_fields"; fields: RequiredEnvVar[] }
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  | { action: "completed" };

export function startAuthStep(
  name: string,
  step: number,
  options: { org?: string; scope?: "business" | "user" } = {}
): Promise<AuthStartAction> {
  return apiWrite(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/auth/start/${step}`,
    options
  );
}

export async function listIntegrations(): Promise<IntegrationSummary[]> {
  const servers = await listMcpIntegrations();
  return Promise.all(
    servers.map(async ({ server, enabled }) => {
      const accounts = await listMcpAccounts(server.id);
      const connected =
        enabled &&
        accounts.some(
          (account) =>
            account.status === "active" &&
            (!account.expiresAt || Date.parse(account.expiresAt) > Date.now())
        );
      return {
        name: server.id,
        title: server.label,
        type: "mcp",
        installed: true,
        status: connected ? ("connected" as const) : ("disconnected" as const),
      };
    })
  );
}

export async function getIntegration(name: string): Promise<IntegrationDetail> {
  const channel = await apiGet<
    Pick<IntegrationDetail, "name" | "connected" | "auth" | "manifest" | "setupGuide">
  >(`/api/v1/integrations/native/${encodeURIComponent(name)}`);
  return {
    ...channel,
    title: name === "github" ? "GitHub" : "Slack",
    type: "native",
    installed: true,
    status: channel.connected ? "connected" : "disconnected",
    iconSlug: name,
    grants: [],
  };
}

export function connectIntegration(
  name: string,
  env: Record<string, string>
): Promise<{ status: "connected" | "pending"; toolCount: 0 }> {
  return apiWrite("POST", `/api/v1/integrations/${encodeURIComponent(name)}/connect`, { env });
}

export function disconnectIntegration(name: string): Promise<{ status: string }> {
  return apiWrite("POST", `/api/v1/integrations/${encodeURIComponent(name)}/disconnect`, {});
}

export type SlackRoute = {
  id: string;
  agentId: string;
  channelId: string | null;
  priority: number;
};

export async function listSlackRoutes(): Promise<SlackRoute[]> {
  const body = await apiGet<{ routes: SlackRoute[] }>("/api/v1/integrations/slack/routes");
  return body.routes;
}

export type GitHubInstallation = {
  installationId: string;
  account: string;
  repositories: string[];
};

export async function getGitHubStatus(): Promise<GitHubInstallation[]> {
  const body = await apiGet<{ installations: GitHubInstallation[] }>(
    "/api/v1/integrations/github/status"
  );
  return body.installations;
}

export function disconnectGitHubInstallation(installationId: string): Promise<{ status: string }> {
  return apiWrite(
    "POST",
    `/api/v1/integrations/github/installations/${encodeURIComponent(installationId)}/disconnect`,
    {}
  );
}
