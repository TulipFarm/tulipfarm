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
import {
  DEFAULT_AUTH_REQUEST_TTL_SECONDS,
  type IntegrationAuthRequestDoc,
  type IntegrationAuthRequestRepo,
} from "./auth-request-repo";

export {
  DEFAULT_AUTH_REQUEST_TTL_SECONDS,
  type IntegrationAuthRequestDoc,
  type IntegrationAuthRequestRepo,
  PgIntegrationAuthRequestRepo,
} from "./auth-request-repo";

/**
 * Generic manifest-declared auth broker: one stable callback for every Integration.
 * One-use server-side state holds PKCE verifier and is consumed exactly once.
 */

/**
 * Substitutes `{name}` placeholders. Unknown placeholders are left untouched rather than blanked,
 * so a manifest typo surfaces as a visibly wrong URL instead of a silently truncated one.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

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

export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asEnvValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export type AuthBrokerDenialReason =
  | "unknown_step"
  | "invalid_state"
  | "missing_credentials"
  | "exchange_failed";

export class AuthBrokerError extends Error {
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

/** Browser instruction for the next auth step; `collect_fields` has no provider round trip. */
export type AuthStartAction =
  | { action: "collect_fields"; fields: RequiredEnvVar[] }
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  /** Server-side steps return only browser action; env is sealed server-side. */
  | { action: "completed"; env: Record<string, string> };

export interface AuthEndpoints {
  callbackUrl: string;
  webUrl: string;
  apiUrl: string;
}

export interface StartAuthStepInput {
  slug: string;
  manifest: IntegrationManifest;
  stepIndex: number;
  env: Record<string, string>;
  endpoints: AuthEndpoints;
  repo: IntegrationAuthRequestRepo;
  ttlSeconds?: number;
  now?: () => Date;
  /** User-scoped connect is allowed only for personal OAuth2 steps; never downgrade to shared. */
  fetchImpl?: typeof globalThis.fetch;
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
    callbackUrl: input.endpoints.callbackUrl,
    webUrl: input.endpoints.webUrl,
    apiUrl: input.endpoints.apiUrl,
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

/** Delivery URL is derived from the API origin so it matches the served hook route. */
export function ingressWebhookUrl(endpoints: AuthEndpoints, slug: string): string {
  return `${endpoints.apiUrl.replace(/\/+$/, "")}/api/v1/hooks/integrations/${slug}`;
}

/**
 * Webhook steps mint the delivery secret, register the hook, and keep returned ids.
 * Non-2xx or `{ ok: false }` writes no env, avoiding half-connected integrations.
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
    // Templated env cannot make credential-bearing webhook calls plaintext or file URLs.
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
    // A non-JSON provider response is still an answer; treat the body as empty.
    return {};
  }
}

/** Prepares one step, persisting the one-use state any provider round trip will come back with. */
export async function startAuthStep(input: StartAuthStepInput): Promise<AuthStartAction> {
  const step = stepAt(input.manifest, input.stepIndex);

  // Personal credentials must come from personal steps; grant type alone is insufficient.
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

export interface CompleteAuthStepInput {
  query: Record<string, string>;
  loadManifest: (slug: string) => IntegrationManifest | undefined;
  loadEnv: (slug: string) => Promise<Record<string, string>>;
  endpoints: AuthEndpoints;
  repo: IntegrationAuthRequestRepo;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface AuthStepOutcome {
  slug: string;
  stepIndex: number;
  webUrl: string;
  /** Present means seal under that principal, never into shared `connection.yaml`. */
  env: Record<string, string>;
  principal?: { readonly kind: string; readonly id: string };
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
    webUrl: request.webUrl ?? input.endpoints.webUrl,
    ...(request.principal === null ? {} : { principal: request.principal }),
  };

  try {
    return await completeStep({ input, request, manifest, fetchImpl, now, outcome });
  } catch (err) {
    // After state consume, failures can be shown on the Integration page.
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
      // Server-side registration has no provider callback; such state is forged or stale.
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
        redirect_uri: request.callbackUrl ?? input.endpoints.callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      };
      if (request.codeVerifier) body.code_verifier = request.codeVerifier;
      const response = await postForm(fetchImpl, step.token_url, body);
      return { ...outcome, oauth2Step: step, env: mapTokenResponse(step, response, now) };
    }
  }
}

/** No `expires_at_env` or recorded expiry means non-expiring; never refresh on a guess. */
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
  // Missing refresh token is normal for long-lived tokens; sweep callers can no-op.
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
  // Preserve stored refresh tokens when providers do not rotate them.
  const mapped = mapTokenResponse(step, response, options.now ?? new Date());
  return mapped[refreshTokenEnv] ? mapped : { ...mapped, [refreshTokenEnv]: refreshToken };
}

/** The path every provider redirects back to. Registered with providers, so it must never vary. */
export const INTEGRATION_AUTH_CALLBACK_PATH = "/api/v1/integrations/auth/callback";

/** Redirect origin must be PUBLIC_API_URL, never web origin or spoofable request host. */
export function resolveAuthEndpoints(env: NodeJS.ProcessEnv = process.env): AuthEndpoints {
  const apiUrl = (env.PUBLIC_API_URL ?? `http://localhost:${env.PORT ?? 4010}`).replace(/\/+$/, "");
  const webUrl = (env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  return { apiUrl, webUrl, callbackUrl: `${apiUrl}${INTEGRATION_AUTH_CALLBACK_PATH}` };
}
