import { z } from 'zod';
import { currentMember, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import {
  mcpSelectionSubjectSchema,
  workspaceMcpCompatibility,
  type WorkspaceMcpOptions,
  type WorkspaceMcpService,
} from '@tulipfarm/workspace-mcp';
import { McpHttpError } from './workspace-mcp-http.ts';
import {
  mcpSelectionSchema,
  type mcpIntegrationSchema,
  type mcpSelectionInput,
  type mcpSelectionParams,
  type mcpSelectionQuery,
} from './workspace-mcp-contracts.ts';

export function workspaceMcpSelections(options: {
  runtime: WorkspaceMcpOptions['runtime'];
  service: WorkspaceMcpService;
  dispatchEnabled: boolean;
  authorizeSelection: NonNullable<WorkspaceMcpOptions['authorizeSelection']>;
  authorizeSources: WorkspaceMcpOptions['authorizeSources'];
  integration: (
    workspaceId: string,
    userId: string,
    row: Awaited<ReturnType<WorkspaceMcpService['status']>>,
  ) => Promise<z.infer<typeof mcpIntegrationSchema>>;
}) {
  const { service } = options;
  const subject = (params: z.infer<typeof mcpSelectionParams>, agentId?: string) =>
    mcpSelectionSubjectSchema.parse({
      kind: params.kind,
      id: params.originId,
      ...(params.kind === 'task-draft' ? { agentId } : {}),
    });
  async function authority(params: z.infer<typeof mcpSelectionParams>, userId: string, agentId?: string) {
    return options.runtime.transaction(params.workspaceId, workspaceMcpCompatibility, async transaction => {
      await lockAuthorization(transaction);
      const actor = await resolveHuman(transaction, userId);
      await currentMember(transaction, actor);
      const result = await options.authorizeSelection({ transaction, actor, subject: subject(params, agentId) });
      await options.authorizeSources({ transaction, actor, sources: result.sources });
      return result;
    });
  }
  async function selection(
    params: z.infer<typeof mcpSelectionParams>,
    userId: string,
    input: z.infer<typeof mcpSelectionQuery>,
  ) {
    const origin = subject(params, input.agentId);
    const authorized = await authority(params, userId, input.agentId);
    const current = await service.selectionFor(params.workspaceId, userId, origin);
    const choices: z.infer<typeof mcpSelectionSchema>['choices'] = [];
    for (const row of await service.list(params.workspaceId, userId)) {
      if (!row.capabilities.use) continue;
      const integration = await options.integration(params.workspaceId, userId, row);
      const unavailableReason =
        row.lifecycle !== 'active'
          ? 'Reconnect or enable this integration.'
          : row.blocked
            ? 'Reconcile its unresolved action before use.'
            : null;
      if (origin.kind === 'chat') choices.push({ integration, slotId: null, slotLabel: null, unavailableReason });
      else {
        if (row.ownership === 'personal' && !row.descriptorApproved) continue;
        const tools = await service.tools(params.workspaceId, userId, row.id);
        for (const slot of authorized.slots ?? []) {
          if (
            slot.serverIdentity !== row.serverIdentity ||
            (slot.integrationId && (slot.integrationId !== row.id || row.ownership !== 'shared'))
          )
            continue;
          const compatible = slot.tools.every(tool =>
            tools.some(
              candidate =>
                candidate.name === tool.name &&
                candidate.present &&
                candidate.enabled_revision === tool.revision &&
                candidate.discovered_revision === tool.revision &&
                !candidate.compatibility_reason,
            ),
          );
          choices.push({
            integration,
            slotId: slot.slotId,
            slotLabel: slot.slotId,
            unavailableReason:
              unavailableReason ??
              (compatible ? null : 'Review the agent’s exact tool revisions before selecting this integration.'),
          });
        }
      }
    }
    const latest = await service.selectionFor(params.workspaceId, userId, origin);
    if (latest.version !== current.version) throw new McpHttpError('mcp-conflict', 409);
    return mcpSelectionSchema.parse({
      id: params.originId,
      version: current.version,
      bindings: current.bindings.map(binding => ({
        integrationId: binding.integrationId,
        slotId: binding.slotId ?? null,
      })),
      stale: current.stale || current.claimedTaskId !== null,
      choices,
    });
  }
  return {
    selection,
    async select(params: z.infer<typeof mcpSelectionParams>, userId: string, input: z.infer<typeof mcpSelectionInput>) {
      if (!options.dispatchEnabled) throw new McpHttpError('mcp-dispatch-disabled', 503);
      await service.selectFor(params.workspaceId, userId, {
        origin: subject(params, input.agentId),
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        bindings: input.bindings,
      });
      return selection(params, userId, input.agentId ? { agentId: input.agentId } : {});
    },
  };
}
