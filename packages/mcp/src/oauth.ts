import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { McpError } from "./errors";
import type { McpRemoteTransport, McpRequestOptions } from "./types";

export type McpOAuthUrlPurpose =
  | "metadata"
  | "issuer"
  | "resource"
  | "authorization"
  | "token"
  | "registration"
  | "redirect";

export interface McpOAuthOptions {
  readonly fetch: McpRemoteTransport["fetch"];
  readonly validateUrl: (url: string, purpose: McpOAuthUrlPurpose) => Promise<void>;
}

export interface McpOAuthDiscovery {
  readonly serverUrl: string;
  readonly resource: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scopesSupported?: readonly string[];
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
}

export type McpOAuthClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

function isClientAuthMethod(value: string): value is McpOAuthClientAuthMethod {
  return value === "none" || value === "client_secret_basic" || value === "client_secret_post";
}

export interface McpOAuthRegistration {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod: McpOAuthClientAuthMethod;
  readonly clientSecretExpiresAt?: number;
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly scope?: string;
}

export interface McpOAuthStart {
  readonly discovery: McpOAuthDiscovery;
  readonly client: McpOAuthRegistration;
  readonly redirectUri: string;
  readonly state: string;
  readonly scope?: string;
}

export interface McpOAuthExchange {
  readonly discovery: McpOAuthDiscovery;
  readonly client: McpOAuthRegistration;
  readonly redirectUri: string;
  readonly authorizationCode: string;
  readonly codeVerifier: string;
}

export class McpOAuthError extends McpError {
  constructor(
    readonly reason:
      | "invalid_grant"
      | "invalid_client"
      | "invalid_scope"
      | "access_denied"
      | "unsupported"
      | "oauth_failure"
  ) {
    super("authentication_required");
    this.name = "McpOAuthError";
  }
}

function secureUrl(value: string, allowLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError("invalid_configuration");
  }
  const loopback =
    allowLoopback &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new McpError("access_denied");
  }
  return url;
}

function metadata(discovery: McpOAuthDiscovery): OAuthMetadata {
  if (!discovery.codeChallengeMethodsSupported.includes("S256")) {
    throw new McpOAuthError("unsupported");
  }
  return {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorizationEndpoint,
    token_endpoint: discovery.tokenEndpoint,
    response_types_supported: ["code"],
    code_challenge_methods_supported: [...discovery.codeChallengeMethodsSupported],
    ...(discovery.registrationEndpoint
      ? { registration_endpoint: discovery.registrationEndpoint }
      : {}),
    ...(discovery.tokenEndpointAuthMethodsSupported
      ? {
          token_endpoint_auth_methods_supported: [...discovery.tokenEndpointAuthMethodsSupported],
        }
      : {}),
  };
}

function clientInformation(discovery: McpOAuthDiscovery, client: McpOAuthRegistration) {
  if (!client.clientId || (client.tokenEndpointAuthMethod !== "none" && !client.clientSecret)) {
    throw new McpError("invalid_configuration");
  }
  if (
    discovery.tokenEndpointAuthMethodsSupported?.length &&
    !discovery.tokenEndpointAuthMethodsSupported.includes(client.tokenEndpointAuthMethod)
  ) {
    throw new McpOAuthError("unsupported");
  }
  return {
    client_id: client.clientId,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  };
}

function tokens(value: OAuthTokens): McpOAuthTokens {
  if (
    value.token_type.toLowerCase() !== "bearer" ||
    (value.expires_in !== undefined &&
      (!Number.isFinite(value.expires_in) || value.expires_in <= 0))
  ) {
    throw new McpOAuthError("unsupported");
  }
  return {
    accessToken: value.access_token,
    tokenType: value.token_type,
    ...(value.refresh_token ? { refreshToken: value.refresh_token } : {}),
    ...(value.expires_in !== undefined ? { expiresIn: value.expires_in } : {}),
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
  };
}

export class McpOAuthClient {
  constructor(private readonly options: McpOAuthOptions) {}

  private async url(value: string, purpose: McpOAuthUrlPurpose): Promise<URL> {
    const url = secureUrl(value, purpose === "redirect");
    try {
      await this.options.validateUrl(url.href, purpose);
    } catch {
      throw new McpError("access_denied");
    }
    return url;
  }

