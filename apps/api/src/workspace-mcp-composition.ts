import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createWorkspaceMcp } from '@tulipfarm/workspace-mcp';
import { createWorkspaceMcpTransport, MCP_OAUTH_CLIENT_METADATA } from '@tulipfarm/workspace-mcp-transport';
import { authorizeMcpOrigin, authorizeMcpSources, authorizeMcpSelection } from '@tulipfarm/agents/mcp-authority';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { workspaceMcpCatalog, registerWorkspaceMcpCatalogRefresh } from './workspace-mcp-catalog.ts';
import { createWorkspaceMcpApi } from './workspace-mcp-service.ts';
import { workspaceMcpPermissions } from './workspace-mcp-permissions.ts';
import { workspaceMcpCatalogCache } from './workspace-mcp-catalog-cache.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function registerWorkspaceMcpClientMetadata(app: FastifyInstance) {
  app.get(
    '/.well-known/mcp-client.json',
    {
      logLevel: 'silent',
      schema: {
        operationId: 'getWorkspaceMcpClientMetadata',
        tags: ['Workspace MCP'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(MCP_OAUTH_CLIENT_METADATA),
            properties: {
              client_id: { type: 'string' },
              client_name: { type: 'string' },
              client_uri: { type: 'string' },
              redirect_uris: { type: 'array', items: { type: 'string' } },
              grant_types: { type: 'array', items: { type: 'string' } },
              response_types: { type: 'array', items: { type: 'string' } },
              token_endpoint_auth_method: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(MCP_OAUTH_CLIENT_METADATA),
  );
}

export function workspaceMcpApi(
  app: FastifyInstance,
  runtime: WorkspaceRuntime,
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const flag = (name: string) => z.enum(['true', 'false']).parse(env[name] ?? 'false') === 'true';
  const admissionEnabled = flag('WORKSPACE_MCP_ADMISSION_ENABLED');
  const dispatchEnabled = flag('WORKSPACE_MCP_DISPATCH_ENABLED');
  const transport = createWorkspaceMcpTransport();
  const service = createWorkspaceMcp({
    runtime,
    keyring: integrationCredentialKeyring(env),
    protocol: {
      discover: input => {
        if (input.credential.kind !== 'oauth') return transport.discover({ ...input, credential: input.credential });
        const { clientSecret, ...credential } = input.credential;
        return transport.discover({
          ...input,
          credential: { ...credential, ...(clientSecret ? { clientSecret } : {}) },
        });
      },
      call: async () => {
        throw new Error('MCP dispatch belongs to the worker');
      },
    },
    authorizeOrigin: authorizeMcpOrigin,
    authorizeSources: authorizeMcpSources,
    authorizeSelection: authorizeMcpSelection,
    resolveConfirmationCredential,
    admissionEnabled,
    dispatchEnabled,
  });
  const catalog = workspaceMcpCatalog(
    undefined,
    workspaceMcpCatalogCache(join(tmpdir(), 'tulipfarm-mcp-public-catalog')),
  );
  registerWorkspaceMcpCatalogRefresh(app, catalog);
  const permissions = workspaceMcpPermissions(runtime, service);
  app.addHook('onClose', async () => {
    permissions.close();
  });
  return createWorkspaceMcpApi({
    runtime,
    service,
    catalog,
    admissionEnabled,
    dispatchEnabled,
    permissions,
    authorizeSelection: authorizeMcpSelection,
    authorizeSources: authorizeMcpSources,
  });
}
