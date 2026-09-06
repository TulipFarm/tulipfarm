import { apiDelete, apiGet, apiWrite } from "./api";

/* Catalog rows include shipped, installed, and curated-not-yet-installed integrations. */

export type McpConnectionStatus = "connected" | "connecting" | "error" | "disconnected";

/** Whether the curated registry has opened this entry for connection yet. */
export type IntegrationAvailability = "available" | "coming_soon";

export type IntegrationSummary = {
  name: string;
  /** Brand name from the curated registry; falls back to the slug when uncurated. */
  title?: string;
  /** `coming_soon` is listed but not openable — there is no setup to hand an operator yet. */
  availability?: IntegrationAvailability;
  type: string;
  description?: string;
  category?: string;
  homepage?: string;
  /** Manifest icon slug, resolved server-side. Keys the vendored full-colour brand marks. */
  iconSlug?: string;
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
  /** How many setup steps connecting takes. Absent when nothing is installed to count. */
  setupSteps?: number;
  status: McpConnectionStatus;
  errorMessage?: string;
  updateAvailable?: boolean;
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

export type IntegrationKnowledgeSetup = {
  mode: "user_configured";
  automatic_indexing: false;
  source_tools: string[];
  write_tools: string[];
};

export type IntegrationDetail = IntegrationSummary & {
  /** Authored summary of what agents can do once connected. Not enforced — see `grants`. */
  capabilities?: string[];
  /** The authority connecting hands over. Derived from declared OAuth scopes where possible. */
  grants: IntegrationGrant[];
  /** Explicit setup contract for user-authored Knowledge ingestion. */
  knowledge?: IntegrationKnowledgeSetup;
  manifest: {
    required_env?: RequiredEnvVar[];
    egress?: { type?: string; entry?: Record<string, unknown> };
    setup_guide_path?: string;
    oauth?: OAuthConfig;
    install_manifest?: string;
  };
  /** The manifest's declared auth flow, resolved and ordered. Drives the whole connect UI. */
  auth: AuthStepSummary[];
  /**
   * Present only for an Open Integration Manifest package.
   *
   * Its credential is a Connection row, not sealed env, so its setup lives on its own screen —
   * `auth` here describes that form rather than a flow this page can run.
   */
  oim?: {
    integrationId: string;
    majorVersion: number;
    operationCount: number;
    unsupportedStepTypes: string[];
    /** True when saving the form is only half the flow; the person must then consent at the provider. */
    requiresAuthorization: boolean;
    connectSupported: boolean;
    healthCheckOperationId?: string;
  };
  connected: boolean;
  /** Whether the signed-in user has a live personal credential for this provider. */
  personalConnected?: boolean;
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
  /** `satisfied` can mean the step writes nothing, not that proof already happened. */
  producesEnv: boolean;
  /** Present only for `fields` steps. */
  fields?: RequiredEnvVar[];
  /** Whether an `app_manifest` step can create the app under a caller-named org. */
  supportsOrgTarget?: boolean;
  /** Personal steps issue a credential for the signed-in user, never the business. */
  personal?: boolean;
};

/** UI switches on broker `action`, not provider name, to avoid per-provider branches. */
export type AuthStartAction =
  | { action: "collect_fields"; fields: RequiredEnvVar[] }
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  /** The server already did the work — there is no handoff, only a refresh. */
  | { action: "completed" };

export async function startAuthStep(
  name: string,
  step: number,
  options: { org?: string; scope?: "business" | "user" } = {}
): Promise<AuthStartAction> {
  return apiWrite<AuthStartAction>(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/auth/start/${step}`,
    {
      ...(options.org ? { org: options.org } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    }
  );
}

export async function disconnectPersonalIntegration(name: string): Promise<void> {
  await apiWrite("POST", `/api/v1/integrations/${encodeURIComponent(name)}/auth/revoke`, {});
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

export async function updateIntegration(
  name: string,
  source?: string
): Promise<{ name: string; source: string; ref: string }> {
  return apiWrite<{ name: string; source: string; ref: string }>(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/update`,
    source ? { source } : {}
  );
}

export async function deleteIntegration(name: string): Promise<void> {
  return apiDelete(`/api/v1/integrations/${encodeURIComponent(name)}`);
}

/* An OIM package's Connections: a credential row in the runtime, not sealed env in the soul. */

export type OimConnectField = {
  id: string;
  label: string;
  description?: string;
  input: "text" | "password" | "url";
  required: boolean;
  /** Written to a Secret and never read back, so the form must not try to pre-fill it. */
  secret: boolean;
};

export type OimConnectStep = {
  id: string;
  title: string;
  description?: string;
  fields: OimConnectField[];
};

export type OimConnectForm = {
  integrationId: string;
  majorVersion: number;
  steps: OimConnectStep[];
  /** Sign-in step types this deployment cannot run yet; the form alone would look complete. */
  unsupportedStepTypes: string[];
  /** True when saving the form is only half the flow; the person must then consent at the provider. */
  requiresAuthorization: boolean;
};

export type OimConnectionSummary = {
  id: string;
  label: string;
  scope: "organization" | "personal" | "team";
  teamId?: string;
  status: "active" | "revoked";
  isDefault: boolean;
  health: string;
  expiresAt: string | null;
  /** Only the fields the package marked agent-visible. */
  configuration: Record<string, string | number | boolean>;
};

export async function getOimConnections(
  name: string
): Promise<{ form: OimConnectForm; connections: OimConnectionSummary[] }> {
  return apiGet(`/api/v1/integrations/${encodeURIComponent(name)}/connections`);
}

export async function createOimConnection(
  name: string,
  body: {
    label: string;
    scope: "personal" | "organization" | "team";
    teamId?: string;
    values: Record<string, string>;
  }
): Promise<{ connectionId: string; scope: string; teamId?: string }> {
  return apiWrite("POST", `/api/v1/integrations/${encodeURIComponent(name)}/connections`, body);
}

export async function revokeOimConnection(name: string, id: string): Promise<void> {
  return apiDelete(
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(id)}`
  );
}

/** Calls the operation the package nominated as its health check and returns the recorded result. */
export async function testOimConnection(
  name: string,
  id: string
): Promise<{ status: string; checkedAt: string }> {
  return apiWrite(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(id)}/test`,
    {}
  );
}

/** Starts the provider consent flow and returns where the browser must go next. */
export async function authorizeOimConnection(name: string, id: string): Promise<{ url: string }> {
  return apiWrite(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(id)}/authorize`,
    {}
  );
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

export async function disconnectGitHubInstallation(
  installationId: string
): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/integrations/github/installations/${encodeURIComponent(installationId)}/disconnect`,
    {}
  );
}
