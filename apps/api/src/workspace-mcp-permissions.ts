import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createSavedAgentService } from '@tulipfarm/agents/saved-service';
import { mcpPermissionSlotsSchema } from '@tulipfarm/workspaces/agent-document';
import type { WorkspaceMcpService } from '@tulipfarm/workspace-mcp';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { readVerifiedProjection } from '@tulipfarm/workspaces/soul-revisions';
import { soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { McpHttpError } from './workspace-mcp-http.ts';
import { mcpPermissionsSchema, type mcpPermissionInput } from './workspace-mcp-contracts.ts';
import { mcpPermissionRevisions } from './workspace-mcp-permission-revisions.ts';

export function workspaceMcpPermissions(runtime: WorkspaceRuntime, mcp: WorkspaceMcpService) {
  let storage: ReturnType<typeof soulStorageConfig> | undefined;
  const agents = createSavedAgentService(runtime, (workspaceId, projection) => {
    storage ??= soulStorageConfig('read');
    return readVerifiedProjection(storage, workspaceId, projection);
  });
  const authoring = createAgentAuthoring(runtime);
  async function permissions(workspaceId: string, userId: string, agentId: string) {
    const agent = await agents.detail(workspaceId, userId, agentId);
    const slots = (agent.definition.mcp ?? []).map(slot => ({
      slotId: slot.id,
      serverIdentity: slot.serverIdentity,
      label: slot.id,
      binding: slot.integrationId
        ? { kind: 'shared' as const, integrationId: slot.integrationId }
        : { kind: 'personal' as const },
      tools: slot.tools,
    }));
    return mcpPermissionsSchema.parse({
      ...mcpPermissionRevisions(agent),
      canEdit: agent.capabilities.includes('edit'),
      slots,
      choices: await permissionChoices(workspaceId, userId),
    });
  }
  async function permissionChoices(workspaceId: string, userId: string) {
    const choices = [];
    for (const row of await mcp.list(workspaceId, userId)) {
      if (
        !row.capabilities.manage ||
        row.lifecycle !== 'active' ||
        (row.ownership === 'personal' && !row.descriptorApproved)
      )
        continue;
      const tools = (await mcp.tools(workspaceId, userId, row.id))
        .filter(
          tool => tool.present && tool.enabled_revision === tool.discovered_revision && !tool.compatibility_reason,
        )
        .map(tool => ({ name: tool.name, revision: tool.discovered_revision }));
      if (tools.length)
        choices.push({
          slotId: row.ownership === 'shared' ? `shared-${row.id}` : `server-${row.serverIdentity.slice(0, 32)}`,
          serverIdentity: row.serverIdentity,
          label: row.ownership === 'shared' ? row.name : `Reviewed server ${row.serverIdentity.slice(0, 12)}`,
          binding:
            row.ownership === 'shared'
              ? { kind: 'shared' as const, integrationId: row.id }
              : { kind: 'personal' as const },
          tools,
        });
    }
    return choices;
  }
  return {
    permissions,
    permissionChoices,
    async setPermissions(
      workspaceId: string,
      userId: string,
      agentId: string,
      input: z.infer<typeof mcpPermissionInput>,
    ) {
      const current = await permissions(workspaceId, userId, agentId);
      if (!current.canEdit || current.savedRevision !== input.expectedSavedRevision)
        throw new McpHttpError('mcp-conflict', 409);
      for (const slot of input.slots) {
        const candidates = [...current.slots, ...current.choices];
        if (
          !candidates.some(
            choice =>
              choice.serverIdentity === slot.serverIdentity &&
              choice.binding.kind === slot.binding.kind &&
              (choice.binding.kind !== 'shared' ||
                (slot.binding.kind === 'shared' && choice.binding.integrationId === slot.binding.integrationId)) &&
              slot.tools.every(tool =>
                choice.tools.some(allowed => allowed.name === tool.name && allowed.revision === tool.revision),
              ),
          )
        )
          throw new McpHttpError('mcp-permission-unavailable', 409);
      }
      const slots = mcpPermissionSlotsSchema.parse(
        input.slots.map(slot => ({
          id: slot.slotId,
          serverIdentity: slot.serverIdentity,
          tools: slot.tools,
          ...(slot.binding.kind === 'shared' ? { integrationId: slot.binding.integrationId } : {}),
        })),
      );
      const agent = await agents.detail(workspaceId, userId, agentId);
      const context = await agents.context(workspaceId, userId);
      if (agent.savedRevision !== input.expectedSavedRevision) throw new McpHttpError('mcp-conflict', 409);
      let receipt = await authoring.save(workspaceId, userId, agentId, {
        requestId: input.requestId,
        expectedSoulRevision: context.currentSoulRevision,
        expectedSavedRevision: input.expectedSavedRevision,
        owningTeamId: agent.owningTeamId,
        definition: { ...agent.definition, mcp: slots },
      });
      const deadline = Date.now() + 20_000;
      while (receipt.status === 'preparing' && Date.now() < deadline) {
        await delay(250);
        receipt = await authoring.commandStatus(workspaceId, userId, receipt.commandId);
      }
      if (receipt.status === 'preparing') throw new McpHttpError('mcp-permission-save-pending', 503);
      if (receipt.status !== 'accepted') throw new McpHttpError('mcp-conflict', 409);
      return permissions(workspaceId, userId, agentId);
    },
    close() {
      storage?.client.destroy();
    },
  };
}
