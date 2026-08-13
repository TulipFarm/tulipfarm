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

// ── Egress ────────────────────────────────────────────────────────────────────
// What the integration lets agents *do*. `openapi` and `mcp` are executed by the generic runtime
// (`@tulipfarm/integrations`'s `egress/`), so a third-party manifest can produce working Tools
// without shipping a line of code — that is the whole point of the declarative framework.

/**
 * How a connection credential is placed on an outbound request.
 *
 * One shape rather than a tagged union per scheme: `Authorization: Bearer {token}`,
 * `X-Api-Key: {token}`, and `Authorization: token {token}` differ only in header name and value
 * template, and the manifest already templates this way elsewhere (`WebhookSecurity.format`).
 */
export interface EgressAuth {
  /** Connection env var holding the credential. Sealed values resolve through the secrets store. */
  token_env: string;
  /**
   * Where the credential is placed. Default `header`.
   *
   * `base_url` is for providers that make the credential part of the address rather than a header
   * — Telegram's Bot API is `https://api.telegram.org/bot<token>/sendMessage`. The token replaces
   * `{token}` in `base_url`, and may only appear in the path: the host stays literal, so the
   * destination allow-list still pins one origin and a credential can never redirect a call.
   */
  in?: "header" | "base_url";
  /** Header the credential rides in. Ignored when `in` is `base_url`. Default `Authorization`. */
  header?: string;
  /** Value template; var: `{token}`. Ignored when `in` is `base_url`. Default `Bearer {token}`. */
  format?: string;
}

/** One OpenAPI operation published as an agent-callable Tool. */
export interface EgressOperation {
  /** `operationId` in the referenced spec. */
  operation: string;
  /** Tool name agents call, e.g. `search_notion`. Namespaced by the host, so it need not be unique
   * across integrations. */
  name: string;
  /** What the agent is told this does. The model picks tools from this, so it is load-bearing. */
  description: string;
  /** Overrides the default (any method other than GET is mutating). Mutating tools are approval-gated. */
  mutating?: boolean;
}

export type EgressConfig =
  | { type: "mcp"; entry: McpEntry }
  | {
      type: "openapi";
      /** Spec file within the integration directory. */
      spec: string;
      /**
       * Operations to publish. Required and explicit: a real provider spec carries dozens of
       * operations, and handing all of them to a model is both unusable and far more authority
       * than any one integration needs. Absent or empty publishes nothing.
       */
      operations?: EgressOperation[];
      /** Overrides the spec's own `servers[0].url`. */
      base_url?: string;
      auth?: EgressAuth;
      /** Static headers every call carries — e.g. Notion's required `Notion-Version`. */
      headers?: Record<string, string>;
    }
  | { type: "ts-code"; handler: string; toolsSpec: string }
  | { type: "none" };

// ── Ingress (declarative, manifest-driven) ────────────────────────────────────
// The host runs NO integration-specific code: webhook verification, handshake, dedup, and
// outbound calls are all declared here as templates/bindings, and event classification runs
// the integration's sandboxed handler module (pure function, no I/O).

