import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  createWorkspaceMcp,
  workspaceMcpDiscovery,
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
import { bindHostedMcpSecrets, bindMcpSecrets, createSecrets } from '@tulipfarm/secrets';
import { hostedMcpSecretSends, mcpSecretSends } from '@tulipfarm/secrets/send';
import { mcpHost } from '@tulipfarm/extensions';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { apiCallPrivateHosts } from '@tulipfarm/api-calls';

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

type McpServiceOptions = Omit<
  WorkspaceMcpOptions,
  'runtime' | 'authorizeOrigin' | 'authorizeSources' | 'authorizeSelection' | 'secrets' | 'hostedSecrets'
>;

function workerSecrets(runtime: WorkspaceMcpOptions['runtime'], env: NodeJS.ProcessEnv) {
  return createSecrets({
    runtime,
    keyring: () => integrationCredentialKeyring(env),
    privateHosts: apiCallPrivateHosts(env),
  });
}

/** Lets MCP requests send saved secrets. Only the worker decrypts them, inside the dispatch transaction. */
export function mcpSecretsPort(
  runtime: WorkspaceMcpOptions['runtime'],
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<WorkspaceMcpOptions['secrets']> {
  const secrets = workerSecrets(runtime, env);
  return { bind: (tx, input) => bindMcpSecrets(secrets, tx, input), ...mcpSecretSends(secrets) };
}

/** Lets hosted packages read saved secrets as settings, decrypted only here, just before their sandbox starts. */
export function mcpHostedSecretsPort(
  runtime: WorkspaceMcpOptions['runtime'],
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<WorkspaceMcpOptions['hostedSecrets']> {
  const secrets = workerSecrets(runtime, env);
  return { bind: (tx, input) => bindHostedMcpSecrets(secrets, tx, input), ...hostedMcpSecretSends(secrets) };
}

export function workspaceMcpService(options: McpServiceOptions, runtime: WorkspaceMcpOptions['runtime']) {
  return createWorkspaceMcp({
    ...options,
    runtime,
    secrets: mcpSecretsPort(runtime),
    hostedSecrets: mcpHostedSecretsPort(runtime),
    authorizeOrigin: authorizeMcpOrigin,
    authorizeSources: authorizeMcpSources,
    authorizeSelection: authorizeMcpSelection,
  });
}

export function workspaceMcpFactory(options: McpServiceOptions, oauth = createOAuthOperations()): McpExecutionFactory {
  return runtime => createMcpExecution(workspaceMcpService(options, runtime), oauth, options.dispatchEnabled === true);
}

function mcpOptionsFromEnvironment(env: NodeJS.ProcessEnv): McpServiceOptions | undefined {
  if (env.WORKSPACE_MCP_DISPATCH_ENABLED === undefined && env.WORKSPACE_MCP_ADMISSION_ENABLED === undefined)
    return undefined;
  const flag = z.enum(['true', 'false']).default('false');
  const transport = createWorkspaceMcpTransport();
  function context(input: Parameters<WorkspaceMcpOptions['protocol']['discover']>[0]) {
    const { hostTarget, ...rest } = input;
    const credential = rest.credential;
    const target = hostTarget ? { hostTarget } : {};
    if (credential.kind !== 'oauth') return { ...rest, ...target, credential };
    const { clientSecret, ...oauth } = credential;
    return { ...rest, ...target, credential: { ...oauth, ...(clientSecret ? { clientSecret } : {}) } };
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
  return {
    keyring: integrationCredentialKeyring(),
    protocol,
    admissionEnabled: flag.parse(env.WORKSPACE_MCP_ADMISSION_ENABLED) === 'true',
    dispatchEnabled: flag.parse(env.WORKSPACE_MCP_DISPATCH_ENABLED) === 'true',
    ...hostedOptions(),
  };
}

/** The extension's package host, when one is registered. Without it hosted integrations stay unavailable. */
function hostedOptions(): Pick<McpServiceOptions, 'host' | 'hostedEnabled'> {
  const host = mcpHost();
  if (!host) return {};
  return { host, hostedEnabled: workspaceId => isFeatureEnabled('hosted-mcp', null, { id: workspaceId }) };
}

/** Removes sandboxes whose integration was deleted, disabled, replaced or lost a secret's permission. */
export function createWorkspaceMcpHostedSweep(
  runtime: WorkspaceMcpOptions['runtime'],
  env: NodeJS.ProcessEnv = process.env,
) {
  const options = mcpOptionsFromEnvironment(env);
  if (!options?.host) return undefined;
  const service = workspaceMcpService(options, runtime);
  return (signal: AbortSignal) => service.sweepHosted(signal);
}

export function workspaceMcpFromEnvironment(env: NodeJS.ProcessEnv = process.env): McpExecutionFactory | undefined {
  const options = mcpOptionsFromEnvironment(env);
  return options && workspaceMcpFactory(options);
}

const failureReasons: Partial<Record<string, string>> = {
  'credential-unavailable': 'A saved secret could not be read. Check that it is still saved and names this endpoint.',
  'discovery-failed': 'The server did not return a usable tool list.',
  'install-failed': 'The package could not be installed or did not start. Check its name, version and settings.',
  limit: 'This workspace started too many package installs today. Try again tomorrow.',
  disabled: 'Hosted packages are not available in this workspace.',
  'secret-denied':
    'A saved secret is not shared with everyone who uses this integration, or does not name its endpoint.',
};

/** Discovers tools for integrations that send saved secrets, which the API cannot decrypt. */
export function createWorkspaceMcpDiscoveryActivities(
  runtime: WorkspaceMcpOptions['runtime'],
  env: NodeJS.ProcessEnv = process.env,
) {
  const options = mcpOptionsFromEnvironment(env);
  const service = options && workspaceMcpService(options, runtime);
  const discovery = service && workspaceMcpDiscovery(runtime, service);
  return {
    async discoverWorkspaceMcp(
      workspaceId: string,
      userId: string,
      integrationId: string,
      requestId: string,
      expectedVersion: number,
    ) {
      if (!service || !discovery) throw new Error('Workspace MCP is not configured');
      try {
        await discovery.discover(workspaceId, userId, integrationId, { requestId, expectedVersion });
      } catch (error) {
        if (error instanceof McpError && error.code === 'conflict') return;
        await service.failDiscovery(
          workspaceId,
          integrationId,
          expectedVersion,
          (error instanceof McpError && failureReasons[error.code]) || 'Tool discovery failed. Try again.',
        );
      }
    },
  };
}
