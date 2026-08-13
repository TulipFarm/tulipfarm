import type { AuthOAuth2Step, AuthStep, IntegrationGrant, IntegrationManifest } from "./types";

/*
 * One reading of an integration's connect flow. Manifests may declare the ordered `auth` step
 * list, or only the legacy `required_env` / `oauth` fields that predate it — every consumer (the
 * connect route, the auth broker, the connect UI, integration-forge) resolves through here so a
 * legacy manifest never needs a second code path.
 *
 * `install_manifest` is deliberately NOT derived into an `app_manifest` step: the legacy field
 * carries only the app definition, not the provider URL to submit it to, and inventing one would
 * be guessing. Those manifests keep their paste-the-JSON rendering until they declare `auth`.
 */

/**
 * Where a rotated refresh token is stored. Derived from `token_env` unless the manifest overrides
 * it — a name nobody outside TulipFarm ever sees is not worth making every author declare.
 */
export function oauth2RefreshTokenEnv(step: AuthOAuth2Step): string {
  return step.refresh_token_env ?? `${step.token_env}_REFRESH_TOKEN`;
}

/** Where the absolute ISO access-token expiry is stored. Derived like the refresh token env. */
export function oauth2ExpiresAtEnv(step: AuthOAuth2Step): string {
  return step.expires_at_env ?? `${step.token_env}_EXPIRES_AT`;
}

/**
 * Whether this step can mint a credential representing **the authorizing person** rather than the
 * installation.
 *
 * The discriminator is the explicit `personal: true`, **not** the grant type. OAuth2 says how a
 * token was obtained and nothing about whose access it carries: Slack's "Install to your
 * workspace" step is `authorization_code` and returns a workspace *bot* token with bot scopes.
 * Inferring "personal" from the grant would seal that shared token under one person's name — the
 * whole bot's reach attributed to them in the audit trail, and every Tool acting "as the human" in
 * fact acting as the bot. Undeclared means not personal, so a manifest that never considered the
 * question cannot answer it by accident.
 *
 * Lives here, beside `resolveAuthSteps`, because every consumer must read the identical test: the
 * connect route that refuses to issue a user-scoped state, and the Tool compiler that decides a
 * Tool may demand a personal credential. A Tool that refuses a call for want of a credential the
 * connect route would not issue is a dead end for whoever reads the refusal.
 */
export function isPersonalCredentialStep(step: AuthStep): boolean {
  return (
    step.kind === "oauth2" &&
    (step.grant ?? "authorization_code") === "authorization_code" &&
    step.personal === true
  );
}

/** The ordered connect flow for a manifest, whether it declares `auth` or the legacy fields. */
export function resolveAuthSteps(manifest: IntegrationManifest): AuthStep[] {
  if (manifest.auth) return manifest.auth;

  const steps: AuthStep[] = [];
  const fields = manifest.required_env ?? [];
  if (fields.length > 0) steps.push({ kind: "fields", fields });

  const oauth = manifest.oauth;
  const authorizationCode = oauth?.flows.authorizationCode;
  const flow = authorizationCode ?? oauth?.flows.clientCredentials;
  if (oauth && flow) {
    const tf = oauth["x-tulipfarm"];
    steps.push({
      kind: "oauth2",
      grant: authorizationCode ? "authorization_code" : "client_credentials",
      authorization_url: flow.authorizationUrl,
      token_url: flow.tokenUrl,
      scopes: Object.keys(flow.scopes ?? {}),
      client_id_env: tf.client_id_env,
      client_secret_env: tf.client_secret_env,
      token_env: tf.token_env,
      token_response_path: tf.token_response_path,
    });
  }
  return steps;
}

/**
 * Connection env vars holding secret material. These are sealed into the secrets store and the
 * `connection.yaml` committed to the user's soul repo carries only a `secret://` reference.
 * OAuth2 tokens and client secrets are secret by definition; a `fields` step marks its own; an
 * `app_manifest` exchange names which of its mapped values are credentials rather than config.
 */
export function authSecretEnvNames(manifest: IntegrationManifest): Set<string> {
  const names = new Set<string>();
  for (const step of resolveAuthSteps(manifest)) {
    switch (step.kind) {
      case "fields":
        for (const field of step.fields) {
          if (field.secret) names.add(field.name);
        }
        break;
      case "app_manifest":
        for (const name of step.exchange?.secret_envs ?? []) names.add(name);
        break;
      case "oauth2":
        names.add(step.token_env);
        names.add(step.client_secret_env);
        // Derived, not `step.refresh_token_env`: the refresh token is written whenever the
        // provider returns one, so sealing must cover the same name the broker writes or a live
        // credential lands in the committed connection.yaml.
        names.add(oauth2RefreshTokenEnv(step));
        break;
      case "install":
        break;
      case "webhook":
        // The delivery secret authenticates every inbound webhook. Sealing it matters more than
        // most: unlike a token it is *ours*, so a leak lets anyone forge deliveries as the provider.
        if (step.secret_env) names.add(step.secret_env);
        break;
    }
  }

  // Fail-safe for the legacy block: it names credentials directly, and manifests exist that
  // declare it with no usable `flows` entry — which resolves to no oauth2 step at all. Sealing an
  // env var that turns out to be unused costs nothing; missing one writes a live credential into
  // the connection.yaml committed to the user's soul repo.
  const legacy = manifest.oauth?.["x-tulipfarm"];
  if (legacy) {
    names.add(legacy.token_env);
    names.add(legacy.client_secret_env);
  }
  return names;
}

