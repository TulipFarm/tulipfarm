import type { RoleDefinition } from "@tulipfarm/schema";

export interface SoulAgent {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SoulSkill {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SoulResource {
  name: string;
  domain?: string;
  schema: Record<string, unknown>;
  hasHooks: boolean;
  hookSource?: string;
  hookHash?: string;
  hooksEnabled: boolean;
}

export interface SoulRoutine {
  name: string;
  config: Record<string, unknown>;
  hasHooks: boolean;
  hookSource?: string;
  hookHash?: string;
}

export interface SoulRole {
  name: string;
  definition: RoleDefinition;
}

export type McpEntry =
  | { transport: "stdio"; command: string; args?: string[] }
  | { transport: "sse"; url: string; headers?: Record<string, string> };

/** How a connection credential is placed on outbound requests. */
export interface EgressAuth {
  /** Connection env var holding the credential. Sealed values resolve through the secrets store. */
  token_env: string;
  /** `base_url` allows path-only token templating while keeping the host allow-listed. */
  in?: "header" | "base_url";
  header?: string;
  /** Value template; var: `{token}`. Ignored when `in` is `base_url`. Default `Bearer {token}`. */
  format?: string;
}

export interface EgressOperation {
  operation: string;
  name: string;
  description: string;
  /** Overrides the default (any method other than GET is mutating). Mutating tools are approval-gated. */
  mutating?: boolean;
}

export type EgressConfig =
  | { type: "mcp"; entry: McpEntry }
  | {
      type: "openapi";
      spec: string;
      /** Explicit operation allowlist; absent or empty publishes no Tools. */
      operations?: EgressOperation[];
      base_url?: string;
      auth?: EgressAuth;
      headers?: Record<string, string>;
    }
  | { type: "ts-code"; handler: string; toolsSpec: string }
  | { type: "none" };

export interface HmacWebhookSecurity {
  type: "hmac_sha256";
  header: string;
  secret_env: string;
  signing?: string;
  format?: string;
  timestamp_header?: string;
  tolerance_seconds?: number;
}

/** Shared-secret verification is weaker than HMAC; use only when providers offer nothing better. */
export interface SharedSecretWebhookSecurity {
  type: "shared_secret";
  header: string;
  secret_env: string;
}

export type WebhookSecurity = HmacWebhookSecurity | SharedSecretWebhookSecurity;

export interface BodyMatch {
  path: string;
  equals: string;
}

export interface WebhookHandshake {
  match: BodyMatch;
  respond: Record<string, string>;
}

export interface WebhookConfig {
  security: WebhookSecurity;
  handshake?: WebhookHandshake;
  accept?: BodyMatch;
  dedup_key?: string;
  dedup_header?: string;
  context_headers?: string[];
}

export interface ToolBinding {
  tool: string;
  /** Nested arg templates are required for OpenAPI request bodies. */
  args: Record<string, unknown>;
}

export interface ChatIngressConfig {
  /** External conversation key template; computed before classification. */
  thread_key: string;
  identity?: ToolBinding & { email_path: string };
  reply: Record<string, ToolBinding>;
}

export interface IngressConfig {
  spec?: string;
  handler: string;
  webhook: WebhookConfig;
  /** Non-secret env forwarded to the classifier; secret env names are rejected at load. */
  context_env?: string[];
  chat?: ChatIngressConfig;
  events?: { types?: string[] };
}

export interface RequiredEnvVar {
  name: string;
  label: string;
  description?: string;
  secret?: boolean;
  setup_url?: string;
  steps?: string[];
}

export interface OAuthFlowConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
}

export interface OAuthConfig {
  flows: {
    authorizationCode?: OAuthFlowConfig;
    clientCredentials?: OAuthFlowConfig;
  };
  "x-tulipfarm": {
    client_id_env: string;
    client_secret_env: string;
    token_env: string;
    token_response_path?: string;
  };
}

export interface AuthFieldsStep {
  kind: "fields";
  title?: string;
  description?: string;
  fields: RequiredEnvVar[];
}

export interface AuthExchange {
  url: string;
  /** Response dot-path → connection env var, e.g. `pem: GITHUB_APP_PRIVATE_KEY`. */
  map: Record<string, string>;
  /** Which mapped env vars hold secret material; the rest (app id, slug) are plain config. */
  secret_envs?: string[];
}

/** Provider app-manifest creation flow; credentials require `exchange` or a later `fields` step. */
export interface AuthAppManifestStep {
  kind: "app_manifest";
  title?: string;
  description?: string;
  create_url: string;
  delivery: "form_post" | "query_param";
  manifest_param: string;
  manifest: Record<string, unknown>;
  exchange?: AuthExchange;
}

/** OAuth2 step; the broker owns PKCE, state, token exchange, and refresh-before-expiry. */
export interface AuthOAuth2Step {
  kind: "oauth2";
  title?: string;
  description?: string;
  grant?: "authorization_code" | "client_credentials";
  /** Token actor: explicit `true` means personal; OAuth grant type is not enough. */
  personal?: boolean;
  authorization_url?: string;
  token_url: string;
  refresh_url?: string;
  scopes?: string[];
  scope_separator?: string;
  pkce?: boolean;
  authorize_params?: Record<string, string>;
  client_id_env: string;
  client_secret_env: string;
  token_env: string;
  refresh_token_env?: string;
  expires_at_env?: string;
  token_response_path?: string;
  /** Extra token response values to keep, such as Slack `team.id` for routing. */
  map?: Record<string, string>;
}

/** Install/authorize callback capture without token exchange. */
export interface AuthInstallStep {
  kind: "install";
  title?: string;
  description?: string;
  url: string;
  capture?: Record<string, string>;
}

/** Provider webhook registration step; re-running should idempotently overwrite the endpoint. */
export interface AuthWebhookStep {
  kind: "webhook";
  title?: string;
  description?: string;
  url: string;
  method?: "POST" | "PUT";
  /** Generated delivery secret env; must match `ingress.webhook.security.secret_env`. */
  secret_env?: string;
  /** Request body templates `{webhook_url}` and the generated `{<secret_env>}`. */
  body?: Record<string, unknown>;
  map?: Record<string, string>;
}

export type AuthStep =
  | AuthFieldsStep
  | AuthAppManifestStep
  | AuthOAuth2Step
  | AuthInstallStep
  | AuthWebhookStep;

/** Operator-visible integration authority, written in provider vocabulary. */
export interface IntegrationGrant {
  label: string;
  access?: string;
  description?: string;
}

export interface IntegrationManifest {
  name: string;
  version?: string;
  description?: string;
  maintainer?: string;
  /** Simple Icons slug; optional because remote icons would leak IPs and can change after review. */
  icon?: string;
  /** Descriptive, unenforced capability text; `grants` is authoritative for handed-over authority. */
  capabilities?: string[];
  /** Authority handed to TulipFarm; derived from OAuth scopes unless the source is opaque. */
  grants?: IntegrationGrant[];
  egress: EgressConfig;
  ingress?: IngressConfig;
  /** Ordered connect flow; use `resolveAuthSteps()` to include legacy fields. */
  auth?: AuthStep[];
  /** @deprecated Declare a `fields` step in `auth` instead. */
  required_env?: RequiredEnvVar[];
  setup_guide_path?: string;
  /** @deprecated Declare an `oauth2` step in `auth` instead. */
  oauth?: OAuthConfig;
  /** @deprecated Declare an `app_manifest` step in `auth` instead. */
  install_manifest?: Record<string, unknown>;
}

export interface IntegrationConnection {
  enabled: boolean;
  env?: Record<string, string>;
}

export interface SoulIntegration {
  slug: string;
  sourceIntegration: string;
  manifest: IntegrationManifest;
  connection?: IntegrationConnection;
  setupGuide?: string;
  ingressHandler?: { source: string; hash: string };
  egressSpec?: unknown;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