/** HMAC webhook verification, fully template-driven. */
export interface HmacWebhookSecurity {
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

/**
 * The provider echoes back a secret we chose, and the header is compared for equality.
 *
 * Weaker than HMAC — it authenticates the sender but says nothing about the body, so a delivery
 * that is truncated or replayed still verifies. Declared as its own type rather than folded into
 * the HMAC shape so that weakness is visible in the manifest and in review, and so a manifest
 * cannot end up accepting a bare token where a signature was intended. Only for providers that
 * offer nothing better: Telegram's `X-Telegram-Bot-Api-Secret-Token` is the motivating case.
 */
export interface SharedSecretWebhookSecurity {
  type: "shared_secret";
  /** Header carrying the token (e.g. X-Telegram-Bot-Api-Secret-Token). */
  header: string;
  /** Connection env var holding the token we registered with the provider. */
  secret_env: string;
}

export type WebhookSecurity = HmacWebhookSecurity | SharedSecretWebhookSecurity;

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
  /**
   * Arg templates. String values take `{var}` substitutions from the caller-provided var map;
   * objects and arrays are walked so their strings template too, and everything else (numbers,
   * booleans, null) passes through.
   *
   * Nesting is not a convenience: an `openapi` egress tool takes its request body under a `body`
   * property, so a binding restricted to flat strings could not call one at all — which would
   * leave a fully declarative channel able to receive messages but not answer them.
   */
  args: Record<string, unknown>;
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
  /**
   * Non-secret connection env vars forwarded into the classifier's `ctx.env`.
   *
   * A classifier gets the delivery and nothing else, which leaves it unable to answer "is this
   * addressed to me?" — Telegram puts the bot's own @username nowhere in an update. Naming the
   * vars here keeps that explicit and reviewable. Secret env vars are rejected at load: the
   * classifier is untrusted per-integration code, and a credential handed to it is a credential
   * exfiltrated by the next version of it.
   */
  context_env?: string[];
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

// ── Auth (declarative, manifest-driven) ───────────────────────────────────────
// A connect flow is an ordered list of steps: the generic UI renders them and the auth broker
// executes them. The host runs NO integration-specific code — every provider URL, request body,
// and response mapping is declared here, exactly as ingress already is.
//
// The list is a sequence rather than one tagged mode because every real provider needs one:
// GitHub is create-app → exchange-credentials → install, Slack is create-app → paste tokens, and
// any OAuth2 provider needs its client credentials on hand before the redirect.
//
// Steps read connection env vars written by earlier steps, so ordering is significant.

/** Operator pastes values the provider showed them (bot tokens, API keys, workspace ids). */
export interface AuthFieldsStep {
  kind: "fields";
  title?: string;
  /** One sentence on why this step is being asked, shown under its title. */
  description?: string;
  fields: RequiredEnvVar[];
}

/** POST a provider's one-time code back and store the credentials it returns. */
export interface AuthExchange {
  /** Endpoint to POST. Vars: `{code}`. */
  url: string;
  /** Response dot-path → connection env var, e.g. `pem: GITHUB_APP_PRIVATE_KEY`. */
  map: Record<string, string>;
  /** Which mapped env vars hold secret material; the rest (app id, slug) are plain config. */
  secret_envs?: string[];
}

/**
 * Provider-hosted "create an app from this manifest" flow — the operator gets a prefilled app
 * definition instead of filling a long form by hand. Providers that hand credentials back for a
 * one-time code declare `exchange` (GitHub); those that don't are followed by a `fields` step
 * (Slack).
 */
export interface AuthAppManifestStep {
  kind: "app_manifest";
  title?: string;
  /** One sentence on why this step is being asked, shown under its title. */
  description?: string;
  /** Where the operator creates the app. Vars: `{state}`. */
  create_url: string;
  /** Auto-submitted form (GitHub) vs. a query param on `create_url` (Slack). */
  delivery: "form_post" | "query_param";
  /** Form field / query param carrying the serialized manifest. */
  manifest_param: string;
  /** The app definition. String values template `{callback_url}`, `{web_url}`, `{api_url}`. */
  manifest: Record<string, unknown>;
  exchange?: AuthExchange;
}

/**
 * Standard OAuth2. Unlike the other steps this is a real protocol, not a URL template: the broker
 * owns PKCE, state, token exchange, and refresh-before-expiry.
 */
export interface AuthOAuth2Step {
  kind: "oauth2";
  title?: string;
  /** One sentence on why this step is being asked, shown under its title. */
  description?: string;
  /** Default `authorization_code`. `client_credentials` skips the browser redirect. */
  grant?: "authorization_code" | "client_credentials";
  /**
   * Whether the token this step returns represents **the person who authorized it** rather than the
   * installation. Default `false`.
   *
   * This must be declared and cannot be inferred from `grant`. Slack's install step is
   * `authorization_code` and returns a workspace *bot* token with bot scopes; treating the grant
   * type as the discriminator would seal that shared token as one person's own credential and
   * attribute the bot's whole reach to them in the audit trail. OAuth2 says how the token was
   * obtained, never whose access it carries — only the manifest author knows that.
   *
   * `true` is what makes a provider eligible for `credentialMode: "user"` / `"user_preferred"`:
   * without a step that can mint a personal credential, a Tool demanding one is a dead end.
   */
  personal?: boolean;
  /** Required for `authorization_code`; unused for `client_credentials`. */
  authorization_url?: string;
  token_url: string;
  /** Defaults to `token_url`. */
  refresh_url?: string;
  scopes?: string[];
  /**
   * How `scopes` are joined on the authorize URL. Default `" "` per RFC 6749; Slack documents a
   * comma-separated list instead.
   */
  scope_separator?: string;
  /** PKCE (S256). Default true — disable only for providers that reject it. */
  pkce?: boolean;
  /** Static extra params on the authorize URL, e.g. Notion's `owner=user`. */
  authorize_params?: Record<string, string>;
  /** App credential env vars, supplied by an earlier step. */
  client_id_env: string;
  client_secret_env: string;
  /** Env var the access token is stored as. */
  token_env: string;
  refresh_token_env?: string;
  /** Env var holding the absolute ISO expiry, so the broker refreshes before it lapses. */
  expires_at_env?: string;
  /** Dot-path to the access token in the token response. Default `access_token`. */
  token_response_path?: string;
  /**
   * Extra values to keep from the token response, as dot-path → env var. Slack's
   * `oauth.v2.access` returns the workspace as `team.id`, which is needed for routing and is not
   * obtainable any other way without a second API call.
   */
  map?: Record<string, string>;
}

/**
 * Send the operator to the provider to install/authorize the app, then capture the identifiers
 * the callback returns (e.g. GitHub's `installation_id`). No token exchange — use `oauth2` when
 * the callback carries a code that must be redeemed.
 */
export interface AuthInstallStep {
  kind: "install";
  title?: string;
  /** One sentence on why this step is being asked, shown under its title. */
  description?: string;
  /** Vars: `{state}`, `{callback_url}`, and any connection env var by name. */
  url: string;
  /** Callback query param → connection env var. */
  capture?: Record<string, string>;
}

/**
 * Tell the provider where to deliver webhooks, and mint the secret it will authenticate with.
 *
 * The only step with no browser round trip: the server calls the provider directly with a
 * credential an earlier step obtained. Needed because push-delivery providers send nothing until
 * an endpoint is registered — Telegram's `setWebhook` is the motivating case — and asking an
 * operator to run a `curl` by hand is exactly the manual work this framework exists to remove.
 *
 * Re-running the step re-registers, which every such API treats as idempotent overwrite. That
 * matters: it is how an operator repairs a deployment whose public URL changed.
 */
export interface AuthWebhookStep {
  kind: "webhook";
  title?: string;
  /** One sentence on why this step is being asked, shown under its title. */
  description?: string;
  /** Endpoint to call. Vars: any connection env var by name, plus `{webhook_url}`. */
  url: string;
  /** Default `POST`. */
  method?: "POST" | "PUT";
  /**
   * Env var the generated delivery secret is stored as. Generated here rather than pasted so it is
   * high-entropy and never transits an operator's clipboard. Must match
   * `ingress.webhook.security.secret_env` for deliveries to verify.
   */
  secret_env?: string;
  /**
   * Request body. String values template like `url`, so `{webhook_url}` and the generated
   * `{<secret_env>}` are substituted; non-strings (arrays of event names, booleans) pass through.
   */
  body?: Record<string, unknown>;
  /** Response dot-path → connection env var, for providers that return identifiers worth keeping. */
  map?: Record<string, string>;
}

export type AuthStep =
  | AuthFieldsStep
  | AuthAppManifestStep
  | AuthOAuth2Step
  | AuthInstallStep
  | AuthWebhookStep;

// ── Manifest ──────────────────────────────────────────────────────────────────

/**
 * One unit of authority an integration asks for. Rendered to the operator before they connect, so
 * it is written in the provider's own vocabulary rather than translated — an operator checking this
 * against the provider's consent screen must see matching words.
 */
export interface IntegrationGrant {
  /** What is reached: `issues`, `chat:write`. */
  label: string;
  /** Level of access, where the provider separates it from the label. OAuth scopes encode it. */
  access?: string;
  /** One sentence for an operator who does not speak the provider's vocabulary. */
  description?: string;
}

export interface IntegrationManifest {
  name: string;
  version?: string;
  description?: string;
  maintainer?: string;
  /**
   * Brand mark, named as a Simple Icons slug (https://simpleicons.org) — e.g. `github`, `notion`.
   * A slug rather than a file or URL: a remote URL would leak every operator's IP to that host on
   * page load and could be swapped after review, and a bundled file would mean adding an
   * integration is no longer just writing a manifest. Not every brand is in the set — Slack and
   * Microsoft Teams had theirs removed on trademark request — so the mark is always optional and
   * callers fall back to a derived monogram.
   */
  icon?: string;
  /**
   * What agents can do once this is connected, in the operator's language — not tool names. Free
   * text because the underlying tools have no single introspectable source: a `ts-code` integration
   * carries them in code, `openapi` in a spec, `mcp` behind a server. This is a description and is
   * not enforced; `grants` below is the authoritative answer to what authority is handed over.
   */
  capabilities?: string[];
  /**
   * The authority connecting this integration hands to TulipFarm. Derived from the `oauth2` step's
   * `scopes` when omitted, so an OAuth integration never authors this twice. Declare it explicitly
   * only when authority comes from somewhere the resolver cannot read — a GitHub App's
   * `default_permissions` lives inside the provider-defined `app_manifest` blob, which TulipFarm
   * deliberately does not interpret.
   */
  grants?: IntegrationGrant[];
  egress: EgressConfig;
  ingress?: IngressConfig;
  /**
   * Ordered connect flow. Supersedes `required_env` / `oauth`: read it through
   * `resolveAuthSteps()`, which derives the equivalent steps for manifests that predate it.
   */
  auth?: AuthStep[];
  /** @deprecated Declare a `fields` step in `auth` instead. */
  required_env?: RequiredEnvVar[];
  setup_guide_path?: string;
  /** @deprecated Declare an `oauth2` step in `auth` instead. */
  oauth?: OAuthConfig;
  /**
   * Provider app-manifest (e.g. Slack's app manifest) to paste during install, serialized as JSON
   * for display.
   * @deprecated Declare an `app_manifest` step in `auth` instead, which submits it for the operator.
   */
  install_manifest?: Record<string, unknown>;
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
  /** Parsed OpenAPI document (present when manifest.egress.spec is declared and readable). */
  egressSpec?: unknown;
}

/** Minimal logger surface (pino/console compatible) shared across soul services. */
export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
