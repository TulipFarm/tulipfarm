import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { McpError } from '@tulipfarm/workspace-mcp';
import { McpNetworkError } from '@tulipfarm/workspace-mcp-transport';
import { ConversationConflict } from '@tulipfarm/conversations';
import {
  McpHttpError,
  mcpActionParams,
  mcpCallbackSchema,
  mcpIntegrationParams,
  mcpHttpId,
  mcpWorkspaceParams,
  workspaceMcpHttp,
  type McpHttpAuth,
} from './workspace-mcp-http.ts';
import {
  mcpActionListSchema,
  mcpActionQuery,
  mcpActionSchema,
  mcpCancelSchema,
  mcpCapabilitiesSchema,
  mcpCatalogQuery,
  mcpCatalogSchema,
  mcpIntegrationDetailSchema,
  mcpIntegrationSchema,
  mcpDecisionSchema,
  mcpDescriptorSchema,
  mcpGrantsSchema,
  mcpLifecycleSchema,
  mcpMutationSchema,
  mcpPermissionInput,
  mcpPermissionSlotSchema,
  mcpPermissionsSchema,
  mcpReconciliationSchema,
  mcpReviewSchema,
  mcpSelectionInput,
  mcpSelectionParams,
  mcpSelectionQuery,
  mcpSelectionSchema,
  mcpSetupResultSchema,
  mcpSetupSchema,
} from './workspace-mcp-contracts.ts';
import type { createWorkspaceMcpApi } from './workspace-mcp-service.ts';

function classify(error: unknown) {
  if (error instanceof ConversationConflict) return new McpHttpError('mcp-conflict', 409);
  if (error instanceof McpError) {
    switch (error.code) {
      case 'disabled':
      case 'credential-unavailable':
      case 'discovery-failed':
      case 'integration-unavailable':
        return new McpHttpError(`mcp-${error.code}`, 503);
      case 'invalid-input':
        return new McpHttpError('invalid-request', 400);
      case 'expired':
        return new McpHttpError('mcp-expired', 410);
      case 'oauth-conflict':
        return new McpHttpError('mcp-not-found', 404);
      default:
        return new McpHttpError(`mcp-${error.code}`, 409);
    }
  }
  if (error instanceof McpNetworkError) return new McpHttpError('mcp-network-unavailable', 503);
  return null;
}

