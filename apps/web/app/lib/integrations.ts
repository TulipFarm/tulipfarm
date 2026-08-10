import { apiDelete, apiGet, apiWrite } from "./api";

/*
 * Client for the integrations API.
 *
 * `listIntegrations` is the whole catalog — what this deployment ships, what has been cloned into
 * the soul repo, and the curated entries that are neither yet. Installing is a separate step only
 * for the last group: inspect a git repo, then install from it.
 */

export type McpConnectionStatus = "connected" | "connecting" | "error" | "disconnected";

export type IntegrationSummary = {
  name: string;
  /** Brand name from the curated registry; falls back to the slug when uncurated. */
  title?: string;
  type: string;
  description?: string;
  category?: string;
  homepage?: string;
  /** Simple Icons path data, resolved server-side. Absent when the brand has no mark. */
  iconPath?: string;
  /** Brand hex without `#`. Not canvas-safe as given — pass through `brandInk` before rendering. */
  iconColor?: string;
  version?: string;
  maintainer?: string;
  /** Git source of a curated third-party entry; absent when it ships in the image. */
  source?: string;
  /** False for a curated entry that has not been cloned into the soul repo yet. */
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

export type OAuthConfig = {
  authorization_url: string;
  token_url: string;
  scopes: string[];
  client_id_env: string;
  client_secret_env: string;
  token_env: string;
  token_response_path?: string;
};

export type IntegrationGrant = {
  /** What is reached, in the provider's own words: `issues`, `chat:write`. */
  label: string;
  /** Level of access, where the provider separates it from the label. */
  access?: string;
  description?: string;
};

export type IntegrationDetail = IntegrationSummary & {
  /** Authored summary of what agents can do once connected. Not enforced — see `grants`. */
  capabilities?: string[];
  /** The authority connecting hands over. Derived from declared OAuth scopes where possible. */
  grants: IntegrationGrant[];
  manifest: {
    required_env?: RequiredEnvVar[];
    egress?: { type?: string; entry?: Record<string, unknown> };
    setup_guide_path?: string;
    oauth?: OAuthConfig;
    install_manifest?: string;
  };
  /** The manifest's declared auth flow, resolved and ordered. Drives the whole connect UI. */
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
  /** Whether the connection env this step produces is already stored. */
  satisfied: boolean;
  /**
   * Whether finishing this step writes any connection env. A step that writes nothing — Slack's
   * "create the app" — is `satisfied` before it is ever started, so a setup walkthrough must use
   * this to tell "nothing left to prove" apart from "nothing to prove in the first place".
   */
  producesEnv: boolean;
  /** Present only for `fields` steps. */
  fields?: RequiredEnvVar[];
};

/**
 * What the browser must do to advance one step, as decided by the API's auth broker. The UI
 * switches on `action` and never on the integration, which is what keeps the connect flow free of
 * per-provider branches.
 */
export type AuthStartAction =
  | { action: "collect_fields"; fields: RequiredEnvVar[] }
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  /** The server already did the work — there is no handoff, only a refresh. */
  | { action: "completed" };

export async function startAuthStep(name: string, step: number): Promise<AuthStartAction> {
  return apiWrite<AuthStartAction>(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/auth/start/${step}`,
    {}
  );
}

/** One integration offered by a git repo, as reported by inspect. */
export type InspectedIntegration = {
  name: string;
  description?: string;
  version?: string;
  maintainer?: string;
  installed: boolean;
  /** False when the manifest declares something a third-party integration may not. */
  installable: boolean;
  issues: string[];
};

export type InspectResult = {
  source: string;
  ref: string;
  integrations: InspectedIntegration[];
};

export async function listIntegrations(): Promise<IntegrationSummary[]> {
  const body = await apiGet<{ integrations: IntegrationSummary[] }>("/api/v1/integrations");
  return body.integrations;
}

export async function getIntegration(name: string): Promise<IntegrationDetail> {
  return apiGet<IntegrationDetail>(`/api/v1/integrations/${encodeURIComponent(name)}`);
}

/** Clone a git repo and report what it offers, without installing anything. */
export async function inspectIntegrationSource(source: string): Promise<InspectResult> {
  return apiWrite<InspectResult>("POST", "/api/v1/integrations/inspect", { source });
}

export async function installIntegration(
  source: string,
  name?: string
): Promise<{ name: string; source: string; ref: string }> {
  return apiWrite<{ name: string; source: string; ref: string }>(
    "POST",
    "/api/v1/integrations/install",
    name ? { source, name } : { source }
  );
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

export type SlackRoute = {
  id: string;
  agentId: string;
  channelId: string | null;
  priority: number;
};

export async function bindSlackAgent(
  agentId: string,
  channelId?: string
): Promise<{
  status: string;
  teamId: string;
  appId: string;
  routeId: string;
  channelId: string | null;
}> {
  return apiWrite(
    "POST",
    "/api/v1/integrations/slack/bind",
    channelId === undefined ? { agentId } : { agentId, channelId }
  );
}

export async function listSlackRoutes(): Promise<SlackRoute[]> {
  const body = await apiGet<{ routes: SlackRoute[] }>("/api/v1/integrations/slack/routes");
  return body.routes;
}

export async function unbindSlackRoute(routeId: string): Promise<void> {
  await apiDelete(`/api/v1/integrations/slack/routes/${encodeURIComponent(routeId)}`);
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

export async function disconnectGitHubInstallation(
  installationId: string
): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/integrations/github/installations/${encodeURIComponent(installationId)}/disconnect`,
    {}
  );
}
