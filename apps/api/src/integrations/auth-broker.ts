import { createHash, randomBytes } from "node:crypto";
import type {
  AuthOAuth2Step,
  AuthStep,
  AuthWebhookStep,
  IntegrationManifest,
  RequiredEnvVar,
} from "@tulipfarm/soul";
import {
  isPersonalCredentialStep,
  oauth2ExpiresAtEnv,
  oauth2RefreshTokenEnv,
  resolveAuthSteps,
} from "@tulipfarm/soul";
import type { Queryable } from "../db";

/**
 * The generic Integration auth broker: it executes the declarative `auth` step list a manifest
 * declares (`packages/soul/src/integration-auth.ts`) so no Integration needs bespoke connect
 * routes. Every provider URL, request body, and response mapping is data, not code.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **One callback for every Integration.** Providers require the redirect URI to be registered
 *    up front, so it must be stable: `/api/v1/integrations/auth/callback`. Which Integration and
 *    which step a callback belongs to is carried by the one-use `state`, never by the path.
 * 2. **State lives server-side and is consumed exactly once.** The PKCE verifier never leaves this
 *    process, so a captured callback URL cannot be replayed and a code obtained in one browser
 *    cannot be redeemed in another — the same posture as `identity/oidc.ts`. A stateless signed
 *    `state` cannot do this: it has nowhere to hide a verifier and nothing to mark as spent.
 */

// ── Templating ────────────────────────────────────────────────────────────────

/**
 * Substitutes `{name}` placeholders. Unknown placeholders are left untouched rather than blanked,
 * so a manifest typo surfaces as a visibly wrong URL instead of a silently truncated one.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** Renders every string in a nested manifest value, leaving non-strings structurally intact. */
export function renderDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderDeep(item, vars);
    return out;
  }
  return value;
}

/** Reads a dot-path out of a provider response, e.g. `authed_user.access_token`. */
export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Provider values arrive as strings, numbers, or booleans; anything else is not a credential. */
function asEnvValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

// ── One-use authorization requests ────────────────────────────────────────────

export interface IntegrationAuthRequestDoc {
  state: string;
  integrationSlug: string;
  stepIndex: number;
  codeVerifier: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  /**
   * Whose connect this is. Null is the business-wide flow — credentials land in `connection.yaml`
   * and every caller spends them. A principal means the resulting token is *that principal's own*
   * (D7) and must be sealed into `principal_provider_tokens`, never into the shared connection.
   *
   * It is recorded at issue time rather than read from the session at callback time because the
   * callback is deliberately unauthenticated (a cross-site top-level navigation carries no
   * `SameSite=Strict` cookie), so the callback has no trustworthy notion of who is connecting.
   */
  principal: { readonly kind: string; readonly id: string } | null;
}

export interface IntegrationAuthRequestRepo {
  create(request: IntegrationAuthRequestDoc): Promise<void>;
  /** Atomically consumes the request; null when unknown, expired, or already consumed. */
  consume(state: string): Promise<IntegrationAuthRequestDoc | null>;
}

export const DEFAULT_AUTH_REQUEST_TTL_SECONDS = 600;

function rowToRequest(row: Record<string, unknown>): IntegrationAuthRequestDoc {
  const kind = (row.principal_kind as string | null) ?? null;
  const id = (row.principal_id as string | null) ?? null;
  return {
    state: row.state as string,
    integrationSlug: row.integration_slug as string,
    stepIndex: row.step_index as number,
    codeVerifier: (row.code_verifier as string | null) ?? null,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
    // Both or neither: a half-written pair cannot name a principal, and guessing one half would
    // attribute a credential to the wrong subject.
    principal: kind !== null && id !== null ? { kind, id } : null,
  };
}

