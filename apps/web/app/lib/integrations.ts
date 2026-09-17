import type { OimConnection } from "@tulipfarm/schema";
import { apiDelete, apiGet, apiWrite } from "./api";
import type { ConnectionPresentation } from "./integration-status";

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
  connectionState?: ConnectionPresentation;
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

export interface OimReleaseCandidateReview {
  readonly name: string;
  readonly description: string;
  readonly auth: {
    readonly credentialLabels: readonly string[];
    readonly configurationLabels: readonly string[];
    readonly steps: readonly { readonly title: string; readonly type: string }[];
  };
  readonly operations: readonly {
    readonly name: string;
    readonly description: string;
    readonly effect: string;
    readonly destination: string;
  }[];
  readonly ingress: {
    readonly events: boolean;
    readonly polling: boolean;
    readonly knowledge: boolean;
  };
}

export interface OimReleaseInspection {
  readonly source: string;
  readonly ref: string;
  readonly candidates: readonly {
    readonly sourcePath: string;
    readonly integrationId: string;
    readonly version: string;
    readonly packageDigest: string;
    readonly issues: readonly string[];
    readonly review?: OimReleaseCandidateReview;
  }[];
}

export interface InstallOimReleaseInput {
  readonly source: string;
  readonly sourceRef: string;
  readonly slug: string;
  readonly selection: {
    readonly integrationId: string;
    readonly version: string;
    readonly packageDigest: string;
  };
  readonly trustClass: "official" | "community";
  readonly approvedCommunityDigest?: string;
  readonly autoPatchOptIn: boolean;
}

export interface InstallOimReleaseResult extends OimReleaseGeneration {
  readonly version: string;
  readonly packageDigest: string;
  readonly trustClass: "official" | "community";
  readonly revision: string;
}

export function inspectOimReleaseSource(source: string): Promise<OimReleaseInspection> {
  return apiWrite("POST", "/api/v1/integrations/oim/releases/inspect", { source });
}

export function installOimRelease(input: InstallOimReleaseInput): Promise<InstallOimReleaseResult> {
  return apiWrite("POST", "/api/v1/integrations/oim/releases/install", input);
}

export interface OimReleaseGeneration {
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly installationId: string;
}

export interface InstalledOimReleaseGeneration extends OimReleaseGeneration {
  readonly slug: string;
  readonly trustClass?: "official" | "community";
  readonly autoPatchOptIn?: boolean;
}

export interface OimReleaseUninstallStatus {
  readonly scope: OimReleaseGeneration;
  readonly status: "not_started" | "pending" | "complete";
  readonly activationAllowed: boolean;
  readonly retryRequired: boolean;
}

function oimReleasePath(generation: OimReleaseGeneration): string {
  return `/api/v1/integrations/oim/${encodeURIComponent(
    generation.integrationId
  )}/majors/${generation.majorVersion}/installations/${encodeURIComponent(
    generation.installationId
  )}`;
}

export function getInstalledOimRelease(
  integrationId: string,
  majorVersion: number
): Promise<InstalledOimReleaseGeneration | null> {
  return apiGet(
    `/api/v1/integrations/oim/${encodeURIComponent(
      integrationId
    )}/majors/${majorVersion}/auto-patch`
  );
}

export function getOimReleaseUninstallStatus(
  generation: OimReleaseGeneration
): Promise<OimReleaseUninstallStatus> {
  return apiGet(`${oimReleasePath(generation)}/uninstall`);
}

export function uninstallOimRelease(
  generation: OimReleaseGeneration
): Promise<{ readonly status: "complete" }> {
  return apiWrite("DELETE", oimReleasePath(generation), {});
}

export interface OimTrustRoot {
  readonly purpose: "release" | "revocation";
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
  readonly disabledBy?: string;
}

export interface OimRevocationFeed {
  readonly url: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly disabledAt?: string;
  readonly disabledBy?: string;
}

export interface OimReleaseMaintenanceResult {
  readonly feed: "disabled" | "unchanged" | "updated";
  readonly patches: readonly {
    readonly integrationId: string;
    readonly majorVersion: number;
    readonly status: "failed" | "skipped" | "updated";
    readonly version?: string;
    readonly reason?: string;
  }[];
}

export function listOimTrustRoots(includeDisabled = true): Promise<readonly OimTrustRoot[]> {
  return apiGet(
    `/api/v1/integrations/oim/release-trust/roots?includeDisabled=${includeDisabled ? "true" : "false"}`
  );
}

export function addOimTrustRoot(input: {
  purpose: OimTrustRoot["purpose"];
  keyId: string;
  publicKeyPem: string;
}): Promise<OimTrustRoot> {
  return apiWrite("POST", "/api/v1/integrations/oim/release-trust/roots", input);
}

export function disableOimTrustRoot(
  purpose: OimTrustRoot["purpose"],
  keyId: string
): Promise<OimTrustRoot | null> {
  return apiWrite(
    "DELETE",
    `/api/v1/integrations/oim/release-trust/roots/${purpose}/${encodeURIComponent(keyId)}`,
    {}
  );
}

export function getOimRevocationFeed(): Promise<OimRevocationFeed | null> {
  return apiGet("/api/v1/integrations/oim/release-trust/feed");
}

