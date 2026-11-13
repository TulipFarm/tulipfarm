import { z } from 'zod';
import { createConversations } from '@tulipfarm/conversations';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  type WorkspaceMcpService,
  type WorkspaceMcpOptions,
  workspaceMcpCompatibility,
} from '@tulipfarm/workspace-mcp';
import { authenticationHeaders, normalizeEndpoint } from '@tulipfarm/workspace-mcp-transport';
import { createWorkspaceMcpOAuth } from './workspace-mcp-oauth.ts';
import { mcpDiscoveryRequestId, workspaceMcpDiscovery } from '@tulipfarm/workspace-mcp';
import { McpHttpError } from './workspace-mcp-http.ts';
import type { workspaceMcpPermissions } from './workspace-mcp-permissions.ts';
import { workspaceMcpActions } from './workspace-mcp-actions.ts';
import { workspaceMcpSelections } from './workspace-mcp-selections.ts';
import type { workspaceMcpCatalog } from './workspace-mcp-catalog.ts';
import {
  mcpIntegrationSchema,
  mcpIntegrationDetailSchema,
  type mcpSetupSchema,
  type mcpMutationSchema,
  type mcpReviewSchema,
  type mcpGrantsSchema,
  type mcpLifecycleSchema,
  type mcpDescriptorSchema,
} from './workspace-mcp-contracts.ts';

type Options = {
  runtime: WorkspaceMcpOptions['runtime'];
  service: WorkspaceMcpService;
  catalog: ReturnType<typeof workspaceMcpCatalog>;
  oauth?: ReturnType<typeof createWorkspaceMcpOAuth>;
  admissionEnabled: boolean;
  dispatchEnabled: boolean;
  /** Whether this workspace may set up hosted packages: a host is registered and the workspace's flag is on. */
  hostedEnabled?: (workspaceId: string) => Promise<boolean>;
  permissions: Pick<ReturnType<typeof workspaceMcpPermissions>, 'permissions' | 'setPermissions' | 'permissionChoices'>;
  authorizeSelection: NonNullable<WorkspaceMcpOptions['authorizeSelection']>;
  authorizeSources: WorkspaceMcpOptions['authorizeSources'];
  /** Starts discovery in the worker, which alone may decrypt saved secrets. */
  queueDiscovery?: (input: {
    workspaceId: string;
    userId: string;
    integrationId: string;
    requestId: string;
    expectedVersion: number;
  }) => Promise<void>;
};
type Metadata = Awaited<ReturnType<WorkspaceMcpService['status']>>;

