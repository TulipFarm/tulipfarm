import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createWorkspaceMcp } from '@tulipfarm/workspace-mcp';
import { bindHostedMcpSecrets, bindMcpSecrets, createSecrets } from '@tulipfarm/secrets';
import { mcpHost } from '@tulipfarm/extensions';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { apiCallPrivateHosts } from '@tulipfarm/api-calls';
import type { createTemporalClient } from './temporal.ts';
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
  temporal?: ReturnType<typeof createTemporalClient>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const secrets = createSecrets({
    runtime,
    keyring: () => integrationCredentialKeyring(env),
    privateHosts: apiCallPrivateHosts(env),
  });
  const flag = (name: string) => z.enum(['true', 'false']).parse(env[name] ?? 'false') === 'true';
  const admissionEnabled = flag('WORKSPACE_MCP_ADMISSION_ENABLED');
  const dispatchEnabled = flag('WORKSPACE_MCP_DISPATCH_ENABLED');
  const transport = createWorkspaceMcpTransport();
  // The host runs in the worker, but its extension registers here too so the API offers hosted setup only when it can run.
  const hostedEnabled = async (workspaceId: string) =>
    !!mcpHost() && (await isFeatureEnabled('hosted-mcp', null, { id: workspaceId }));
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
    // The API only checks who may send saved secrets; the worker decrypts them.
    secrets: { bind: (tx, input) => bindMcpSecrets(secrets, tx, input) },
    hostedSecrets: { bind: (tx, input) => bindHostedMcpSecrets(secrets, tx, input) },
    hostedEnabled,
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
    hostedEnabled,
    permissions,
    authorizeSelection: authorizeMcpSelection,
    authorizeSources: authorizeMcpSources,
    ...(temporal
      ? {
          queueDiscovery: async ({ workspaceId, userId, integrationId, requestId, expectedVersion }) => {
            await temporal.connection.withDeadline(Date.now() + 10_000, () =>
              temporal.client.workflow.start('workspaceMcpDiscovery', {
                workflowId: `workspace-mcp-discovery-v1:${workspaceId}:${integrationId}:${expectedVersion}`,
                taskQueue: env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [workspaceId, userId, integrationId, requestId, expectedVersion],
                workflowIdConflictPolicy: 'USE_EXISTING',
              }),
            );
          },
        }
      : {}),
  });
}