/** Every connection env var the flow reads or writes, in declaration order. */
export function authEnvNames(manifest: IntegrationManifest): string[] {
  const names: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const step of resolveAuthSteps(manifest)) {
    switch (step.kind) {
      case "fields":
        for (const field of step.fields) add(field.name);
        break;
      case "app_manifest":
        for (const env of Object.values(step.exchange?.map ?? {})) add(env);
        break;
      case "oauth2":
        add(step.client_id_env);
        add(step.client_secret_env);
        add(step.token_env);
        for (const env of Object.values(step.map ?? {})) add(env);
        add(oauth2RefreshTokenEnv(step));
        add(oauth2ExpiresAtEnv(step));
        break;
      case "install":
        for (const env of Object.values(step.capture ?? {})) add(env);
        break;
      case "webhook":
        add(step.secret_env);
        for (const env of Object.values(step.map ?? {})) add(env);
        break;
    }
  }
  return names;
}

/**
 * Every `{name}` placeholder in a step's URL and body, so the validator can prove each one is
 * supplied. Matches the broker's substitution pattern exactly — a validator that recognised a
 * different placeholder syntax would approve a manifest the broker then fails to render.
 */
function templateVars(url: string, body: unknown): Set<string> {
  const names = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const [, name] of value.matchAll(/\{([A-Za-z0-9_.]+)\}/g)) names.add(name);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) scan(item);
    }
  };
  scan(url);
  scan(body);
  return names;
}

/**
 * Structural problems that would only surface mid-connect — an OAuth2 step with no authorize URL,
 * a step reading an env var nothing ever writes. Returned as messages rather than thrown so the
 * loader can reject one bad integration without taking the whole Soul down.
 */
export function validateAuthSteps(manifest: IntegrationManifest): string[] {
  const issues: string[] = [];
  const steps = manifest.auth;
  if (!steps) return issues;

  // Env vars an operator or an earlier step has supplied by the time each step runs.
  const available = new Set<string>();
  steps.forEach((step, index) => {
    const at = `auth[${index}] (${step.kind})`;
    switch (step.kind) {
      case "fields":
        if (step.fields.length === 0) issues.push(`${at}: declares no fields`);
        for (const field of step.fields) available.add(field.name);
        break;
      case "app_manifest":
        if (!step.create_url) issues.push(`${at}: create_url missing`);
        if (!step.manifest_param) issues.push(`${at}: manifest_param missing`);
        for (const env of Object.values(step.exchange?.map ?? {})) available.add(env);
        for (const env of step.exchange?.secret_envs ?? []) {
          if (!Object.values(step.exchange?.map ?? {}).includes(env)) {
            issues.push(`${at}: secret_envs names "${env}", which exchange.map never writes`);
          }
        }
        break;
      case "oauth2":
        if (!step.token_url) issues.push(`${at}: token_url missing`);
        if (
          (step.grant ?? "authorization_code") === "authorization_code" &&
          !step.authorization_url
        ) {
          issues.push(`${at}: authorization_url is required for the authorization_code grant`);
        }
        for (const env of [step.client_id_env, step.client_secret_env]) {
          if (!env) {
            issues.push(`${at}: client_id_env and client_secret_env are required`);
          } else if (!available.has(env)) {
            issues.push(`${at}: reads "${env}", which no earlier step supplies`);
          }
        }
        if (!step.token_env) issues.push(`${at}: token_env missing`);
        available.add(step.token_env);
        if (step.refresh_token_env) available.add(step.refresh_token_env);
        if (step.expires_at_env) available.add(step.expires_at_env);
        break;
      case "install":
        if (!step.url) issues.push(`${at}: url missing`);
        for (const env of Object.values(step.capture ?? {})) available.add(env);
        break;
      case "webhook": {
        if (!step.url) issues.push(`${at}: url missing`);
        // The secret is generated by this step, so it is available to its own templates.
        if (step.secret_env) available.add(step.secret_env);
        for (const name of templateVars(step.url, step.body)) {
          if (name === "webhook_url" || available.has(name)) continue;
          issues.push(`${at}: reads "${name}", which no earlier step supplies`);
        }
        const security = manifest.ingress?.webhook.security;
        if (step.secret_env && security && security.secret_env !== step.secret_env) {
          // Registering under one name and verifying under another rejects every delivery with a
          // signature error — a failure that looks like the provider's fault and never resolves.
          issues.push(
            `${at}: registers secret_env "${step.secret_env}" but ingress verifies ` +
              `"${security.secret_env}"`
          );
        }
        for (const env of Object.values(step.map ?? {})) available.add(env);
        break;
      }
    }
  });
  return issues;
}

