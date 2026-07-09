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

export type McpEntry =
  | { transport: "stdio"; command: string; args?: string[] }
  | { transport: "sse"; url: string; headers?: Record<string, string> };

// ── Egress ────────────────────────────────────────────────────────────────────

export type EgressConfig =
  | { type: "mcp"; entry: McpEntry }
  | { type: "openapi"; spec: string }
  | { type: "ts-code"; handler: string; toolsSpec: string };

// ── Ingress ───────────────────────────────────────────────────────────────────

export interface WebhookSecurity {
  type: "hmac_sha256";
  header: string;
  secret_env: string;
}

export interface WebhookConfig {
  path: string;
  security?: WebhookSecurity | { type: "none" };
  dedup_header?: string;
  verification_protocol?: "slack" | "github";
}

export type IngressConfig =
  | { type: "asyncapi"; spec: string; webhook?: WebhookConfig }
  | { type: "ts-code"; handler: string; webhook?: WebhookConfig }
  | { type: "none" };

// ── IngressAction (returned by ingress handlers) ──────────────────────────────

export type IngressAction =
  | { type: "emit_event"; name: string; payload: unknown }
  | {
      type: "inject_message";
      conversationKey: string;
      message: { role: "user"; content: string };
      triggerAgent: boolean;
    }
  | { type: "respond"; status: number; body: unknown };

// ── Credential helpers ────────────────────────────────────────────────────────

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

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface IntegrationManifest {
  name: string;
  version?: string;
  description?: string;
  maintainer?: string;
  egress: EgressConfig;
  ingress?: IngressConfig;
  required_env?: RequiredEnvVar[];
  setup_guide_path?: string;
  oauth?: OAuthConfig;
}

export interface IntegrationConnection {
  enabled: boolean;
  env?: Record<string, string>;
}

export interface SoulIntegration {
  /** Installation slug — unique key, user-assigned at install time (may differ from manifest.name). */
  slug: string;
  /** The integration type name from the source repo (manifest.name). */
  sourceIntegration: string;
  manifest: IntegrationManifest;
  connection?: IntegrationConnection;
  setupGuide?: string;
}

/** Minimal logger surface (pino/console compatible) shared across soul services. */
export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