export function setOimRevocationFeed(url: string): Promise<OimRevocationFeed> {
  return apiWrite("PUT", "/api/v1/integrations/oim/release-trust/feed", { url });
}

export function disableOimRevocationFeed(): Promise<boolean> {
  return apiWrite("DELETE", "/api/v1/integrations/oim/release-trust/feed", {});
}

export function runOimReleaseMaintenance(): Promise<OimReleaseMaintenanceResult> {
  return apiWrite("POST", "/api/v1/integrations/oim/release-trust/maintenance", {});
}

export function setOimAutoPatchPreference(
  integrationId: string,
  majorVersion: number,
  enabled: boolean
): Promise<InstalledOimReleaseGeneration> {
  return apiWrite(
    "PATCH",
    `/api/v1/integrations/oim/${encodeURIComponent(
      integrationId
    )}/majors/${majorVersion}/auto-patch`,
    { enabled }
  );
}

export type OimConnectionSummary = Pick<
  OimConnection,
  | "id"
  | "integration"
  | "label"
  | "owner"
  | "status"
  | "isDefault"
  | "configuration"
  | "health"
  | "expiresAt"
> & {
  availableCredentialSlots: string[];
  disconnectPending: boolean;
  setupState?: "complete" | "incomplete" | "unavailable";
  credentialFree?: boolean;
};

export type OimConnectionRefreshStep = {
  stepId: string;
  status: "renewed" | "skipped" | "in_progress" | "action_required" | "conflict";
  error?:
    | "missing_step"
    | "missing_credential"
    | "refresh_failed"
    | "revision_conflict"
    | OimConnectionVerificationError;
};

export type OimConnectionRefreshResult = {
  connectionId: string;
  health: OimConnection["health"]["status"];
  steps: OimConnectionRefreshStep[];
};

export interface OimConnectionSetup {
  integration: OimConnection["integration"];
  connectionHealth?: OimConnection["health"]["status"];
  allowedOwnerScopes: readonly OimConnection["owner"]["scope"][];
  configurationFields: readonly {
    id: string;
    label: string;
    type: "string" | "url" | "boolean" | "integer";
    required: boolean;
    agentVisible: boolean;
  }[];
  fieldSteps: readonly {
    id: string;
    title: string;
    description?: string;
    fields: readonly {
      id: string;
      label: string;
      description?: string;
      input: "text" | "password" | "url";
      required: boolean;
      secret: boolean;
    }[];
  }[];
  initialAuthorizationSteps: readonly {
    id: string;
    title: string;
    description?: string;
    type: "oauth2" | "app_manifest" | "install" | "webhook";
  }[];
  pendingAuthorizationStepIds?: readonly string[];
}

export interface CreateOimConnectionInput {
  label: string;
  ownerScope: OimConnection["owner"]["scope"];
  ownerId?: string;
  values: Record<string, string>;
  isDefault?: boolean;
}

export type OimConnectionVerificationError =
  | "provider_proof_failed"
  | "verification_unavailable"
  | "verification_persistence_failed";

export type OimConnectionVerification =
  | { status: "not_required" | "pending" | "verified" }
  | { status: "action_required"; error: OimConnectionVerificationError };

export interface CreateOimConnectionResult {
  connectionId: string;
  verification: OimConnectionVerification;
}

export type OimConnectionAuthorizationAction =
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  | { action: "completed" }
  | { action: "pending" };

export async function listOimConnections(name: string): Promise<OimConnectionSummary[]> {
  const result = await apiGet<{ connections: OimConnectionSummary[] }>(
    `/api/v1/integrations/${encodeURIComponent(name)}/connections`
  );
  return result.connections;
}

export function getOimConnectionSetup(
  name: string,
  connectionId?: string
): Promise<OimConnectionSetup> {
  const query = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
  return apiGet(`/api/v1/integrations/${encodeURIComponent(name)}/connection-setup${query}`);
}

export function createOimConnection(
  name: string,
  input: CreateOimConnectionInput
): Promise<CreateOimConnectionResult> {
  return apiWrite("POST", `/api/v1/integrations/${encodeURIComponent(name)}/connections`, input);
}

export function refreshOimConnection(
  name: string,
  connectionId: string
): Promise<OimConnectionRefreshResult> {
  return apiWrite(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(connectionId)}/refresh`,
    {}
  );
}

export function updateOimConnectionCredentials(
  name: string,
  connectionId: string,
  values: Record<string, string>
): Promise<CreateOimConnectionResult> {
  return apiWrite(
    "PATCH",
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(connectionId)}/credentials`,
    { values }
  );
}

export function startOimConnectionAuthorization(
  name: string,
  connectionId: string,
  stepId: string,
  org?: string
): Promise<OimConnectionAuthorizationAction> {
  return apiWrite(
    "POST",
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(connectionId)}/auth/${encodeURIComponent(stepId)}`,
    org ? { org } : {}
  );
}

export async function revokeOimConnection(
  name: string,
  connectionId: string
): Promise<{ status: "revoked" | "disconnect_pending" }> {
  return apiWrite(
    "DELETE",
    `/api/v1/integrations/${encodeURIComponent(name)}/connections/${encodeURIComponent(connectionId)}`,
    undefined
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
