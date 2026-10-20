import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  createWorkspaceMcp,
  McpError,
  type WorkspaceMcpOptions,
  type WorkspaceMcpService,
} from '@tulipfarm/workspace-mcp';
import { createWorkspaceMcpTransport, createOAuthOperations } from '@tulipfarm/workspace-mcp-transport';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { authorizeMcpOrigin, authorizeMcpSources, authorizeMcpSelection } from '@tulipfarm/agents/mcp-authority';
import { createMcpCatalog, validateMcpCall } from '@tulipfarm/agents/mcp-catalog';
import { mcpExecutionResultSchema } from '@tulipfarm/agents/mcp-contracts';
import type { McpExecutionContext, McpExecutionFactory, McpExecutionPort } from '@tulipfarm/agents/mcp-runtime';
import { sourceDependenciesSchema } from '@tulipfarm/conversations/results';
import { canonicalJson } from '@tulipfarm/tables/canonical';

export function createMcpExecution(
  service: WorkspaceMcpService,
  oauth = createOAuthOperations(),
  dispatchEnabled = false,
): McpExecutionPort {
  async function refresh(context: McpExecutionContext, integrationId: string) {
    const metadata = await service.status(context.workspaceId, context.actor, integrationId);
    if (!metadata.refreshDue) return;
    const claim = await service.claimRefresh(context.workspaceId, context.actor, integrationId);
    try {
      const credential = claim.credential;
      if (!credential.refreshToken) throw new McpError('credential-unavailable');
      const binding = await oauth.discoverOAuth({ endpoint: claim.endpoint, issuer: credential.issuer });
      if (binding.resource !== credential.resource || binding.issuer !== credential.issuer)
        throw new McpError('oauth-conflict');
      const tokens = await oauth.refreshOAuthToken({
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
      if (tokens.resource !== credential.resource || tokens.issuer !== credential.issuer)
        throw new McpError('oauth-conflict');
      await service.completeRefresh(context.workspaceId, context.actor, integrationId, claim, {
        ...credential,
        ...tokens,
      });
    } catch {
      await service.failRefresh(context.workspaceId, context.actor, integrationId, claim);
      throw new McpError('credential-unavailable');
    }
  }
  async function catalog(context: McpExecutionContext) {
    const selected = await service.catalog(context.workspaceId, context.actor, context.origin);
    return {
      catalog: createMcpCatalog(
        selected.tools.map(entry => ({
          handle: entry.handle,
          revision: entry.revision,
          name: entry.tool.name,
          description: `Account: ${entry.integrationName}\n${entry.tool.description}`.slice(0, 32768),
          inputSchema: entry.tool.inputSchema,
        })),
      ),
      sources: sourceDependenciesSchema.parse(selected.sources),
    };
  }
  function result(view: Awaited<ReturnType<WorkspaceMcpService['action']>>) {
    const observation = view.reconciliations.find(item => item.observation !== 'still-unknown')?.observation;
    const waiting =
      ['awaiting-approval', 'ready', 'dispatched'].includes(view.status) ||
      (view.status === 'outcome-unknown' && !view.reconciliations.some(item => item.observation !== 'still-unknown'));
    return {
      result: mcpExecutionResultSchema.parse(
        waiting
          ? { kind: 'waiting', provider: 'workspace-mcp', actionId: view.id, status: view.status }
          : {
              kind: 'receipt',
              provider: 'workspace-mcp',
              actionId: view.id,
              status:
                view.status === 'rejected-before-dispatch'
                  ? 'rejected'
                  : view.status === 'cancelled-before-dispatch'
                    ? 'cancelled'
                    : view.status,
              result: view.receipt?.result ?? null,
              sources: view.sources,
              ...(observation ? { observation } : {}),
            },
      ),
      sources: view.sources,
    };
  }
  async function resume(context: McpExecutionContext, id: string) {
    await service.recover(context.workspaceId);
    let action = await service.action(context.workspaceId, context.actor, id);
    if (canonicalJson(action.origin) !== canonicalJson(context.origin)) throw new AccessDenied();
    if (action.status === 'ready' || action.status === 'dispatched') {
      if (action.status === 'dispatched') await service.recover(context.workspaceId);
      else if (dispatchEnabled)
        try {
          await refresh(context, action.integrationId);
          await service.dispatch(context.workspaceId, id);
        } catch (error) {
          if (!(error instanceof McpError) || error.code !== 'disabled') throw error;
        }
      action = await service.action(context.workspaceId, context.actor, id);
    }
    return result(action);
  }
  return {
    recover: async workspaceId => {
      await service.recover(workspaceId);
    },
    catalog: async (context, described) => {
      if (!dispatchEnabled) return { model: { discovery: false, tools: [] }, sources: [] };
      const selected = await catalog(context);
      return { model: selected.catalog.model(described), sources: selected.sources };
    },
    execute: async (context, callId, call) => {
      if (call.tool === 'mcp.call') {
        const existing = await service.actionForOrigin(context.workspaceId, context.actor, context.origin);
        if (existing) {
          if (existing.id !== callId) throw new AccessDenied();
          return resume(context, callId);
        }
        if (!dispatchEnabled) throw new McpError('disabled');
        const selection = await service.selection(context.workspaceId, context.actor, context.origin);
        for (const binding of selection.bindings) await refresh(context, binding.integrationId);
      }
      const selected = await catalog(context);
      if (!dispatchEnabled) throw new McpError('disabled');
      if (call.tool === 'mcp.search')
        return { result: selected.catalog.search(call.query, call.offset), sources: selected.sources };
      if (call.tool === 'mcp.describe')
        return { result: selected.catalog.describe(call.handle), sources: selected.sources };
      validateMcpCall(call, selected.catalog.model([call.handle]));
      const view = await service.propose(context.workspaceId, context.actor, {
        id: callId,
        origin: context.origin,
        handle: call.handle,
        arguments: call.arguments,
      });
      return view.status === 'ready' ? resume(context, callId) : result(view);
    },
    resume,
  };
}

export function workspaceMcpFactory(
  options: Omit<WorkspaceMcpOptions, 'runtime' | 'authorizeOrigin' | 'authorizeSources' | 'authorizeSelection'>,
  oauth = createOAuthOperations(),
): McpExecutionFactory {
  return runtime =>
    createMcpExecution(
      createWorkspaceMcp({
        ...options,
        runtime,
        authorizeOrigin: authorizeMcpOrigin,
        authorizeSources: authorizeMcpSources,
        authorizeSelection: authorizeMcpSelection,
      }),
      oauth,
      options.dispatchEnabled === true,
    );
}

export function workspaceMcpFromEnvironment(env: NodeJS.ProcessEnv = process.env): McpExecutionFactory | undefined {
  if (env.WORKSPACE_MCP_DISPATCH_ENABLED === undefined && env.WORKSPACE_MCP_ADMISSION_ENABLED === undefined)
    return undefined;
  const flag = z.enum(['true', 'false']).default('false');
  const transport = createWorkspaceMcpTransport();
  function context(input: Parameters<WorkspaceMcpOptions['protocol']['discover']>[0]) {
    const credential = input.credential;
    if (credential.kind !== 'oauth') return { ...input, credential };
    const { clientSecret, ...rest } = credential;
    return { ...input, credential: { ...rest, ...(clientSecret ? { clientSecret } : {}) } };
  }
  const protocol: WorkspaceMcpOptions['protocol'] = {
    discover: input => transport.discover(context(input)),
    call: input => {
      const { outputSchema, annotations, execution, ...tool } = input.tool;
      return transport.call({
        ...context(input),
        arguments: input.arguments,
        requestId: input.requestId,
        deadline: input.deadline,
        authorize: input.authorize,
        tool: {
          ...tool,
          ...(outputSchema ? { outputSchema } : {}),
          ...(annotations ? { annotations } : {}),
          ...(execution ? { execution } : {}),
        },
      });
    },
  };
  return workspaceMcpFactory({
    keyring: integrationCredentialKeyring(),
    protocol,
    admissionEnabled: flag.parse(env.WORKSPACE_MCP_ADMISSION_ENABLED) === 'true',
    dispatchEnabled: flag.parse(env.WORKSPACE_MCP_DISPATCH_ENABLED) === 'true',
  });
}