export class PgIntegrationAuthRequestRepo implements IntegrationAuthRequestRepo {
  constructor(private readonly q: Queryable) {}

  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO integration_auth_requests
         (state, integration_slug, step_index, code_verifier, created_at, expires_at, consumed_at,
          principal_kind, principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        request.state,
        request.integrationSlug,
        request.stepIndex,
        request.codeVerifier,
        request.createdAt,
        request.expiresAt,
        request.consumedAt,
        request.principal?.kind ?? null,
        request.principal?.id ?? null,
      ]
    );
  }

  async consume(state: string): Promise<IntegrationAuthRequestDoc | null> {
    const { rows } = await this.q.query(
      `UPDATE integration_auth_requests SET consumed_at = now()
       WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [state]
    );
    return rows.length > 0 ? rowToRequest(rows[0]) : null;
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type AuthBrokerDenialReason =
  | "unknown_step"
  | "invalid_state"
  | "missing_credentials"
  | "exchange_failed";

export class AuthBrokerError extends Error {
  /** Set once the state is consumed, so a mid-flow failure can be shown on the right page. */
  slug?: string;

  constructor(
    readonly reason: AuthBrokerDenialReason,
    message: string,
    slug?: string
  ) {
    super(message);
    this.name = "AuthBrokerError";
    this.slug = slug;
  }
}

// ── Starting a step ───────────────────────────────────────────────────────────

/**
 * What the browser must do to advance a step. `collect_fields` needs no provider round trip — the
 * operator types the values and posts them to the existing connect route.
 */
export type AuthStartAction =
  | { action: "collect_fields"; fields: RequiredEnvVar[] }
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  /**
   * The server already did the work and produced connection env; the browser only has to move on.
   * `env` never reaches the browser — the route strips it after sealing, exactly as it does for a
   * provider callback's outcome.
   */
  | { action: "completed"; env: Record<string, string> };

export interface AuthEndpoints {
  /** Stable provider redirect target, e.g. `https://api.example.com/api/v1/integrations/auth/callback`. */
  callbackUrl: string;
  /** Origin users reach the web app on. */
  webUrl: string;
  /** Origin the API answers on. */
  apiUrl: string;
}

export interface StartAuthStepInput {
  slug: string;
  manifest: IntegrationManifest;
  stepIndex: number;
  /** Connection env resolved to plaintext — earlier steps' output feeds later steps. */
  env: Record<string, string>;
  endpoints: AuthEndpoints;
  repo: IntegrationAuthRequestRepo;
  ttlSeconds?: number;
  now?: () => Date;
  /** Only the `webhook` step calls a provider from here; every other step round-trips the browser. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Connect *as this principal* rather than for the deployment (D7). Absent is the business-wide
   * flow. Only an `oauth2` authorization-code step can produce a personal credential; asking for a
   * user-scoped run of any other step kind is rejected rather than silently downgraded, because a
   * downgrade would write the deployment's shared credential in response to a request to connect
   * a personal one.
   */
  principal?: { readonly kind: string; readonly id: string };
}

function stepAt(manifest: IntegrationManifest, index: number): AuthStep {
  const step = resolveAuthSteps(manifest)[index];
  if (!step) throw new AuthBrokerError("unknown_step", `no auth step at index ${index}`);
  return step;
}

async function issueState(input: StartAuthStepInput, codeVerifier: string | null): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const now = (input.now ?? (() => new Date()))();
  await input.repo.create({
    state,
    integrationSlug: input.slug,
    stepIndex: input.stepIndex,
    codeVerifier,
    createdAt: now,
    expiresAt: new Date(
      now.getTime() + (input.ttlSeconds ?? DEFAULT_AUTH_REQUEST_TTL_SECONDS) * 1000
    ),
    consumedAt: null,
    principal: input.principal ?? null,
  });
  return state;
}

function endpointVars(endpoints: AuthEndpoints, env: Record<string, string>) {
  return {
    ...env,
    callback_url: endpoints.callbackUrl,
    web_url: endpoints.webUrl,
    api_url: endpoints.apiUrl,
  };
}