export function registerWorkspaceMcp(
  app: FastifyInstance,
  auth: McpHttpAuth,
  service: ReturnType<typeof createWorkspaceMcpApi> | null,
  wakeTaskAction?: (workspaceId: string, actionId: string) => Promise<void>,
) {
  app.register(async routes => {
    const http = workspaceMcpHttp(routes, auth, classify);
    const base = '/workspaces/:workspaceId/workspace-mcp';
    function api() {
      if (!service) throw new McpHttpError('mcp-disabled', 503);
      return service;
    }
    const integrationContext = (request: Parameters<typeof http.session>[0]) => ({
      ...mcpIntegrationParams.parse(request.params),
      ...http.session(request),
    });
    const actionContext = (request: Parameters<typeof http.session>[0]) => ({
      ...mcpActionParams.parse(request.params),
      ...http.session(request),
    });
    routes.get(
      `${base}/capabilities`,
      {
        logLevel: 'silent',
        schema: http.schema('getWorkspaceMcpCapabilitiesV1', mcpCapabilitiesSchema, mcpWorkspaceParams),
      },
      request => {
        const { workspaceId } = mcpWorkspaceParams.parse(request.params);
        return service ? service.capabilities(workspaceId, http.session(request).userId) : { enabled: false };
      },
    );
    routes.get(
      `${base}/catalog`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'searchWorkspaceMcpCatalogV1',
          mcpCatalogSchema,
          mcpWorkspaceParams,
          undefined,
          mcpCatalogQuery,
        ),
      },
      request =>
        api().catalog(
          mcpWorkspaceParams.parse(request.params).workspaceId,
          http.session(request).userId,
          mcpCatalogQuery.parse(request.query),
        ),
    );
    routes.get(
      `${base}/integrations`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'listWorkspaceMcpIntegrationsV1',
          z.strictObject({ integrations: z.array(mcpIntegrationSchema) }),
          mcpWorkspaceParams,
        ),
      },
      request => api().integrations(mcpWorkspaceParams.parse(request.params).workspaceId, http.session(request).userId),
    );
    routes.post(
      `${base}/integrations`,
      {
        logLevel: 'silent',
        bodyLimit: 192 * 1024,
        schema: http.schema(
          'createWorkspaceMcpIntegrationV1',
          mcpSetupResultSchema,
          mcpWorkspaceParams,
          mcpSetupSchema,
        ),
      },
      request => {
        const session = http.session(request);
        return api().setup(
          mcpWorkspaceParams.parse(request.params).workspaceId,
          session.userId,
          session.sessionId,
          mcpSetupSchema.parse(request.body),
        );
      },
    );
    routes.get(
      `${base}/integrations/:integrationId`,
      {
        logLevel: 'silent',
        schema: http.schema('getWorkspaceMcpIntegrationV1', mcpIntegrationDetailSchema, mcpIntegrationParams),
      },
      request => {
        const p = integrationContext(request);
        return api().detail(p.workspaceId, p.userId, p.integrationId);
      },
    );
    routes.post(
      `${base}/integrations/:integrationId/setup`,
      {
        logLevel: 'silent',
        bodyLimit: 192 * 1024,
        schema: http.schema(
          'replaceWorkspaceMcpCredentialV1',
          mcpSetupResultSchema,
          mcpIntegrationParams,
          mcpSetupSchema,
        ),
      },
      request => {
        const p = integrationContext(request);
        return api().setup(p.workspaceId, p.userId, p.sessionId, mcpSetupSchema.parse(request.body), p.integrationId);
      },
    );
    routes.post(
      `${base}/integrations/:integrationId/discover`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'discoverWorkspaceMcpToolsV1',
          mcpIntegrationDetailSchema,
          mcpIntegrationParams,
          mcpMutationSchema,
        ),
      },
      request => {
        const p = integrationContext(request);
        return api().discover(p.workspaceId, p.userId, p.integrationId, mcpMutationSchema.parse(request.body));
      },
    );
    routes.put(
      `${base}/integrations/:integrationId/tools`,
      {
        logLevel: 'silent',
        bodyLimit: 131072,
        schema: http.schema(
          'reviewWorkspaceMcpToolsV1',
          mcpIntegrationDetailSchema,
          mcpIntegrationParams,
          mcpReviewSchema,
        ),
      },
      request => {
        const p = integrationContext(request);
        return api().review(p.workspaceId, p.userId, p.integrationId, mcpReviewSchema.parse(request.body));
      },
    );
    routes.post(
      `${base}/integrations/:integrationId/descriptor`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'approveWorkspaceMcpDescriptorV1',
          mcpIntegrationDetailSchema,
          mcpIntegrationParams,
          mcpDescriptorSchema,
        ),
      },
      request => {
        const p = integrationContext(request);
        return api().descriptor(p.workspaceId, p.userId, p.integrationId, mcpDescriptorSchema.parse(request.body));
      },
    );
    routes.put(
      `${base}/integrations/:integrationId/grants`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'setWorkspaceMcpGrantsV1',
          mcpIntegrationDetailSchema,
          mcpIntegrationParams,
          mcpGrantsSchema,
        ),
      },
      request => {
        const p = integrationContext(request);
        return api().grants(p.workspaceId, p.userId, p.integrationId, mcpGrantsSchema.parse(request.body));
      },
    );
    routes.post(
      `${base}/integrations/:integrationId/lifecycle`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'setWorkspaceMcpLifecycleV1',
          z.strictObject({ saved: z.literal(true) }),
          mcpIntegrationParams,
          mcpLifecycleSchema,
        ),
      },
      request => {
        const p = integrationContext(request);
        return api().lifecycle(p.workspaceId, p.userId, p.integrationId, mcpLifecycleSchema.parse(request.body));
      },
    );
    routes.get(
      `${base}/selections/:kind/:originId`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'getWorkspaceMcpSelectionV1',
          mcpSelectionSchema,
          mcpSelectionParams,
          undefined,
          mcpSelectionQuery,
        ),
      },
      request =>
        api().selection(
          mcpSelectionParams.parse(request.params),
          http.session(request).userId,
          mcpSelectionQuery.parse(request.query),
        ),
    );
    const chat = mcpWorkspaceParams.extend({ originId: mcpHttpId });
    routes.post(
      `${base}/selections/chat/:originId/reserve`,
      {
        logLevel: 'silent',
        schema: http.schema('reserveWorkspaceMcpChatV1', z.strictObject({ id: mcpHttpId }), chat, mcpCancelSchema),
      },
      request => {
        const p = chat.parse(request.params);
        return api().reserveChat(
          p.workspaceId,
          http.session(request).userId,
          p.originId,
          mcpCancelSchema.parse(request.body).requestId,
        );
      },
    );
    routes.put(
      `${base}/selections/:kind/:originId`,
      {
        logLevel: 'silent',
        schema: http.schema('setWorkspaceMcpSelectionV1', mcpSelectionSchema, mcpSelectionParams, mcpSelectionInput),
      },
      request =>
        api().select(
          mcpSelectionParams.parse(request.params),
          http.session(request).userId,
          mcpSelectionInput.parse(request.body),
        ),
    );
    const agent = mcpWorkspaceParams.extend({ agentId: mcpHttpId });
    routes.get(
      `${base}/agent-permission-choices`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'getWorkspaceMcpAgentPermissionChoicesV1',
          z.array(mcpPermissionSlotSchema),
          mcpWorkspaceParams,
        ),
      },
      request => {
        return api().permissionChoices(
          mcpWorkspaceParams.parse(request.params).workspaceId,
          http.session(request).userId,
        );
      },
    );
    routes.get(
      `${base}/agents/:agentId/permissions`,
      { logLevel: 'silent', schema: http.schema('getWorkspaceMcpAgentPermissionsV1', mcpPermissionsSchema, agent) },
      request => {
        const p = agent.parse(request.params);
        return api().permissions(p.workspaceId, http.session(request).userId, p.agentId);
      },
    );
    routes.put(
      `${base}/agents/:agentId/permissions`,
      {
        logLevel: 'silent',
        bodyLimit: 131072,
        schema: http.schema('setWorkspaceMcpAgentPermissionsV1', mcpPermissionsSchema, agent, mcpPermissionInput),
      },
      request => {
        const p = agent.parse(request.params);
        return api().setPermissions(
          p.workspaceId,
          http.session(request).userId,
          p.agentId,
          mcpPermissionInput.parse(request.body),
        );
      },
    );
    routes.get(
      `${base}/actions`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'listWorkspaceMcpActionsV1',
          mcpActionListSchema,
          mcpWorkspaceParams,
          undefined,
          mcpActionQuery,
        ),
      },
      request =>
        api().actions(
          mcpWorkspaceParams.parse(request.params).workspaceId,
          http.session(request).userId,
          mcpActionQuery.parse(request.query),
        ),
    );
    for (const suffix of ['', '/status'])
      routes.get(
        `${base}/actions/:actionId${suffix}`,
        {
          logLevel: 'silent',
          schema: http.schema(
            suffix ? 'getWorkspaceMcpActionStatusV1' : 'getWorkspaceMcpActionV1',
            mcpActionSchema,
            mcpActionParams,
          ),
        },
        request => {
          const p = actionContext(request);
          return api().action(p.workspaceId, p.userId, p.actionId);
        },
      );
    routes.post(
      `${base}/actions/:actionId/decision`,
      {
        logLevel: 'silent',
        bodyLimit: 2048,
        schema: http.schema('decideWorkspaceMcpActionV1', mcpActionSchema, mcpActionParams, mcpDecisionSchema),
      },
      async request => {
        const p = actionContext(request);
        const result = await api().decide(p.workspaceId, p.userId, p.actionId, mcpDecisionSchema.parse(request.body));
        await wakeTaskAction?.(p.workspaceId, p.actionId);
        return result;
      },
    );
    routes.post(
      `${base}/actions/:actionId/cancel`,
      {
        logLevel: 'silent',
        schema: http.schema(
          'cancelWorkspaceMcpActionV1',
          z.strictObject({ id: mcpHttpId, status: z.literal('cancelled') }),
          mcpActionParams,
          mcpCancelSchema,
        ),
      },
      async request => {
        const p = actionContext(request);
        const result = await api().cancel(p.workspaceId, p.userId, p.actionId, mcpCancelSchema.parse(request.body));
        await wakeTaskAction?.(p.workspaceId, p.actionId);
        return result;
      },
    );
    routes.post(
      `${base}/actions/:actionId/reconciliation`,
      {
        logLevel: 'silent',
        bodyLimit: 32768,
        schema: http.schema('reconcileWorkspaceMcpActionV1', mcpActionSchema, mcpActionParams, mcpReconciliationSchema),
      },
      async request => {
        const p = actionContext(request);
        const result = await api().reconcile(
          p.workspaceId,
          p.userId,
          p.actionId,
          mcpReconciliationSchema.parse(request.body),
        );
        await wakeTaskAction?.(p.workspaceId, p.actionId);
        return result;
      },
    );
    routes.get(
      '/workspace-mcp/oauth/callback',
      {
        logLevel: 'silent',
        schema: http.schema(
          'completeWorkspaceMcpOAuthV1',
          z.strictObject({ workspaceId: mcpHttpId, integrationId: mcpHttpId }),
          undefined,
          undefined,
          mcpCallbackSchema,
        ),
      },
      request => {
        const session = http.session(request);
        return api().oauth.complete(session.userId, session.sessionId, mcpCallbackSchema.parse(request.query));
      },
    );
  });
}