export function createWorkspaceMcpApi(options: Options) {
  const { service, runtime } = options;
  const discovery = workspaceMcpDiscovery(runtime, service);
  const oauth = options.oauth ?? createWorkspaceMcpOAuth(service, undefined, discovery.discover);
  async function authorized<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(workspaceId, workspaceMcpCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  function integration(row: Metadata) {
    return mcpIntegrationSchema.parse({
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      ownership: row.ownership,
      accountLabel: null,
      authMethod: row.authMethod,
      kind: row.kind,
      package: row.package,
      egress: row.egress,
      version: row.version,
      authorizationEpoch: row.authorizationEpoch,
      status:
        row.lifecycle === 'active' && row.discovery === 'queued'
          ? 'discovering'
          : row.lifecycle === 'active' && (row.discovery === 'failed' || row.statusReason)
            ? 'error'
            : row.lifecycle === 'active'
              ? 'review-required'
              : row.lifecycle === 'authorizing'
                ? 'oauth-pending'
                : row.lifecycle === 'reconnect-required'
                  ? 'error'
                  : row.lifecycle === 'deleted'
                    ? 'disconnected'
                    : row.lifecycle,
      canManage: row.capabilities.manage,
      canUse: row.capabilities.use,
      barrier: row.barrierActionId ? { actionId: row.barrierActionId } : null,
      statusReason: row.blocked
        ? 'An unresolved action pauses this integration.'
        : row.lifecycle === 'reconnect-required'
          ? 'Reconnect and review this integration.'
          : row.statusReason,
      ...(row.lifecycle === 'reconnect-required' && row.authMethod === 'oauth'
        ? { reauthorizationRequired: true }
        : {}),
    });
  }
  async function readyIntegration(workspaceId: string, userId: string, row: Metadata) {
    const metadata = integration(row);
    if (row.lifecycle === 'active' && metadata.status === 'review-required') {
      if (!(await discovery.validated(workspaceId, userId, row))) {
        metadata.status = 'setup';
        metadata.statusReason = 'Credentials are saved. Discover tools to validate this integration.';
      } else {
        const tools = await service.tools(workspaceId, userId, row.id);
        if (
          tools.some(
            tool => tool.present && tool.enabled_revision === tool.discovered_revision && !tool.compatibility_reason,
          )
        )
          metadata.status = 'ready';
      }
    }
    const current = await service.status(workspaceId, userId, row.id);
    if (current.version !== row.version || current.authorizationEpoch !== row.authorizationEpoch)
      throw new McpHttpError('mcp-conflict', 409);
    return metadata;
  }
  async function detail(workspaceId: string, userId: string, integrationId: string) {
    const row = await service.status(workspaceId, userId, integrationId);
    const tools = await service.tools(workspaceId, userId, integrationId);
    const grants =
      row.ownership === 'shared' && row.capabilities.manage
        ? await service.grants(workspaceId, userId, integrationId)
        : null;
    const grantOptions =
      row.ownership === 'shared' && row.capabilities.manage
        ? await authorized(workspaceId, userId, async (tx, actor) => {
            const members = z
              .array(z.object({ id: z.uuid(), user_id: z.string() }))
              .parse(
                (
                  await tx.client.query(
                    `SELECT id,user_id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY id`,
                  )
                ).rows,
              );
            const teams = z
              .array(z.object({ id: z.uuid(), name: z.string() }))
              .parse(
                (
                  await tx.client.query(
                    `SELECT t.id,t.name FROM ${qualified(tx.schema, 'tf_teams')} t JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=t.id WHERE mt.membership_id=$1 ORDER BY t.id`,
                    [actor.membershipId],
                  )
                ).rows,
              );
            return [
              ...members.map(member => ({ kind: 'member' as const, id: member.id, label: member.user_id })),
              ...teams.map(team => ({ kind: 'team' as const, id: team.id, label: team.name })),
            ];
          })
        : [];
    const current = await service.status(workspaceId, userId, integrationId);
    if (row.version !== current.version) throw new McpHttpError('mcp-conflict', 409);
    const metadata = await readyIntegration(workspaceId, userId, current);
    return mcpIntegrationDetailSchema.parse({
      integration: metadata,
      tools: tools
        .filter(tool => tool.present)
        .map(tool => ({
          name: tool.name,
          description: tool.tool.description,
          revision: tool.discovered_revision,
          previousRevision: null,
          inputSchema: tool.tool.inputSchema,
          outputSchema: tool.tool.outputSchema ?? null,
          compatibility: tool.compatibility_reason ? 'unsupported' : 'compatible',
          reason: tool.compatibility_reason,
          review:
            tool.enabled_revision === tool.discovered_revision
              ? 'reviewed'
              : tool.policy_version > 1
                ? 'changed'
                : 'new',
          enabled: tool.enabled_revision === tool.discovered_revision,
          standingException: tool.standing_exception,
        })),
      grants: grants
        ? [...grants.memberIds.map(id => ({ kind: 'member', id })), ...grants.teamIds.map(id => ({ kind: 'team', id }))]
        : [],
      managers: grants
        ? [
            ...grants.managers.memberIds.map(id => ({ kind: 'member', id })),
            ...grants.managers.teamIds.map(id => ({ kind: 'team', id })),
          ]
        : [],
      grantOptions,
      descriptor:
        current.ownership === 'shared' || current.descriptorApproved
          ? {
              kind: 'approved',
              id: current.serverIdentity,
              label: `Reviewed server ${current.serverIdentity.slice(0, 12)}`,
              identity: current.serverIdentity,
            }
          : {
              kind: 'reviewable',
              id: current.serverIdentity,
              label: `Server ${current.serverIdentity.slice(0, 12)}`,
              identity: current.serverIdentity,
            },
    });
  }
  function admitted() {
    if (!options.admissionEnabled) throw new McpHttpError('mcp-admission-disabled', 503);
  }
  async function queue(workspaceId: string, userId: string, integrationId: string, requestId: string) {
    if (!options.queueDiscovery) throw new McpHttpError('mcp-credential-unavailable', 503);
    const expectedVersion = await service.queueDiscovery(workspaceId, userId, integrationId);
    try {
      await options.queueDiscovery({ workspaceId, userId, integrationId, requestId, expectedVersion });
    } catch {
      await service.failDiscovery(
        workspaceId,
        integrationId,
        expectedVersion,
        'Tool discovery could not start. Try again.',
      );
      throw new McpHttpError('mcp-discovery-failed', 503);
    }
  }
  // Saved secrets are decrypted, and hosted packages run, only in the worker.
  const usesWorker = (row: Metadata) =>
    row.authMethod === 'secret-bearer' || row.authMethod === 'secret-headers' || row.kind === 'hosted';
  return {
    oauth,
    claimTaskSelection: service.claimTaskSelection,
    reserveChat(workspaceId: string, userId: string, chatId: string, requestId: string) {
      return createConversations(runtime).create(workspaceId, userId, { chatId, commandId: requestId });
    },
    ...options.permissions,
    ...workspaceMcpActions(options),
    ...workspaceMcpSelections({ ...options, integration: readyIntegration }),
    async capabilities(workspaceId: string, userId: string) {
      return runtime.transaction(workspaceId, workspaceMcpCompatibility, async tx => {
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
        await currentMember(tx, actor);
        return {
          enabled: true as const,
          canManageShared: true,
          integrationsEnabled: options.admissionEnabled,
          dispatchEnabled: options.dispatchEnabled,
          hosted: options.admissionEnabled && !!(await options.hostedEnabled?.(workspaceId)),
        };
      });
    },
    async catalog(workspaceId: string, userId: string, input: { search: string; cursor?: string | undefined }) {
      await authorized(workspaceId, userId, async () => undefined);
      return options.catalog.search(input.search, input.cursor);
    },
    async integrations(workspaceId: string, userId: string) {
      return {
        integrations: await Promise.all(
          (await service.list(workspaceId, userId)).map(row => readyIntegration(workspaceId, userId, row)),
        ),
      };
    },
    detail,
    async setup(
      workspaceId: string,
      userId: string,
      sessionId: string,
      input: z.infer<typeof mcpSetupSchema>,
      id?: string,
    ) {
      admitted();
      const auth = input.auth;
      if (
        (auth.kind === 'hosted') !== !!input.package ||
        (auth.kind === 'hosted' ? input.endpoint !== undefined : input.endpoint === undefined || !!input.egress)
      )
        throw new McpHttpError('invalid-request', 400);
      if (auth.kind === 'hosted' && !(await options.hostedEnabled?.(workspaceId)))
        throw new McpHttpError('mcp-disabled', 503);
      const endpoint = input.endpoint === undefined ? undefined : normalizeEndpoint(input.endpoint);
      const hosted = auth.kind === 'hosted' ? { package: input.package, egress: input.egress ?? [] } : {};
      const credential =
        auth.kind === 'oauth'
          ? { kind: 'none' as const }
          : auth.kind === 'headers'
            ? {
                kind: 'headers' as const,
                headers: Object.fromEntries(auth.headers.map(header => [header.name, header.value])),
              }
            : auth.kind === 'secrets'
              ? { kind: 'secret-headers' as const, secretIds: auth.secretIds }
              : auth;
      if (
        auth.kind === 'headers' &&
        new Set(auth.headers.map(header => header.name.toLowerCase())).size !== auth.headers.length
      )
        throw new McpHttpError('invalid-request', 400);
      if (credential.kind !== 'secret-headers' && credential.kind !== 'hosted') authenticationHeaders(credential);
      let row;
      if (id) {
        const current = await service.status(workspaceId, userId, id);
        if (current.ownership !== input.ownership || current.name !== input.name || input.expectedVersion === undefined)
          throw new McpHttpError('mcp-conflict', 409);
        row = await service.replaceCredential(workspaceId, userId, id, {
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          ...(endpoint === undefined ? {} : { endpoint }),
          credential,
          ...hosted,
        });
      } else {
        row = await service.create(workspaceId, userId, {
          requestId: input.requestId,
          name: input.name,
          ownership: input.ownership,
          ...(endpoint === undefined ? {} : { endpoint }),
          credential,
          ...hosted,
        });
      }
      if (auth.kind === 'oauth') {
        if (row.lifecycle === 'active') await service.setLifecycle(workspaceId, userId, row.id, 'disabled');
        const result = await oauth.begin(workspaceId, userId, sessionId, row.id, auth);
        const metadata = integration(await service.status(workspaceId, userId, row.id));
        if (result.kind === 'registration-required') metadata.status = 'registration-required';
        return { ...result, integration: metadata };
      }
      if (auth.kind === 'secrets' || auth.kind === 'hosted') {
        await queue(workspaceId, userId, row.id, mcpDiscoveryRequestId(input.requestId));
        return { kind: 'saved' as const, integration: integration(await service.status(workspaceId, userId, row.id)) };
      }
      await discovery.discover(workspaceId, userId, row.id, {
        requestId: mcpDiscoveryRequestId(input.requestId),
        expectedVersion: row.version,
      });
      return {
        kind: 'saved' as const,
        integration: await readyIntegration(workspaceId, userId, await service.status(workspaceId, userId, row.id)),
      };
    },
    async discover(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpMutationSchema>) {
      const before = await service.status(workspaceId, userId, id);
      if (usesWorker(before)) {
        if (before.version !== input.expectedVersion) throw new McpHttpError('mcp-conflict', 409);
        await queue(workspaceId, userId, id, input.requestId);
        return detail(workspaceId, userId, id);
      }
      const refreshed = await oauth.refresh(workspaceId, userId, id);
      if (refreshed.version !== before.version) throw new McpHttpError('mcp-conflict', 409);
      await discovery.discover(workspaceId, userId, id, input);
      return detail(workspaceId, userId, id);
    },
    async review(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpReviewSchema>) {
      await service.reviewTools(workspaceId, userId, id, input);
      return detail(workspaceId, userId, id);
    },
    async descriptor(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpDescriptorSchema>) {
      const current = await service.status(workspaceId, userId, id);
      if (!current.capabilities.manage) throw new AccessDenied();
      if (current.version !== input.expectedVersion) throw new McpHttpError('mcp-conflict', 409);
      await service.approveServerDescriptor(workspaceId, userId, id, input.serverIdentity);
      return detail(workspaceId, userId, id);
    },
    async grants(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpGrantsSchema>) {
      await service.setGrants(workspaceId, userId, id, {
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        memberIds: input.grants.filter(grant => grant.kind === 'member').map(grant => grant.id),
        teamIds: input.grants.filter(grant => grant.kind === 'team').map(grant => grant.id),
        ...(input.managers
          ? {
              managers: {
                memberIds: input.managers.filter(grant => grant.kind === 'member').map(grant => grant.id),
                teamIds: input.managers.filter(grant => grant.kind === 'team').map(grant => grant.id),
              },
            }
          : {}),
      });
      return detail(workspaceId, userId, id);
    },
    async lifecycle(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpLifecycleSchema>) {
      if (input.operation === 'enable') admitted();
      await service.setLifecycle(workspaceId, userId, id, input);
      return { saved: true as const };
    },
  };
}
