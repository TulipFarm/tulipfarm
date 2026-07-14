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

// ── Ingress (declarative, manifest-driven) ────────────────────────────────────
// The host runs NO integration-specific code: webhook verification, handshake, dedup, and
// outbound calls are all declared here as templates/bindings, and event classification runs
// the integration's sandboxed handler module (pure function, no I/O).

/** HMAC webhook verification, fully template-driven. */
export interface WebhookSecurity {
  type: "hmac_sha256";
  /** Header carrying the signature (e.g. X-Slack-Signature, X-Hub-Signature-256). */
  header: string;
  /** Connection env var holding the shared signing secret. */
  secret_env: string;
  /** Canonical-string template; vars: {timestamp}, {body}. Default "{body}". */
  signing?: string;
  /** Signature header format template; var: {hex} (e.g. "v0={hex}", "sha256={hex}"). Default "{hex}". */
  format?: string;
  /** Header carrying the request timestamp; required when `signing` uses {timestamp}. */
  timestamp_header?: string;
  /** Replay window in seconds, enforced when timestamp_header is set. Default 300. */
  tolerance_seconds?: number;
}

/** Dot-path equality match against the parsed JSON body. */
export interface BodyMatch {
  path: string;
  equals: string;
}

/** Provider URL-verification challenge: when `match` hits, respond with the templated body. */
export interface WebhookHandshake {
  match: BodyMatch;
  /** Response body: literal strings with {<dot.path>} substitutions resolved against the payload. */
  respond: Record<string, string>;
}

export interface WebhookConfig {
  security: WebhookSecurity;
  handshake?: WebhookHandshake;
  /** Hot-path filter: non-matching bodies are acked (200) and dropped before enqueue. */
  accept?: BodyMatch;
  /** Dot-path into the body used for provider-retry dedup; absent → no dedup. */
  dedup_key?: string;
  /** Header whose value dedups retries (e.g. X-GitHub-Delivery); takes precedence over dedup_key. */
  dedup_header?: string;
  /**
   * Request headers forwarded into the classifier's ctx.headers, lowercased (e.g. X-GitHub-Event,
   * whose value names the event type for providers that don't put it in the body).
   */
  context_headers?: string[];
}

/** One outbound call bound to a tool exposed by the integration's own MCP server. */
export interface ToolBinding {
  /** Tool name as the MCP server exposes it; the host resolves it within this integration's tools. */
  tool: string;
  /** Arg templates: literal strings with {var} substitutions from the caller-provided var map. */
  args: Record<string, string>;
}

export interface ChatIngressConfig {
  /**
   * Template for the external conversation key, e.g. "{team_id}/{event.channel}/{event.thread_ts|event.ts}".
   * Vars are body dot-paths; `|` separates fallbacks. Computed by the host BEFORE classification
   * so the handler receives `hasThreadMapping`.
   */
  thread_key: string;
  /** Sender → TulipFarm user resolution (var: {sender}); omitted → turns run as the admin. */
  identity?: ToolBinding & { email_path: string };
  /** Named reply bindings; the handler's chat decision picks one by name. */
  reply: Record<string, ToolBinding>;
}

export interface IngressConfig {
  /** AsyncAPI doc describing the handled events — documentation artifact, never executed. */
  spec?: string;
  /** Filename (within the integration dir) of the sandboxed classifier module. */
  handler: string;
  webhook: WebhookConfig;
  /** Presence enables chat-kind decisions. */
  chat?: ChatIngressConfig;
  /** Presence enables event-kind decisions; `types` optionally allowlists provider event types. */
  events?: { types?: string[] };
}

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
  /** Sandboxed classifier module (present when manifest.ingress.handler is declared and readable). */
  ingressHandler?: { source: string; hash: string };
}

/** Minimal logger surface (pino/console compatible) shared across soul services. */
export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