export function buildAuthorizeUrl(
  step: AuthOAuth2Step,
  input: { clientId: string; state: string; codeChallenge?: string; redirectUri: string }
): string {
  if (!step.authorization_url) {
    throw new AuthBrokerError("unknown_step", "oauth2 step has no authorization_url");
  }
  const url = new URL(step.authorization_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  if (step.scopes && step.scopes.length > 0) {
    url.searchParams.set("scope", step.scopes.join(step.scope_separator ?? " "));
  }
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(step.authorize_params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * The address this deployment receives deliveries on, which is what the provider must be told.
 *
 * Derived from the API origin rather than declared per manifest so it cannot disagree with the
 * route that actually serves `/api/v1/hooks/integrations/:name`.
 */
export function ingressWebhookUrl(endpoints: AuthEndpoints, slug: string): string {
  return `${endpoints.apiUrl.replace(/\/+$/, "")}/api/v1/hooks/integrations/${slug}`;
}

/**
 * Executes a `webhook` step: mint the delivery secret, tell the provider where to deliver, and
 * keep whatever identifiers it returned.
 *
 * The secret is generated rather than collected. A provider that lets us choose it is a provider
 * where the operator would otherwise invent one, and an operator-chosen webhook secret is the
 * single most predictable credential in any deployment.
 *
 * A provider that answers non-2xx, or that answers `{"ok": false}`, produces no env at all: half a
 * registration — a stored secret with nothing registered against it — would leave the integration
 * looking connected while every delivery bounced.
 */
async function registerWebhook(
  step: AuthWebhookStep,
  input: StartAuthStepInput
): Promise<Record<string, string>> {
  const produced: Record<string, string> = {};
  if (step.secret_env) produced[step.secret_env] = randomBytes(32).toString("base64url");

  const vars = {
    ...endpointVars(input.endpoints, input.env),
    ...produced,
    webhook_url: ingressWebhookUrl(input.endpoints, input.slug),
  };

  const url = renderTemplate(step.url, vars);
  if (!url.startsWith("https://")) {
    // A templated env var could otherwise turn this into a plaintext or file URL, and this
    // request carries both a provider credential and the secret we just minted.
    throw new AuthBrokerError("exchange_failed", "webhook registration url must be https");
  }
  if (/\{[A-Za-z0-9_.]+\}/.test(url)) {
    throw new AuthBrokerError(
      "missing_credentials",
      "webhook registration url has unresolved placeholders; an earlier step must supply them"
    );
  }

  let response: Response;
  try {
    response = await (input.fetchImpl ?? globalThis.fetch)(url, {
      method: step.method ?? "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(renderDeep(step.body ?? {}, vars)),
    });
  } catch {
    // The URL may embed the credential, so it must never reach the message an operator sees.
    throw new AuthBrokerError(
      "exchange_failed",
      "webhook registration could not reach the provider"
    );
  }

  const parsed = await readJsonBody(response);
  if (!response.ok || parsed.ok === false) {
    throw new AuthBrokerError(
      "exchange_failed",
      `webhook registration was rejected (${response.status})`
    );
  }

  for (const [path, envName] of Object.entries(step.map ?? {})) {
    const value = asEnvValue(readPath(parsed, path));
    if (value !== undefined) produced[envName] = value;
  }
  return produced;
}

/** A provider that answers with something other than JSON has still answered; treat it as empty. */
async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Prepares one step, persisting the one-use state any provider round trip will come back with. */
export async function startAuthStep(input: StartAuthStepInput): Promise<AuthStartAction> {
  const step = stepAt(input.manifest, input.stepIndex);

  // A personal credential may only come from a step that declares itself personal. Grant type is
  // not the test: Slack's install step is `authorization_code` and returns a workspace bot token,
  // so accepting the grant alone would seal a shared bot credential under one person's name.
  // Refusing here is what keeps "connect my GitHub" from quietly re-running the operator flow, and
  // it reads the identical predicate the Tool compiler uses, so a Tool can never demand a
  // credential this route would refuse to mint.
  if (input.principal !== undefined && !isPersonalCredentialStep(step)) {
    throw new AuthBrokerError(
      "unknown_step",
      `step ${input.stepIndex} cannot issue a personal credential; only an oauth2 authorization_code step declaring \`personal: true\` can`
    );
  }

  switch (step.kind) {
    case "fields":
      return { action: "collect_fields", fields: step.fields };

    case "app_manifest": {
      const state = await issueState(input, null);
      const vars = endpointVars(input.endpoints, input.env);
      const url = renderTemplate(step.create_url, { ...vars, state });
      const value = JSON.stringify(renderDeep(step.manifest, vars));
      if (step.delivery === "query_param") {
        const withParam = new URL(url);
        withParam.searchParams.set(step.manifest_param, value);
        return { action: "redirect", url: withParam.toString() };
      }
      return { action: "form_post", url, field: step.manifest_param, value };
    }

    case "install": {
      const state = await issueState(input, null);
      const vars = endpointVars(input.endpoints, input.env);
      return { action: "redirect", url: renderTemplate(step.url, { ...vars, state }) };
    }

    case "webhook":
      return { action: "completed", env: await registerWebhook(step, input) };

    case "oauth2": {
      const clientId = input.env[step.client_id_env];
      if (!clientId) {
        throw new AuthBrokerError(
          "missing_credentials",
          `${step.client_id_env} is not set; an earlier auth step must supply it`
        );
      }
      const usePkce = step.pkce !== false;
      const codeVerifier = usePkce ? randomBytes(32).toString("base64url") : null;
      const state = await issueState(input, codeVerifier);
      return {
        action: "redirect",
        url: buildAuthorizeUrl(step, {
          clientId,
          state,
          codeChallenge: codeVerifier
            ? createHash("sha256").update(codeVerifier).digest("base64url")
            : undefined,
          redirectUri: input.endpoints.callbackUrl,
        }),
      };
    }
  }
}

// ── Completing a step ─────────────────────────────────────────────────────────

export interface CompleteAuthStepInput {
  /** Every query param the provider sent back. */
  query: Record<string, string>;
  /** Resolves the manifest for the slug recorded in the consumed state. */
  loadManifest: (slug: string) => IntegrationManifest | undefined;
  /** Connection env resolved to plaintext, for the client credentials an exchange needs. */
  loadEnv: (slug: string) => Promise<Record<string, string>>;
  endpoints: AuthEndpoints;
  repo: IntegrationAuthRequestRepo;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface AuthStepOutcome {
  slug: string;
  stepIndex: number;
  /** Connection env values this step produced, to be merged and sealed by the caller. */
  env: Record<string, string>;
  /**
   * Whose credential this is, echoed from the consumed request. Present means the caller must seal
   * it under that principal instead of merging it into the shared `connection.yaml` — the whole
   * point of the user-scoped flow, and the one decision the callback route cannot make for itself.
   */
  principal?: { readonly kind: string; readonly id: string };
  /** The OAuth2 step this outcome came from, when it was one. Names the token env vars. */
  oauth2Step?: AuthOAuth2Step;
}

async function postForm(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, string>
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Providers that ignore the Accept header answer form-encoded (GitHub historically did).
    parsed = Object.fromEntries(new URLSearchParams(text));
  }
  if (!response.ok || typeof parsed !== "object" || parsed === null) {
    throw new AuthBrokerError("exchange_failed", `token endpoint returned ${response.status}`);
  }
  const record = parsed as Record<string, unknown>;
  // OAuth2 error responses are 200-with-an-error-body often enough to check explicitly.
  if (typeof record.error === "string") {
    throw new AuthBrokerError("exchange_failed", `token endpoint rejected the exchange`);
  }
  return record;
}

/** Maps an OAuth2 token response onto the env vars the step declares. */
export function mapTokenResponse(
  step: AuthOAuth2Step,
  response: Record<string, unknown>,
  now: Date
): Record<string, string> {
  const env: Record<string, string> = {};
  const accessToken = asEnvValue(readPath(response, step.token_response_path ?? "access_token"));
  if (!accessToken) {
    throw new AuthBrokerError("exchange_failed", "token endpoint returned no access token");
  }
  env[step.token_env] = accessToken;

  for (const [path, envName] of Object.entries(step.map ?? {})) {
    const value = asEnvValue(readPath(response, path));
    if (value !== undefined) env[envName] = value;
  }

  // Only written when the provider actually returns them: a provider that issues non-expiring
  // tokens must not end up with a fabricated expiry that triggers pointless refreshes.
  const refresh = asEnvValue(readPath(response, "refresh_token"));
  if (refresh) env[oauth2RefreshTokenEnv(step)] = refresh;

  const expiresIn = Number(readPath(response, "expires_in"));
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    env[oauth2ExpiresAtEnv(step)] = new Date(now.getTime() + expiresIn * 1000).toISOString();
  }
  return env;
}

/** Consumes the one-use state and turns the provider's callback into connection env values. */
export async function completeAuthStep(input: CompleteAuthStepInput): Promise<AuthStepOutcome> {
  const state = input.query.state;
  if (!state) throw new AuthBrokerError("invalid_state", "callback carried no state");

  const request = await input.repo.consume(state);
  if (!request) {
    throw new AuthBrokerError("invalid_state", "state is unknown, expired, or already used");
  }

  const manifest = input.loadManifest(request.integrationSlug);
  if (!manifest) {
    throw new AuthBrokerError("unknown_step", `integration not found: ${request.integrationSlug}`);
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = (input.now ?? (() => new Date()))();
  const outcome = {
    slug: request.integrationSlug,
    stepIndex: request.stepIndex,
    ...(request.principal === null ? {} : { principal: request.principal }),
  };

  try {
    return await completeStep({ input, request, manifest, fetchImpl, now, outcome });
  } catch (err) {
    // Everything past the consume knows which Integration it belongs to, so failures can be shown
    // on that Integration's page instead of a generic error.
    if (err instanceof AuthBrokerError) err.slug ??= request.integrationSlug;
    throw err;
  }
}

async function completeStep(ctx: {
  input: CompleteAuthStepInput;
  request: IntegrationAuthRequestDoc;
  manifest: IntegrationManifest;
  fetchImpl: typeof globalThis.fetch;
  now: Date;
  outcome: Omit<AuthStepOutcome, "env">;
}): Promise<AuthStepOutcome> {
  const { input, request, manifest, fetchImpl, now, outcome } = ctx;
  const step = stepAt(manifest, request.stepIndex);

  switch (step.kind) {
    case "fields":
      // A fields step never redirects anywhere, so it can never produce a callback.
      throw new AuthBrokerError("unknown_step", "fields steps do not use the callback");

    case "webhook":
      // Registration completes inside `startAuthStep`; nothing is left for a provider to call back
      // about, so a callback naming this step is a forged or stale state rather than a flow.
      throw new AuthBrokerError("unknown_step", "webhook steps do not use the callback");

    case "install": {
      const env: Record<string, string> = {};
      for (const [param, envName] of Object.entries(step.capture ?? {})) {
        const value = input.query[param];
        if (value !== undefined) env[envName] = value;
      }
      return { ...outcome, env };
    }

    case "app_manifest": {
      if (!step.exchange) return { ...outcome, env: {} };
      const code = input.query.code;
      if (!code) throw new AuthBrokerError("exchange_failed", "callback carried no code");
      const response = await fetchImpl(renderTemplate(step.exchange.url, { code }), {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new AuthBrokerError(
          "exchange_failed",
          `app manifest conversion returned ${response.status}`
        );
      }
      const body = (await response.json()) as Record<string, unknown>;
      const env: Record<string, string> = {};
      for (const [path, envName] of Object.entries(step.exchange.map)) {
        const value = asEnvValue(readPath(body, path));
        if (value !== undefined) env[envName] = value;
      }
      return { ...outcome, env };
    }

    case "oauth2": {
      const code = input.query.code;
      if (!code) throw new AuthBrokerError("exchange_failed", "callback carried no code");
      const env = await input.loadEnv(request.integrationSlug);
      const clientId = env[step.client_id_env];
      const clientSecret = env[step.client_secret_env];
      if (!clientId || !clientSecret) {
        throw new AuthBrokerError("missing_credentials", "client credentials are not configured");
      }
      const body: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: input.endpoints.callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      };
      if (request.codeVerifier) body.code_verifier = request.codeVerifier;
      const response = await postForm(fetchImpl, step.token_url, body);
      return { ...outcome, oauth2Step: step, env: mapTokenResponse(step, response, now) };
    }
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────────

/** The OAuth2 steps in a manifest, paired with their index. */
export function oauth2Steps(manifest: IntegrationManifest): AuthOAuth2Step[] {
  return resolveAuthSteps(manifest).filter(
    (step): step is AuthOAuth2Step => step.kind === "oauth2"
  );
}

/**
 * Whether an access token lapses within `withinMs`. A step with no `expires_at_env`, or an env
 * with no recorded expiry, reports false — a non-expiring token must not be refreshed on a guess.
 */
export function credentialsExpireWithin(
  step: AuthOAuth2Step,
  env: Record<string, string>,
  withinSeconds: number,
  now: Date
): boolean {
  const raw = env[oauth2ExpiresAtEnv(step)];
  if (!raw) return false;
  const expiresAt = Date.parse(raw);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - now.getTime() <= withinSeconds * 1000;
}

/** Exchanges the stored refresh token for a fresh access token. */
export async function refreshOAuth2Credentials(
  step: AuthOAuth2Step,
  env: Record<string, string>,
  options: { fetchImpl?: typeof globalThis.fetch; now?: Date } = {}
): Promise<Record<string, string>> {
  const refreshTokenEnv = oauth2RefreshTokenEnv(step);
  const refreshToken = env[refreshTokenEnv];
  // Providers that never issued a refresh token leave nothing to spend. That is the normal state
  // for a long-lived token, not a misconfiguration, so a sweep over every step can call this
  // blindly and get "nothing to do" rather than an error it would have to special-case.
  if (!refreshToken) return {};

  const clientId = env[step.client_id_env];
  const clientSecret = env[step.client_secret_env];
  if (!clientId || !clientSecret) {
    throw new AuthBrokerError("missing_credentials", "refresh requires stored app credentials");
  }
  const response = await postForm(
    options.fetchImpl ?? globalThis.fetch,
    step.refresh_url ?? step.token_url,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }
  );
  // Providers that rotate refresh tokens return a new one; those that don't keep the stored one,
  // so the merge that follows must not blank it out.
  const mapped = mapTokenResponse(step, response, options.now ?? new Date());
  return mapped[refreshTokenEnv] ? mapped : { ...mapped, [refreshTokenEnv]: refreshToken };
}

// ── Endpoint resolution ───────────────────────────────────────────────────────

/** The path every provider redirects back to. Registered with providers, so it must never vary. */
export const INTEGRATION_AUTH_CALLBACK_PATH = "/api/v1/integrations/auth/callback";

/**
 * Providers validate the redirect URI against what was registered, so the callback origin has to be
 * the public API origin — not the web origin `PUBLIC_URL` describes, and not a request-derived host
 * an attacker could spoof via `Host`/`X-Forwarded-Host`.
 */
export function resolveAuthEndpoints(env: NodeJS.ProcessEnv = process.env): AuthEndpoints {
  const apiUrl = (env.PUBLIC_API_URL ?? `http://localhost:${env.PORT ?? 4010}`).replace(/\/+$/, "");
  const webUrl = (env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  return { apiUrl, webUrl, callbackUrl: `${apiUrl}${INTEGRATION_AUTH_CALLBACK_PATH}` };
}