  private async validate(discovery: McpOAuthDiscovery): Promise<void> {
    const server = await this.url(discovery.serverUrl, "resource");
    const resource = await this.url(discovery.resource, "resource");
    if (!checkResourceAllowed({ requestedResource: server, configuredResource: resource })) {
      throw new McpError("identity_mismatch");
    }
    const issuer = await this.url(discovery.issuer, "issuer");
    if (issuer.search) throw new McpError("invalid_configuration");
    await this.url(discovery.authorizationEndpoint, "authorization");
    await this.url(discovery.tokenEndpoint, "token");
    if (discovery.registrationEndpoint)
      await this.url(discovery.registrationEndpoint, "registration");
    metadata(discovery);
  }

  private async run<T>(
    request: McpRequestOptions,
    action: (fetch: McpRemoteTransport["fetch"]) => Promise<T>,
    purpose: McpOAuthUrlPurpose
  ): Promise<T> {
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([timeout, ...(request.signal ? [request.signal] : [])]);
    let count = 0;
    const fetch: McpRemoteTransport["fetch"] = async (value, init) => {
      signal.throwIfAborted();
      if (++count > 8) throw new McpError("discovery_limit");
      const url = await this.url(String(value), purpose);
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          ...init,
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        });
      } catch (error) {
        if (signal.aborted) throw new McpError(timeout.aborted ? "timeout" : "cancelled");
        throw error instanceof McpError ? error : new McpError("transport_failure");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new McpError("access_denied");
      }
      if (purpose === "metadata" && !response.ok && response.status !== 404) {
        await response.body?.cancel();
        throw new McpError("protocol_failure", "none", { httpStatus: response.status });
      }
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 128 * 1024) {
              controller.error(new McpError("response_limit"));
              return;
            }
            controller.enqueue(chunk);
          },
        })
      );
      return new Response(body, { status: response.status, headers: response.headers });
    };
    let listener: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      return await Promise.race([
        action(fetch),
        new Promise<never>((_, reject) => {
          listener = () => reject(new McpError(timeout.aborted ? "timeout" : "cancelled"));
          signal.addEventListener("abort", listener, { once: true });
          if (signal.aborted) listener();
        }),
      ]);
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (signal.aborted) throw new McpError(timeout.aborted ? "timeout" : "cancelled");
      if (error instanceof OAuthError) {
        switch (error.errorCode) {
          case "invalid_grant":
          case "invalid_client":
          case "invalid_scope":
          case "access_denied":
            throw new McpOAuthError(error.errorCode);
        }
      }
      throw new McpOAuthError("oauth_failure");
    } finally {
      if (listener) signal.removeEventListener("abort", listener);
    }
  }

  async discover(
    input: {
      readonly serverUrl: string;
      readonly issuer?: string;
      readonly resourceMetadataUrl?: string;
    },
    request: McpRequestOptions = {}
  ): Promise<McpOAuthDiscovery> {
    return this.run(
      request,
      async (fetch) => {
        const server = await this.url(input.serverUrl, "resource");
        const protectedMetadata = await discoverOAuthProtectedResourceMetadata(
          server,
          {
            ...(input.resourceMetadataUrl
              ? { resourceMetadataUrl: input.resourceMetadataUrl }
              : {}),
          },
          fetch
        );
        const issuers = protectedMetadata.authorization_servers ?? [];
        const issuer = input.issuer ?? (issuers.length === 1 ? issuers[0] : undefined);
        if (!issuer || !issuers.includes(issuer)) throw new McpOAuthError("unsupported");
        await this.url(issuer, "issuer");
        const discovered = await discoverAuthorizationServerMetadata(issuer, { fetchFn: fetch });
        if (
          !discovered ||
          secureUrl(discovered.issuer).href !== secureUrl(issuer).href ||
          !discovered.response_types_supported.includes("code") ||
          !discovered.code_challenge_methods_supported?.includes("S256")
        ) {
          throw new McpOAuthError("unsupported");
        }
        const result: McpOAuthDiscovery = {
          serverUrl: server.href,
          resource: protectedMetadata.resource,
          issuer: discovered.issuer,
          authorizationEndpoint: discovered.authorization_endpoint,
          tokenEndpoint: discovered.token_endpoint,
          codeChallengeMethodsSupported: discovered.code_challenge_methods_supported,
          ...(discovered.registration_endpoint
            ? { registrationEndpoint: discovered.registration_endpoint }
            : {}),
          ...(discovered.scopes_supported ? { scopesSupported: discovered.scopes_supported } : {}),
          ...(discovered.token_endpoint_auth_methods_supported
            ? {
                tokenEndpointAuthMethodsSupported: discovered.token_endpoint_auth_methods_supported,
              }
            : {}),
        };
        await this.validate(result);
        return result;
      },
      "metadata"
    );
  }

  async start(
    input: McpOAuthStart,
    request: McpRequestOptions = {}
  ): Promise<{
    readonly authorizationUrl: string;
    readonly codeVerifier: string;
  }> {
    return this.run(
      request,
      async () => {
        await this.validate(input.discovery);
        await this.url(input.redirectUri, "redirect");
        if (!input.state || input.state.length > 2048) throw new McpError("invalid_configuration");
        const result = await startAuthorization(input.discovery.issuer, {
          metadata: metadata(input.discovery),
          clientInformation: clientInformation(input.discovery, input.client),
          redirectUrl: input.redirectUri,
          state: input.state,
          scope: input.scope,
          resource: secureUrl(input.discovery.resource),
        });
        return {
          authorizationUrl: result.authorizationUrl.href,
          codeVerifier: result.codeVerifier,
        };
      },
      "authorization"
    );
  }

  async register(
    input: {
      readonly discovery: McpOAuthDiscovery;
      readonly redirectUri: string;
      readonly clientName: string;
      readonly scope?: string;
      readonly tokenEndpointAuthMethod?: McpOAuthClientAuthMethod;
    },
    request: McpRequestOptions = {}
  ): Promise<McpOAuthRegistration> {
    return this.run(
      request,
      async (fetch) => {
        await this.validate(input.discovery);
        await this.url(input.redirectUri, "redirect");
        if (!input.discovery.registrationEndpoint) throw new McpOAuthError("unsupported");
        const registered = await registerClient(input.discovery.issuer, {
          metadata: metadata(input.discovery),
          clientMetadata: {
            redirect_uris: [input.redirectUri],
            client_name: input.clientName,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: input.tokenEndpointAuthMethod ?? "none",
          },
          scope: input.scope,
          fetchFn: fetch,
        });
        const method =
          registered.token_endpoint_auth_method ?? input.tokenEndpointAuthMethod ?? "none";
        if (!isClientAuthMethod(method) || !registered.redirect_uris.includes(input.redirectUri))
          throw new McpOAuthError("unsupported");
        const registration: McpOAuthRegistration = {
          clientId: registered.client_id,
          ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
          tokenEndpointAuthMethod: method,
          ...(registered.client_secret_expires_at !== undefined
            ? { clientSecretExpiresAt: registered.client_secret_expires_at }
            : {}),
        };
        clientInformation(input.discovery, registration);
        return registration;
      },
      "registration"
    );
  }

  async exchange(
    input: McpOAuthExchange,
    request: McpRequestOptions = {}
  ): Promise<McpOAuthTokens> {
    return this.run(
      request,
      async (fetch) => {
        await this.validate(input.discovery);
        await this.url(input.redirectUri, "redirect");
        if (!input.authorizationCode || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
          throw new McpError("invalid_configuration");
        }
        return tokens(
          await exchangeAuthorization(input.discovery.issuer, {
            metadata: metadata(input.discovery),
            clientInformation: clientInformation(input.discovery, input.client),
            authorizationCode: input.authorizationCode,
            codeVerifier: input.codeVerifier,
            redirectUri: input.redirectUri,
            resource: secureUrl(input.discovery.resource),
            fetchFn: fetch,
          })
        );
      },
      "token"
    );
  }

  async refresh(
    input: {
      readonly discovery: McpOAuthDiscovery;
      readonly client: McpOAuthRegistration;
      readonly refreshToken: string;
    },
    request: McpRequestOptions = {}
  ): Promise<McpOAuthTokens> {
    return this.run(
      request,
      async (fetch) => {
        await this.validate(input.discovery);
        if (!input.refreshToken) throw new McpError("invalid_configuration");
        return tokens(
          await refreshAuthorization(input.discovery.issuer, {
            metadata: metadata(input.discovery),
            clientInformation: clientInformation(input.discovery, input.client),
            refreshToken: input.refreshToken,
            resource: secureUrl(input.discovery.resource),
            fetchFn: fetch,
          })
        );
      },
      "token"
    );
  }
}

export function createMcpOAuthClient(options: McpOAuthOptions): McpOAuthClient {
  return new McpOAuthClient(options);
}
