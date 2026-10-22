import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { boundedJson, rejectReflectedSecrets } from '@tulipfarm/provider-mcp';
import { McpNetworkError, normalizeEndpoint } from './policy.ts';
import { publicHttpsFetch } from './public-https.ts';

// The API (BETTER_AUTH_URL) serves the OAuth callback and the client metadata document.
const apiOrigin = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3001').origin;
const webOrigin = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:5173').origin;
export const MCP_OAUTH_REDIRECT_URI = `${apiOrigin}/v1/workspace-mcp/oauth/callback`;
export const MCP_OAUTH_CLIENT_ID = `${apiOrigin}/.well-known/mcp-client.json`;
export const MCP_OAUTH_CLIENT_METADATA = Object.freeze({
  client_id: MCP_OAUTH_CLIENT_ID,
  client_name: 'TulipFarm',
  client_uri: webOrigin,
  redirect_uris: Object.freeze([MCP_OAUTH_REDIRECT_URI]),
  grant_types: Object.freeze(['authorization_code', 'refresh_token']),
  response_types: Object.freeze(['code']),
  token_endpoint_auth_method: 'none',
});

const tableSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1).max(8),
  scopes_supported: z.array(z.string().max(256)).max(128).optional(),
});
const issuerSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
const clientSchema = z.object({
  client_id: z.string().min(1).max(4096),
  client_secret: z.string().min(1).max(8192).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('none'),
  redirect_uris: z.array(z.string()).optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string(),
  refresh_token: z.string().min(1).max(8192).optional(),
  expires_in: z.number().int().positive().max(31536000),
  scope: z.string().max(32768).optional(),
});

export type OAuthBinding = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  metadataDocumentSupported: boolean;
  authMethods: string[];
  scopes: string[];
  authorizationResponseIssuerSupported: boolean;
};
export type OAuthClient = {
  clientId: string;
  clientSecret?: string;
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  issuer: string;
};
export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  issuer: string;
  resource: string;
  scopes: string[];
};

function issuerUrl(input: string): string {
  const url = new URL(normalizeEndpoint(input));
  if (url.search) throw new McpNetworkError('oauth-binding-denied');
  return input;
}
function validatedBinding(binding: OAuthBinding): OAuthBinding {
  return {
    ...binding,
    resource: normalizeEndpoint(binding.resource),
    issuer: issuerUrl(binding.issuer),
    authorizationEndpoint: normalizeEndpoint(binding.authorizationEndpoint),
    tokenEndpoint: normalizeEndpoint(binding.tokenEndpoint),
    ...(binding.registrationEndpoint ? { registrationEndpoint: normalizeEndpoint(binding.registrationEndpoint) } : {}),
  };
}
function validateClient(binding: OAuthBinding, client: OAuthClient): void {
  if (
    client.issuer !== binding.issuer ||
    !client.clientId ||
    client.clientId.length > 4096 ||
    !binding.authMethods.includes(client.authMethod) ||
    (client.authMethod !== 'none' && !client.clientSecret) ||
    (client.authMethod === 'none' && client.clientSecret)
  )
    throw new McpNetworkError('oauth-binding-denied');
}