/**
 * Whether a step has already produced everything it exists to produce. Optional outputs — a
 * refresh token, an expiry, a value the provider may or may not return — are deliberately not
 * counted: a step must not look unfinished because a provider chose not to send something.
 */
export function authStepSatisfied(step: AuthStep, env: Record<string, string>): boolean {
  const has = (name: string) => Boolean(env[name]);
  switch (step.kind) {
    case "fields":
      return step.fields.every((field) => has(field.name));
    case "app_manifest":
      // A step with no exchange writes nothing; it is done the moment the operator returns.
      return Object.values(step.exchange?.map ?? {}).every(has);
    case "oauth2":
      return has(step.token_env);
    case "install":
      return Object.values(step.capture ?? {}).every(has);
    case "webhook":
      return (
        (step.secret_env === undefined || has(step.secret_env)) &&
        Object.values(step.map ?? {}).every(has)
      );
  }
}

/**
 * Whether completing this step writes connection env, i.e. whether we can observe that it
 * happened. A step that produces nothing — Slack's "create the app", which has no exchange
 * because Slack has no manifest-to-credentials API — is indistinguishable from one never started,
 * so it is `satisfied` from the moment it is declared and callers that walk an operator through
 * the flow must not treat that as done.
 */
export function authStepProducesEnv(step: AuthStep): boolean {
  switch (step.kind) {
    case "fields":
      return step.fields.length > 0;
    case "app_manifest":
      return Object.keys(step.exchange?.map ?? {}).length > 0;
    case "oauth2":
      return true;
    case "install":
      return Object.keys(step.capture ?? {}).length > 0;
    case "webhook":
      return step.secret_env !== undefined || Object.keys(step.map ?? {}).length > 0;
  }
}

/** The first step still waiting on the operator, or `null` when the flow is complete. */
export function nextAuthStep(
  manifest: IntegrationManifest,
  env: Record<string, string>
): { index: number; step: AuthStep } | null {
  const steps = resolveAuthSteps(manifest);
  const index = steps.findIndex((step) => !authStepSatisfied(step, env));
  return index === -1 ? null : { index, step: steps[index] };
}

/**
 * Whether every declared step is satisfied — the one definition of "connected". A manifest that
 * declares no credentials at all is satisfied trivially, which is what makes a no-auth integration
 * connect in a single call.
 */
export function authFlowSatisfied(
  manifest: IntegrationManifest,
  env: Record<string, string>
): boolean {
  return nextAuthStep(manifest, env) === null;
}

/**
 * Vars a classifier may be told, checked against what the flow treats as credential material.
 *
 * Rejected rather than filtered at forward time: a manifest that asks for a secret is stating an
 * intent this framework does not grant, and silently handing it an empty value would leave the
 * author debugging a classifier that never sees what they declared.
 */
export function validateIngressContextEnv(manifest: IntegrationManifest): string[] {
  const declared = manifest.ingress?.context_env ?? [];
  if (declared.length === 0) return [];
  const secrets = authSecretEnvNames(manifest);
  return declared
    .filter((name) => secrets.has(name))
    .map(
      (name) =>
        `ingress.context_env names "${name}", which the auth flow stores as a secret; a sandboxed classifier is never given credentials`
    );
}

/**
 * The authority an integration asks for, as shown to an operator deciding whether to connect.
 *
 * An explicit `grants` list wins; otherwise this is the union of every `oauth2` step's `scopes`,
 * which is real declared data rather than authored copy. Deriving covers the common case for free
 * and cannot drift, but it cannot cover every provider: a GitHub App's permissions live inside the
 * opaque `app_manifest` blob, which is provider-defined and deliberately not interpreted here —
 * parsing `default_permissions` would put a provider's vocabulary in a generic resolver, which is
 * exactly what declaring `auth` steps was meant to stop. Those manifests declare `grants` by hand
 * and a test pins the two together.
 *
 * An empty result means "no authority to review" — a bot-token integration like Telegram — not
 * "unknown". Callers should render nothing rather than an empty section.
 */
export function resolveGrants(manifest: IntegrationManifest): IntegrationGrant[] {
  if (manifest.grants?.length) return manifest.grants;
  const seen = new Set<string>();
  const derived: IntegrationGrant[] = [];
  for (const step of resolveAuthSteps(manifest)) {
    if (step.kind !== "oauth2") continue;
    for (const scope of step.scopes ?? []) {
      // A provider may ask for the same scope across two steps — Slack lists its bot scopes in the
      // app manifest and again on the authorize URL. Showing an operator the same grant twice
      // reads as though more is being asked for than actually is.
      if (seen.has(scope)) continue;
      seen.add(scope);
      derived.push({ label: scope });
    }
  }
  return derived;
}
