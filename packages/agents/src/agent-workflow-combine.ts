import { z } from 'zod';
import { lockAuthorization } from '@tulipfarm/access';
import { workflowTriggersCommonVersion } from '@tulipfarm/workflows/authorization';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { agentLinkedWorkflowId, combineAgentWorkflows, type AgentWorkflowOptions } from './agent-trigger-workflows.ts';
import { boundRuntime } from './task-approval-gate.ts';
import { relation, type AgentStorage } from './store.ts';

/**
 * Combines each agent's per-trigger Workflows into its one linked Workflow, one agent per transaction. Agents whose
 * Workflows differ in prompt, limits, activation, sponsor or audience keep them until their next approved setup.
 */
export function createAgentWorkflowCombine(runtime: AgentStorage, options: AgentWorkflowOptions = {}) {
  // Agents left as they are; a restart checks them again.
  const settled = new Set<string>();
  async function combine(workspaceId: string, onError?: (agentId: string, error: unknown) => void) {
    const pending = await runtime.transaction(workspaceId, commonCompatibility, async tx => {
      if (tx.commonVersion < workflowTriggersCommonVersion) return [];
      const agents = z
        .array(z.object({ agent_id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT DISTINCT w.agent_id FROM ${relation(tx, 'tf_workflows')} w JOIN ${relation(tx, 'tf_agents')} a ON a.id=w.agent_id WHERE w.archived_at IS NULL AND a.deleted_at IS NULL ORDER BY w.agent_id`,
            )
          ).rows,
        )
        .map(row => row.agent_id)
        .filter(id => !settled.has(`${workspaceId} ${id}`));
      if (!agents.length) return [];
      const linked = new Set(
        (
          await tx.client.query(`SELECT id FROM ${relation(tx, 'tf_workflows')} WHERE id=ANY($1::uuid[])`, [
            agents.map(agentLinkedWorkflowId),
          ])
        ).rows.map(row => String(row.id)),
      );
      return agents.filter(id => !linked.has(agentLinkedWorkflowId(id))).slice(0, 20);
    });
    for (const agentId of pending) {
      try {
        const result = await runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx, 'write');
          return combineAgentWorkflows(tx, boundRuntime(tx, workspaceId), workspaceId, agentId, options);
        });
        if (result !== 'combined') settled.add(`${workspaceId} ${agentId}`);
      } catch (error) {
        settled.add(`${workspaceId} ${agentId}`);
        onError?.(agentId, error);
      }
    }
  }
  return { combine };
}