export function createOAuthOperations({
  fetcher = publicHttpsFetch,
  now = () => new Date(),
}: { fetcher?: typeof fetch; now?: () => Date } = {}) {
  async function document(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetcher(normalizeEndpoint(url), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30000)]),
    });
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new McpNetworkError('oauth-discovery-failed');
    }
    if (!response.body) throw new McpNetworkError('oauth-discovery-failed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2097152) throw new McpNetworkError('response-limit');
        chunks.push(chunk.value);
      }
      return boundedJson(JSON.parse(Buffer.concat(chunks).toString('utf8')), 2097152);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async function discoverOAuth(input: {
    endpoint: string;
    resourceMetadataUrl?: string;
    issuer?: string;
    signal?: AbortSignal;
  }): Promise<OAuthBinding> {
    try {
      const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(60000)]);
      signal.throwIfAborted();
      const endpoint = normalizeEndpoint(input.endpoint);
      const resourceUrl = new URL(endpoint);
      let metadataUrl = input.resourceMetadataUrl;
      if (!metadataUrl) {
        const challenge = await fetcher(endpoint, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { accept: 'application/json' },
        });
        const header = challenge.headers.get('www-authenticate');
        await challenge.body?.cancel();
        if (challenge.status === 401 && header && /^Bearer\s/i.test(header)) {
          metadataUrl = /(?:^|[,\s])resource_metadata="([^"\r\n]+)"/i.exec(header)?.[1];
        }
      }
      const candidates = metadataUrl
        ? [normalizeEndpoint(metadataUrl)]
        : [
            `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === '/' ? '' : resourceUrl.pathname}`,
            `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
          ];
      let resource: z.infer<typeof tableSchema> | undefined;
      for (const candidate of new Set(candidates)) {
        signal.throwIfAborted();
        try {
          resource = tableSchema.parse(await document(candidate, { signal }));
          break;
        } catch {
          signal.throwIfAborted();
        }
      }
      if (!resource || normalizeEndpoint(resource.resource) !== endpoint)
        throw new McpNetworkError('oauth-binding-denied');
      const issuers = resource.authorization_servers.map(issuerUrl);
      const issuer = input.issuer ? issuerUrl(input.issuer) : issuers.length === 1 ? issuers[0] : undefined;
      if (!issuer || !issuers.includes(issuer)) throw new McpNetworkError('oauth-binding-denied');
      const parsedIssuer = new URL(issuer);
      const suffix = parsedIssuer.pathname === '/' ? '' : parsedIssuer.pathname;
      const locations = [
        `${parsedIssuer.origin}/.well-known/oauth-authorization-server${suffix}`,
        `${parsedIssuer.origin}/.well-known/openid-configuration${suffix}`,
        `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      ];
      let metadata: z.infer<typeof issuerSchema> | undefined;
      for (const location of new Set(locations)) {
        signal.throwIfAborted();
        try {
          metadata = issuerSchema.parse(await document(location, { signal }));
          break;
        } catch {
          signal.throwIfAborted();
        }
      }
      if (
        !metadata ||
        issuerUrl(metadata.issuer) !== issuer ||
        !metadata.code_challenge_methods_supported.includes('S256') ||
        !metadata.response_types_supported.includes('code') ||
        (metadata.grant_types_supported && !metadata.grant_types_supported.includes('authorization_code'))
      )
        throw new McpNetworkError('oauth-binding-denied');
      return validatedBinding({
        resource: endpoint,
        issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        ...(metadata.registration_endpoint ? { registrationEndpoint: metadata.registration_endpoint } : {}),
        metadataDocumentSupported: metadata.client_id_metadata_document_supported === true,
        authMethods: metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'],
        scopes: resource.scopes_supported ?? [],
        authorizationResponseIssuerSupported: metadata.authorization_response_iss_parameter_supported === true,
      });
    } catch (failure) {
      throw failure instanceof McpNetworkError ? failure : new McpNetworkError('oauth-discovery-failed');
    }
  }

  async function registerOAuthClient(input: { binding: OAuthBinding; explicit?: OAuthClient }): Promise<OAuthClient> {
    try {
      const binding = validatedBinding(input.binding);
      if (input.explicit) {
        validateClient(binding, input.explicit);
        return { ...input.explicit };
      }
      if (binding.metadataDocumentSupported && binding.authMethods.includes('none'))
        return { clientId: MCP_OAUTH_CLIENT_ID, authMethod: 'none', issuer: binding.issuer };
      if (!binding.registrationEndpoint) throw new McpNetworkError('oauth-registration-required');
      const raw = clientSchema.parse(
        await document(binding.registrationEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            client_name: MCP_OAUTH_CLIENT_METADATA.client_name,
            client_uri: MCP_OAUTH_CLIENT_METADATA.client_uri,
            redirect_uris: MCP_OAUTH_CLIENT_METADATA.redirect_uris,
            grant_types: MCP_OAUTH_CLIENT_METADATA.grant_types,
            response_types: MCP_OAUTH_CLIENT_METADATA.response_types,
            token_endpoint_auth_method: 'none',
          }),
        }),
      );
      if (!raw.redirect_uris || raw.redirect_uris.length !== 1 || raw.redirect_uris[0] !== MCP_OAUTH_REDIRECT_URI)
        throw new McpNetworkError('oauth-binding-denied');
      const client: OAuthClient = {
        clientId: raw.client_id,
        authMethod: raw.token_endpoint_auth_method,
        issuer: binding.issuer,
        ...(raw.client_secret ? { clientSecret: raw.client_secret } : {}),
      };
      validateClient(binding, client);
      return client;
    } catch (failure) {
      throw failure instanceof McpNetworkError ? failure : new McpNetworkError('oauth-registration-failed');
    }
  }

  function createOAuthAuthorization(input: {
    binding: OAuthBinding;
    client: OAuthClient;
    state: string;
    redirectUri?: string;
    scope?: string[];
  }) {
    const binding = validatedBinding(input.binding);
    validateClient(binding, input.client);
    if (
      !/^[A-Za-z0-9_-]{32,256}$/.test(input.state) ||
      (input.redirectUri && input.redirectUri !== MCP_OAUTH_REDIRECT_URI)
    )
      throw new McpNetworkError('oauth-binding-denied');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(binding.authorizationEndpoint);
    for (const key of [
      'client_id',
      'response_type',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'resource',
      'scope',
    ]) {
      if (url.searchParams.has(key)) throw new McpNetworkError('oauth-binding-denied');
    }
    const scopes = input.scope ?? binding.scopes;
    if (scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)) || scopes.length > 128)
      throw new McpNetworkError('oauth-binding-denied');
    for (const [key, value] of Object.entries({
      client_id: input.client.clientId,
      response_type: 'code',
      redirect_uri: MCP_OAUTH_REDIRECT_URI,
      state: input.state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: binding.resource,
      scope: scopes.join(' '),
    }))
      url.searchParams.set(key, value);
    return {
      authorizationUrl: url.href,
      verifier,
      redirectUri: MCP_OAUTH_REDIRECT_URI,
      state: input.state,
      issuer: binding.issuer,
      resource: binding.resource,
      clientId: input.client.clientId,
      scopes: [...scopes],
    };
  }

  async function token(
    bindingInput: OAuthBinding,
    client: OAuthClient,
    params: URLSearchParams,
    secrets: string[],
    scopes: string[],
  ): Promise<OAuthTokens> {
    try {
      const binding = validatedBinding(bindingInput);
      const capturedClient = { ...client };
      validateClient(binding, capturedClient);
      const retainedScopes = [...scopes];
      params.set('resource', binding.resource);
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      };
      if (capturedClient.authMethod === 'client_secret_basic') {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(capturedClient.clientId)}:${encodeURIComponent(capturedClient.clientSecret ?? '')}`).toString('base64')}`;
      } else {
        params.set('client_id', capturedClient.clientId);
        if (capturedClient.authMethod === 'client_secret_post')
          params.set('client_secret', capturedClient.clientSecret ?? '');
      }
      const raw = await document(binding.tokenEndpoint, { method: 'POST', headers, body: params.toString() });
      const result = tokenSchema.parse(raw);
      if (result.token_type.toLowerCase() !== 'bearer' || /[^A-Za-z0-9\-._~+/=]/.test(result.access_token))
        throw new McpNetworkError('oauth-token-failed');
      const reflected = { ...result, access_token: '', refresh_token: '' };
      const privateValues = [...secrets, ...(capturedClient.clientSecret ? [capturedClient.clientSecret] : [])];
      rejectReflectedSecrets(reflected, privateValues);
      rejectReflectedSecrets(result.access_token, privateValues);
      rejectReflectedSecrets(
        result.refresh_token ?? '',
        params.get('grant_type') === 'refresh_token'
          ? capturedClient.clientSecret
            ? [capturedClient.clientSecret]
            : []
          : privateValues,
      );
      return {
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? null,
        expiresAt: new Date(now().getTime() + result.expires_in * 1000).toISOString(),
        issuer: binding.issuer,
        resource: binding.resource,
        scopes: result.scope === undefined ? retainedScopes : result.scope.split(' ').filter(Boolean),
      };
    } catch {
      throw new McpNetworkError('oauth-token-failed');
    }
  }

  async function exchangeOAuthCode(input: {
    binding: OAuthBinding;
    client: OAuthClient;
    code: string;
    verifier: string;
    redirectUri?: string;
    scope?: string[];
    responseIssuer?: string;
  }): Promise<OAuthTokens> {
    if (
      (input.redirectUri && input.redirectUri !== MCP_OAUTH_REDIRECT_URI) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
      !input.code ||
      input.code.length > 8192 ||
      (input.binding.authorizationResponseIssuerSupported && !input.responseIssuer) ||
      (input.responseIssuer !== undefined && input.responseIssuer !== input.binding.issuer)
    )
      throw new McpNetworkError('oauth-binding-denied');
    return token(
      input.binding,
      input.client,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: MCP_OAUTH_REDIRECT_URI,
      }),
      [input.code, input.verifier],
      input.scope ?? input.binding.scopes,
    );
  }

  async function refreshOAuthToken(input: {
    binding: OAuthBinding;
    client: OAuthClient;
    refreshToken: string;
    scope?: string[];
  }): Promise<OAuthTokens> {
    if (!input.refreshToken || input.refreshToken.length > 8192) throw new McpNetworkError('oauth-binding-denied');
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: input.refreshToken });
    if (input.scope) params.set('scope', input.scope.join(' '));
    const result = await token(
      input.binding,
      input.client,
      params,
      [input.refreshToken],
      input.scope ?? input.binding.scopes,
    );
    return { ...result, refreshToken: result.refreshToken ?? input.refreshToken };
  }
  return { discoverOAuth, registerOAuthClient, createOAuthAuthorization, exchangeOAuthCode, refreshOAuthToken };
}

export const { discoverOAuth, registerOAuthClient, createOAuthAuthorization, exchangeOAuthCode, refreshOAuthToken } =
  createOAuthOperations();
