import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpOAuthDiscovery, McpOAuthRegistration } from "@tulipfarm/mcp";
import type { McpAccount, McpAccountSummary } from "@tulipfarm/schema";
import type { McpOAuthBinding, McpOAuthStore } from "@tulipfarm/storage";
import { McpAccountAccessError, type McpAccountRepository } from "./authority";
import type { McpAccountDefinition, McpAccountLifecycle, McpAccountVault } from "./lifecycle";

export type McpOAuthMetadata = McpOAuthDiscovery;
export type McpOAuthClientRegistration = McpOAuthRegistration;

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly scope?: string;
}

export interface McpOAuthProtocol {
  discover(serverUrl: string): Promise<McpOAuthMetadata>;
  register(metadata: McpOAuthMetadata, callbackUrl: string): Promise<McpOAuthClientRegistration>;
  start(input: {
    readonly metadata: McpOAuthMetadata;
    readonly client: McpOAuthClientRegistration;
    readonly callbackUrl: string;
    readonly state: string;
  }): Promise<{ readonly authorizationUrl: string; readonly codeVerifier: string }>;
  exchange(input: {
    readonly metadata: McpOAuthMetadata;
    readonly client: McpOAuthClientRegistration;
    readonly callbackUrl: string;
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<McpOAuthTokens>;
  refresh(input: {
    readonly metadata: McpOAuthMetadata;
    readonly client: McpOAuthClientRegistration;
    readonly refreshToken: string;
  }): Promise<McpOAuthTokens>;
}

interface OAuthSecretScope {
  readonly businessId: string;
  readonly accountId: string;
  readonly accountRevision: number;
  readonly definitionDigest: string;
  readonly principalId: string;
  readonly destination: string;
  readonly purpose: string;
}

export interface McpOAuthVault extends McpAccountVault {
  use<T>(
    bindings: Readonly<Record<string, string>>,
    scope: OAuthSecretScope,
    authorize: () => Promise<void>,
    callback: (values: Readonly<Record<string, string>>) => Promise<T>
  ): Promise<T>;
}

interface OAuthCredential {
  readonly metadata: McpOAuthMetadata;
  readonly client: McpOAuthClientRegistration;
  readonly refreshToken?: string;
  readonly scope?: string;
}

interface OAuthAttemptSecret extends OAuthCredential {
  readonly codeVerifier: string;
}

export interface McpOAuthActor {
  readonly businessId: string;
  readonly principalId: string;
  readonly sessionId: string;
}

export interface McpOAuthLifecycleDeps {
  readonly accounts: McpAccountRepository;
  readonly lifecycle: McpAccountLifecycle;
  readonly attempts: Pick<
    McpOAuthStore,
    | "create"
    | "consume"
    | "claimRefresh"
    | "currentRefresh"
    | "publishRefresh"
    | "failRefresh"
    | "releaseRefresh"
  >;
  readonly secrets: McpOAuthVault;
  readonly protocol: McpOAuthProtocol;
  readonly definition: (
    integrationKey: string
  ) => Promise<McpAccountDefinition & { readonly serverUrl: string }>;
  readonly callbackUrl: (integrationKey: string, accountId: string) => string;
  readonly audit: (input: {
    readonly action: string;
    readonly businessId: string;
    readonly accountId: string;
    readonly principalId: string;
    readonly code?: string;
  }) => Promise<void>;
  readonly now?: () => Date;
}

export class McpOAuthError extends Error {
  constructor(
    readonly code:
      | "oauth_invalid_state"
      | "oauth_issuer_mismatch"
      | "oauth_failed"
      | "oauth_refresh_busy"
      | "oauth_refresh_required"
      | "oauth_invalid_response"
  ) {
    super(code);
    this.name = "McpOAuthError";
  }
}

function stateDigest(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function secretScope(
  account: McpAccount,
  principalId: string,
  destination: string,
  purpose: string
): OAuthSecretScope {
  return {
    businessId: account.businessId,
    accountId: account.id,
    accountRevision: account.revision,
    definitionDigest: account.definitionDigest,
    principalId,
    destination,
    purpose,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredential(value: string): OAuthCredential {
  const input: unknown = JSON.parse(value);
  if (
    !isRecord(input) ||
    !isRecord(input.metadata) ||
    typeof input.metadata.serverUrl !== "string" ||
    typeof input.metadata.resource !== "string" ||
    typeof input.metadata.issuer !== "string" ||
    typeof input.metadata.authorizationEndpoint !== "string" ||
    typeof input.metadata.tokenEndpoint !== "string" ||
    !Array.isArray(input.metadata.codeChallengeMethodsSupported) ||
    !input.metadata.codeChallengeMethodsSupported.every((method) => typeof method === "string") ||
    !isRecord(input.client) ||
    typeof input.client.clientId !== "string" ||
    (input.client.tokenEndpointAuthMethod !== "none" &&
      input.client.tokenEndpointAuthMethod !== "client_secret_basic" &&
      input.client.tokenEndpointAuthMethod !== "client_secret_post") ||
    (input.client.clientSecret !== undefined && typeof input.client.clientSecret !== "string") ||
    (input.refreshToken !== undefined && typeof input.refreshToken !== "string") ||
    (input.scope !== undefined && typeof input.scope !== "string")
  ) {
    throw new McpOAuthError("oauth_invalid_response");
  }
  return {
    metadata: {
      serverUrl: input.metadata.serverUrl,
      resource: input.metadata.resource,
      issuer: input.metadata.issuer,
      authorizationEndpoint: input.metadata.authorizationEndpoint,
      tokenEndpoint: input.metadata.tokenEndpoint,
      codeChallengeMethodsSupported: input.metadata.codeChallengeMethodsSupported,
      ...(input.metadata.scopesSupported === undefined
        ? {}
        : { scopesSupported: stringArray(input.metadata.scopesSupported) }),
      ...(input.metadata.tokenEndpointAuthMethodsSupported === undefined
        ? {}
        : {
            tokenEndpointAuthMethodsSupported: stringArray(
              input.metadata.tokenEndpointAuthMethodsSupported
            ),
          }),
    },
    client: {
      clientId: input.client.clientId,
      tokenEndpointAuthMethod: input.client.tokenEndpointAuthMethod,
      ...(input.client.clientSecret === undefined
        ? {}
        : { clientSecret: input.client.clientSecret }),
    },
    ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new McpOAuthError("oauth_invalid_response");
  }
  return value;
}

function parseAttempt(value: string): OAuthAttemptSecret {
  const credential = parseCredential(value);
  const input: unknown = JSON.parse(value);
  if (!isRecord(input) || typeof input.codeVerifier !== "string") {
    throw new McpOAuthError("oauth_invalid_response");
  }
  return { ...credential, codeVerifier: input.codeVerifier };
}

/** Refresh rotates Secrets for the same pinned account; this class never replays an MCP call. */
export class McpOAuthLifecycle {
  constructor(private readonly deps: McpOAuthLifecycleDeps) {}

  async configuration(
    actor: McpOAuthActor,
    integrationKey: string,
    accountId: string
  ): Promise<{ callbackUrl: string }> {
    await this.managedAccount(actor, integrationKey, accountId);
    return { callbackUrl: this.deps.callbackUrl(integrationKey, accountId) };
  }

  async start(
    actor: McpOAuthActor,
    integrationKey: string,
    accountId: string
  ): Promise<{ authorizationUrl: string }> {
    const { account, definition } = await this.managedAccount(actor, integrationKey, accountId);
    const callbackUrl = this.deps.callbackUrl(integrationKey, accountId);
    const metadata = await this.deps.protocol.discover(definition.serverUrl);
    for (const endpoint of [
      metadata.issuer,
      metadata.authorizationEndpoint,
      metadata.tokenEndpoint,
      ...(metadata.registrationEndpoint ? [metadata.registrationEndpoint] : []),
    ]) {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new McpOAuthError("oauth_invalid_response");
      }
    }
    if (!metadata.codeChallengeMethodsSupported.includes("S256")) {
      throw new McpOAuthError("oauth_invalid_response");
    }
    const begin = async (
      client: McpOAuthClientRegistration
    ): Promise<{ authorizationUrl: string }> => {
      const state = randomBytes(32).toString("base64url");
      const { authorizationUrl, codeVerifier } = await this.deps.protocol.start({
        metadata,
        client,
        callbackUrl,
        state,
      });
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
        throw new McpOAuthError("oauth_invalid_response");
      }
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const pending: McpAccount = {
        ...account,
        definitionDigest: definition.definitionDigest,
        status: "pending",
        revision: account.revision + 1,
        isDefault: false,
        updatedAt: this.now().toISOString(),
      };
      if (!(await this.deps.accounts.save(pending, account.revision))) {
        throw new McpAccountAccessError("conflict");
      }
      const binding: McpOAuthBinding = {
        ...actor,
        integrationKey,
        accountId,
        accountRevision: pending.revision,
        definitionDigest: pending.definitionDigest,
        callbackUrl,
        issuer: metadata.issuer,
      };
      const payload: OAuthAttemptSecret = { metadata, client, codeVerifier };
      const encrypted = await this.deps.secrets.write({ attempt: JSON.stringify(payload) });
      const secretRef = encrypted.attempt;
      if (!secretRef) throw new McpOAuthError("oauth_failed");
      if (
        !(await this.deps.attempts.create({
          stateDigest: stateDigest(state),
          binding,
          secretRef,
          expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
        }))
      ) {
        await this.deps.secrets.remove(encrypted);
        throw new McpAccountAccessError("conflict");
      }
      const redirect = new URL(authorizationUrl);
      const endpoint = new URL(metadata.authorizationEndpoint);
      if (
        redirect.origin !== endpoint.origin ||
        redirect.pathname !== endpoint.pathname ||
        redirect.username ||
        redirect.password ||
        redirect.hash ||
        redirect.searchParams.get("state") !== state ||
        redirect.searchParams.get("code_challenge") !== codeChallenge ||
        redirect.searchParams.get("code_challenge_method") !== "S256" ||
        redirect.searchParams.get("redirect_uri") !== callbackUrl ||
        redirect.searchParams.get("client_id") !== client.clientId ||
        redirect.searchParams.has("client_secret") ||
        redirect.searchParams.has("code_verifier") ||
        redirect.searchParams.get("response_type") !== "code"
      ) {
        throw new McpOAuthError("oauth_invalid_response");
      }
      await this.audit("integration.account.oauth_started", pending, actor.principalId);
      return { authorizationUrl };
    };
    if (!account.oauthClient) {
      return begin(await this.deps.protocol.register(metadata, callbackUrl));
    }
    const registration = account.oauthClient;
    const bindings: Readonly<Record<string, string>> = account.secretBindings.oauthClientSecret
      ? { clientSecret: account.secretBindings.oauthClientSecret }
      : account.secretBindings.oauth
        ? { oauth: account.secretBindings.oauth }
        : {};
    return this.deps.secrets.use(
      bindings,
      secretScope(account, actor.principalId, metadata.tokenEndpoint, "oauth_registration"),
      async () => {
        const current = await this.deps.lifecycle.managed(
          actor.businessId,
          integrationKey,
          accountId,
          actor.principalId
        );
        if (current.revision !== account.revision || current.status === "revoked") {
          throw new McpAccountAccessError("account_binding_changed");
        }
      },
      async (values) => {
        const previous = values.oauth ? parseCredential(values.oauth).client : undefined;
        if (
          previous &&
          (previous.clientId !== registration.clientId ||
            previous.tokenEndpointAuthMethod !== registration.tokenEndpointAuthMethod)
        ) {
          throw new McpOAuthError("oauth_invalid_response");
        }
        const clientSecret = values.clientSecret ?? previous?.clientSecret;
        if (registration.tokenEndpointAuthMethod !== "none" && !clientSecret) {
          throw new McpOAuthError("oauth_refresh_required");
        }
        return begin({
          ...registration,
          ...(clientSecret ? { clientSecret } : {}),
        });
      }
    );
  }

  async complete(
    actor: McpOAuthActor,
    integrationKey: string,
    accountId: string,
    query: {
      readonly state: string;
      readonly code?: string;
      readonly iss?: string;
      readonly error?: string;
    }
  ): Promise<McpAccountSummary> {
    if (!actor.sessionId || !/^[A-Za-z0-9_-]{43}$/.test(query.state)) {
      throw new McpOAuthError("oauth_invalid_state");
    }
    const callbackUrl = this.deps.callbackUrl(integrationKey, accountId);
    const attempt = await this.deps.attempts.consume(
      stateDigest(query.state),
      { ...actor, integrationKey, accountId, callbackUrl },
      this.now()
    );
    if (!attempt) throw new McpOAuthError("oauth_invalid_state");
    const bindings = { attempt: attempt.secretRef };
    try {
      const account = await this.deps.lifecycle.managed(
        actor.businessId,
        integrationKey,
        accountId,
        actor.principalId
      );
      const authorize = () => this.assertPending(account, actor.principalId, attempt.binding);
      await authorize();
      if (query.iss !== undefined && query.iss !== attempt.binding.issuer) {
        throw new McpOAuthError("oauth_issuer_mismatch");
      }
      if (query.error !== undefined || !query.code) throw new McpOAuthError("oauth_failed");
      const code = query.code;
      return await this.deps.secrets.use(
        bindings,
        secretScope(account, actor.principalId, attempt.binding.issuer, "oauth_exchange"),
        authorize,
        async (values) => {
          const secret = parseAttempt(values.attempt ?? "");
          if (secret.metadata.issuer !== attempt.binding.issuer) {
            throw new McpOAuthError("oauth_issuer_mismatch");
          }
          const tokens = await this.deps.protocol.exchange({
            metadata: secret.metadata,
            client: secret.client,
            callbackUrl,
            code,
            codeVerifier: secret.codeVerifier,
          });
          await authorize();
          const expiresAt = this.expiresAt(tokens);
          const credentials = await this.tokenBindings(tokens, secret);
          const next: McpAccount = {
            ...account,
            secretBindings: credentials,
            expiresAt,
            updatedAt: this.now().toISOString(),
          };
          if (!(await this.deps.accounts.save(next, account.revision))) {
            await this.deps.secrets.remove(credentials);
            throw new McpAccountAccessError("conflict");
          }
          await this.deps.secrets.remove(account.secretBindings);
          return this.deps.lifecycle.verify(next, actor.principalId);
        }
      );
    } catch (error) {
      const current = await this.deps.accounts.get(actor.businessId, accountId);
      if (current?.status === "pending" && current.revision === attempt.binding.accountRevision) {
        await this.deps.accounts.save(
          { ...current, status: "action_required", updatedAt: this.now().toISOString() },
          current.revision
        );
      }
      await this.deps.audit({
        action: "integration.account.oauth_failed",
        businessId: actor.businessId,
        accountId,
        principalId: actor.principalId,
        code: error instanceof McpAccountAccessError ? error.code : "oauth_failed",
      });
      if (error instanceof McpAccountAccessError || error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("oauth_failed");
    } finally {
      await this.deps.secrets.remove(bindings);
    }
  }

  async refresh(
    account: McpAccount,
    principalId: string,
    authorize: () => Promise<void>
  ): Promise<void> {
    await authorize();
    if (account.authentication !== "oauth" || !account.secretBindings.oauth) {
      throw new McpOAuthError("oauth_refresh_required");
    }
    const claim = await this.deps.attempts.claimRefresh(
      account.businessId,
      account.id,
      account.revision,
      randomUUID(),
      this.now(),
      new Date(this.now().getTime() + 60_000)
    );
    if (!claim) throw new McpOAuthError("oauth_refresh_busy");
    const assertClaim = async () => {
      await authorize();
      const definition = await this.deps.definition(account.integrationKey);
      const current = await this.deps.accounts.get(account.businessId, account.id);
      if (
        definition.definitionDigest !== account.definitionDigest ||
        current?.secretBindings.oauth !== account.secretBindings.oauth ||
        !(await this.deps.attempts.currentRefresh(claim, this.now()))
      ) {
        throw new McpAccountAccessError("account_binding_changed");
      }
    };
    let dispatched = false;
    let published = false;
    try {
      await this.deps.secrets.use(
        { oauth: account.secretBindings.oauth },
        secretScope(account, principalId, account.definitionDigest, "oauth_refresh"),
        assertClaim,
        async (values) => {
          const credential = parseCredential(values.oauth ?? "");
          if (!credential.refreshToken) throw new McpOAuthError("oauth_refresh_required");
          dispatched = true;
          const tokens = await this.deps.protocol.refresh({
            metadata: credential.metadata,
            client: credential.client,
            refreshToken: credential.refreshToken,
          });
          await assertClaim();
          if (
            tokens.scope
              ?.split(/\s+/)
              .some((scope) => !(credential.scope ?? "").split(/\s+/).includes(scope))
          ) {
            throw new McpOAuthError("oauth_invalid_response");
          }
          const expiresAt = this.expiresAt(tokens);
          const bindings = await this.tokenBindings(tokens, credential);
          const next: McpAccount = {
            ...account,
            secretBindings: bindings,
            expiresAt,
            updatedAt: this.now().toISOString(),
          };
          if (!(await this.deps.attempts.publishRefresh(claim, next, this.now()))) {
            await this.deps.secrets.remove(bindings);
            throw new McpAccountAccessError("conflict");
          }
          published = true;
          await this.deps.secrets.remove(account.secretBindings);
          await this.audit("integration.account.oauth_refreshed", account, principalId);
        }
      );
    } catch (error) {
      if (dispatched && !published) {
        await this.deps.attempts.failRefresh(claim, account.secretBindings.oauth, this.now());
      }
      await this.audit("integration.account.oauth_refresh_failed", account, principalId);
      if (error instanceof McpAccountAccessError || error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("oauth_failed");
    } finally {
      await this.deps.attempts.releaseRefresh(claim);
    }
  }

  private async managedAccount(actor: McpOAuthActor, integrationKey: string, accountId: string) {
    if (!actor.sessionId) throw new McpOAuthError("oauth_invalid_state");
    const account = await this.deps.lifecycle.managed(
      actor.businessId,
      integrationKey,
      accountId,
      actor.principalId
    );
    const definition = await this.deps.definition(integrationKey);
    if (account.definitionDigest !== definition.definitionDigest) {
      throw new McpAccountAccessError("definition_changed");
    }
    if (
      account.authentication !== "oauth" ||
      definition.authentication !== "oauth" ||
      account.status === "revoked" ||
      (account.owner.scope === "shared" && !definition.sharedAllowed)
    ) {
      throw new McpAccountAccessError("account_unavailable");
    }
    return { account, definition };
  }

  private async assertPending(
    account: McpAccount,
    principalId: string,
    binding: McpOAuthBinding
  ): Promise<void> {
    const current = await this.deps.lifecycle.managed(
      account.businessId,
      account.integrationKey,
      account.id,
      principalId
    );
    const definition = await this.deps.definition(account.integrationKey);
    if (
      current.status !== "pending" ||
      current.revision !== binding.accountRevision ||
      current.definitionDigest !== binding.definitionDigest ||
      definition.definitionDigest !== binding.definitionDigest
    ) {
      throw new McpAccountAccessError("account_binding_changed");
    }
  }

  private tokenBindings(tokens: McpOAuthTokens, previous: OAuthCredential) {
    if (
      !tokens.accessToken ||
      tokens.accessToken.length > 16_384 ||
      /[\r\n]/.test(tokens.accessToken) ||
      (tokens.refreshToken !== undefined &&
        (!tokens.refreshToken || tokens.refreshToken.length > 16_384)) ||
      (tokens.scope !== undefined && tokens.scope.length > 16_384)
    ) {
      throw new McpOAuthError("oauth_invalid_response");
    }
    const credential: OAuthCredential = {
      metadata: previous.metadata,
      client: previous.client,
      ...((tokens.refreshToken ?? previous.refreshToken)
        ? { refreshToken: tokens.refreshToken ?? previous.refreshToken }
        : {}),
      ...((tokens.scope ?? previous.scope) ? { scope: tokens.scope ?? previous.scope } : {}),
    };
    return this.deps.secrets.write({
      accessToken: tokens.accessToken,
      oauth: JSON.stringify(credential),
    });
  }

  private expiresAt(tokens: McpOAuthTokens): string | null {
    if (tokens.expiresIn === undefined) return null;
    if (
      !Number.isFinite(tokens.expiresIn) ||
      tokens.expiresIn <= 0 ||
      tokens.expiresIn > 31_536_000
    ) {
      throw new McpOAuthError("oauth_invalid_response");
    }
    return new Date(this.now().getTime() + tokens.expiresIn * 1000).toISOString();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private audit(action: string, account: McpAccount, principalId: string): Promise<void> {
    return this.deps.audit({
      action,
      businessId: account.businessId,
      accountId: account.id,
      principalId,
    });
  }
}
