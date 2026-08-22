import { createHash, randomBytes } from "node:crypto";
import {
  AuthBrokerError,
  type AuthEndpoints,
  asIntegrationEnvValue,
  buildOAuthAuthorizeUrl,
  ingressWebhookUrl,
  integrationAuthEndpointVars,
  readPath,
  renderDeep,
  renderTemplate,
} from "@tulipfarm/integrations";
import type {
  AuthFieldsStep,
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
import type { IntegrationAuthRequestDoc, IntegrationAuthRequestRepo } from "@tulipfarm/storage";
import { DEFAULT_AUTH_REQUEST_TTL_SECONDS } from "@tulipfarm/storage";

export {
  type AuthBrokerDenialReason,
  AuthBrokerError,
  readPath,
  renderDeep,
  renderTemplate,
} from "@tulipfarm/integrations";
export {
  DEFAULT_AUTH_REQUEST_TTL_SECONDS,
  type IntegrationAuthRequestDoc,
  type IntegrationAuthRequestRepo,
  PgIntegrationAuthRequestRepo,
} from "@tulipfarm/storage";

export type AuthStartAction =
  | { action: "collect_fields"; fields: RequiredEnvVar[] }
  | { action: "redirect"; url: string }
  | { action: "form_post"; url: string; field: string; value: string }
  | { action: "completed"; env: Record<string, string> };

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
  /** Target org login for an `app_manifest` step; ignored by steps with no `create_url_for_org`. */
  org?: string;
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

export function buildAuthorizeUrl(
  step: AuthOAuth2Step,
  input: { clientId: string; state: string; codeChallenge?: string; redirectUri: string }
): string {
  if (!step.authorization_url) {
    throw new AuthBrokerError("unknown_step", "oauth2 step has no authorization_url");
  }
  return buildOAuthAuthorizeUrl(
    {
      authorizationUrl: step.authorization_url,
      scopes: step.scopes,
      scopeSeparator: step.scope_separator,
      authorizeParams: step.authorize_params,
    },
    input
  );
}

export { ingressWebhookUrl } from "@tulipfarm/integrations";

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
    ...integrationAuthEndpointVars(input.endpoints, input.env),
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
    const value = asIntegrationEnvValue(readPath(parsed, path));
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

/** Names the `fields` step that owns a missing oauth2 credential, instead of its raw env var. */
function missingCredentialsMessage(input: StartAuthStepInput, step: AuthOAuth2Step): string {
  const owner = resolveAuthSteps(input.manifest).find(
    (candidate): candidate is AuthFieldsStep =>
      candidate.kind === "fields" &&
      candidate.fields.some((field) => field.name === step.client_id_env)
  );
  return owner?.title
    ? `Complete "${owner.title}" first — it supplies this step's credentials.`
    : "An earlier setup step must be completed before this one.";
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
      const org = input.org?.trim();
      const vars = integrationAuthEndpointVars(input.endpoints, input.env);
      // An org can only be targeted through a template the step opts into; a step with no
      // create_url_for_org silently falls back to its personal-account create_url.
      const createUrl = org && step.create_url_for_org ? step.create_url_for_org : step.create_url;
      const url = renderTemplate(createUrl, { ...vars, state, ...(org ? { org } : {}) });
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
      const vars = integrationAuthEndpointVars(input.endpoints, input.env);
      return { action: "redirect", url: renderTemplate(step.url, { ...vars, state }) };
    }

    case "webhook":
      return { action: "completed", env: await registerWebhook(step, input) };

    case "oauth2": {
      const clientId = input.env[step.client_id_env];
      if (!clientId) {
        throw new AuthBrokerError("missing_credentials", missingCredentialsMessage(input, step));
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
  const accessToken = asIntegrationEnvValue(
    readPath(response, step.token_response_path ?? "access_token")
  );
  if (!accessToken) {
    throw new AuthBrokerError("exchange_failed", "token endpoint returned no access token");
  }
  env[step.token_env] = accessToken;

  for (const [path, envName] of Object.entries(step.map ?? {})) {
    const value = asIntegrationEnvValue(readPath(response, path));
    if (value !== undefined) env[envName] = value;
  }

  // Only written when the provider actually returns them: a provider that issues non-expiring
  // tokens must not end up with a fabricated expiry that triggers pointless refreshes.
  const refresh = asIntegrationEnvValue(readPath(response, "refresh_token"));
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
    if (err instanceof AuthBrokerError) {
      err.slug ??= request.integrationSlug;
      err.webUrl ??= request.webUrl ?? input.endpoints.webUrl;
    }
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
      throw new AuthBrokerError("unknown_step", "fields steps do not use the callback");

    case "webhook":
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
        const value = asIntegrationEnvValue(readPath(body, path));
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
