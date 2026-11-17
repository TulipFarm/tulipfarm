import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpError, type WorkspaceMcpService } from '@tulipfarm/workspace-mcp';
import {
  createOAuthOperations,
  isLoopbackRedirectUri,
  isMcpOAuthRedirectUri,
  MCP_OAUTH_CLIENT_ID,
  MCP_OAUTH_REDIRECT_URI,
  McpNetworkError,
} from '@tulipfarm/workspace-mcp-transport';
import { McpHttpError, mcpCallbackSchema, mcpHttpId } from './workspace-mcp-http.ts';
import type { mcpAuthenticationSchema } from './workspace-mcp-contracts.ts';
import type { workspaceMcpDiscovery } from '@tulipfarm/workspace-mcp';

const bindingSchema = z.strictObject({
  resource: z.url(),
  issuer: z.url(),
  authorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  registrationEndpoint: z.url().optional(),
  metadataDocumentSupported: z.boolean(),
  authMethods: z.array(z.string()),
  scopes: z.array(z.string()),
  authorizationResponseIssuerSupported: z.boolean(),
});
const clientSchema = z.strictObject({
  clientId: z.string(),
  clientSecret: z.string().optional(),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
  issuer: z.url(),
  redirectUri: z.string().refine(isLoopbackRedirectUri).optional(),
});
// Attempts saved before loopback sign-in have no client `redirectUri`, which means the hosted callback.
const materialSchema = z
  .strictObject({
    binding: bindingSchema,
    client: clientSchema,
    verifier: z.string(),
    redirectUri: z.string().refine(isMcpOAuthRedirectUri),
    scopes: z.array(z.string()),
  })
  .refine(material => material.redirectUri === (material.client.redirectUri ?? MCP_OAUTH_REDIRECT_URI));
/** Where a sign-in landed: a redirect's origin and path, without its query. */
const landing = (redirectUri: string) => {
  const url = new URL(redirectUri);
  return `${url.origin}${url.pathname}`;
};
type OAuthInput = Extract<z.infer<typeof mcpAuthenticationSchema>, { kind: 'oauth' }>;

export function createWorkspaceMcpOAuth(
  service: WorkspaceMcpService,
  network = createOAuthOperations(),
  discover: ReturnType<typeof workspaceMcpDiscovery>['discover'] = async (...input) => {
    await service.discover(...input);
  },
) {
  return {
    async refresh(workspaceId: string, userId: string, integrationId: string) {
      const metadata = await service.status(workspaceId, userId, integrationId);
      if (!metadata.refreshDue) return metadata;
      const claim = await service.claimRefresh(workspaceId, userId, integrationId);
      try {
        const credential = claim.credential;
        if (!credential.refreshToken) throw new McpError('credential-unavailable');
        const binding = await network.discoverOAuth({ endpoint: claim.endpoint, issuer: credential.issuer });
        if (binding.resource !== credential.resource || binding.issuer !== credential.issuer)
          throw new McpError('oauth-conflict');
        const tokens = await network.refreshOAuthToken({
          binding,
          client: {
            clientId: credential.clientId,
            issuer: credential.issuer,
            authMethod: credential.authMethod,
            ...(credential.clientSecret ? { clientSecret: credential.clientSecret } : {}),
          },
          refreshToken: credential.refreshToken,
          scope: credential.scopes,
        });
        return await service.completeRefresh(workspaceId, userId, integrationId, claim, { ...credential, ...tokens });
      } catch {
        await service.failRefresh(workspaceId, userId, integrationId, claim);
        throw new McpError('credential-unavailable');
      }
    },
    async begin(workspaceId: string, userId: string, sessionId: string, integrationId: string, input: OAuthInput) {
      const integration = await service.status(workspaceId, userId, integrationId);
      if (!integration.capabilities.manage) throw new McpHttpError('mcp-not-found', 404);
      const binding = await network.discoverOAuth({ endpoint: integration.endpoint });
      let client;
      try {
        const explicit = input.client
          ? {
              clientId: input.client.clientId,
              authMethod: input.client.authMethod,
              issuer: binding.issuer,
              ...(input.client.clientSecret ? { clientSecret: input.client.clientSecret } : {}),
            }
          : undefined;
        client = await network.registerOAuthClient({ binding, ...(explicit ? { explicit } : {}) });
      } catch (error) {
        if (!(error instanceof McpNetworkError) || error.code !== 'oauth-registration-required') throw error;
        return {
          kind: 'registration-required' as const,
          registration: {
            instructions:
              'Register a TulipFarm OAuth client with this server, then enter its client ID and any required client secret.',
            redirectUri: MCP_OAUTH_REDIRECT_URI,
            clientMetadataUrl: MCP_OAUTH_CLIENT_ID,
          },
        };
      }
      const authorization = network.createOAuthAuthorization({
        binding,
        client,
        state: randomBytes(32).toString('base64url'),
        redirectUri: client.redirectUri ?? MCP_OAUTH_REDIRECT_URI,
      });
      const material = materialSchema.parse({
        binding,
        client,
        verifier: authorization.verifier,
        redirectUri: authorization.redirectUri,
        scopes: authorization.scopes,
      });
      const attempt = await service.beginOAuth(workspaceId, userId, integrationId, { sessionId, material });
      const url = new URL(authorization.authorizationUrl);
      url.searchParams.set('state', `${mcpHttpId.parse(workspaceId)}_${attempt.state}`);
      // A loopback redirect lands on a page that can't load, so the member pastes its address back instead.
      return client.redirectUri
        ? { kind: 'oauth-paste' as const, authorizationUrl: url.href }
        : { kind: 'oauth' as const, authorizationUrl: url.href };
    },
    /**
     * Finishes a sign-in from the address the provider redirected to. `landedAt` is that address's origin and path; it
     * must match the attempt's redirect, so a hosted callback can't finish a loopback sign-in or the reverse.
     */
    async complete(
      userId: string,
      sessionId: string,
      input: z.infer<typeof mcpCallbackSchema>,
      landedAt: string = MCP_OAUTH_REDIRECT_URI,
    ) {
      const match = /^([0-9a-f-]{36})_([A-Za-z0-9_-]{32,256})$/.exec(input.state);
      if (!match) throw new McpHttpError('invalid-request', 400);
      const workspaceId = mcpHttpId.parse(match[1]);
      const state = z.string().parse(match[2]);
      const attempt = await service.consumeOAuth(workspaceId, userId, { state, sessionId });
      let integration;
      try {
        const material = materialSchema.parse(attempt.material);
        if (
          material.binding.resource !== attempt.endpoint ||
          material.client.issuer !== material.binding.issuer ||
          landing(material.redirectUri) !== landing(landedAt) ||
          (input.iss !== undefined && input.iss !== material.binding.issuer)
        )
          throw new McpHttpError('mcp-oauth-binding-denied', 400);
        if ('error' in input) throw new McpHttpError('mcp-authorization-denied', 400);
        const { registrationEndpoint, ...binding } = material.binding;
        const { clientSecret, redirectUri, ...client } = material.client;
        const tokens = await network.exchangeOAuthCode({
          binding: { ...binding, ...(registrationEndpoint ? { registrationEndpoint } : {}) },
          client: { ...client, ...(clientSecret ? { clientSecret } : {}), ...(redirectUri ? { redirectUri } : {}) },
          verifier: material.verifier,
          redirectUri: material.redirectUri,
          scope: material.scopes,
          code: input.code,
          ...(input.iss ? { responseIssuer: input.iss } : {}),
        });
        integration = await service.completeOAuth(workspaceId, userId, attempt.attemptId, {
          kind: 'oauth',
          ...tokens,
          clientId: material.client.clientId,
          authMethod: material.client.authMethod,
          ...(material.client.clientSecret ? { clientSecret: material.client.clientSecret } : {}),
          accountId: null,
        });
      } catch (error) {
        await service.failOAuth(workspaceId, userId, attempt.attemptId);
        throw error;
      }
      await discover(workspaceId, userId, attempt.integrationId, {
        requestId: attempt.attemptId,
        expectedVersion: integration.version,
      });
      return { workspaceId, integrationId: attempt.integrationId };
    },
  };
}
