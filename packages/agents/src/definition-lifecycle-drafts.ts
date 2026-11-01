import { createHash } from 'node:crypto';
import { AccessDenied, requireSkillGrant, type HumanActor } from '@tulipfarm/access';
import type { DefinitionLifecycleProposal, DraftOutcome } from './draft-contracts.ts';
import { createSavedAgentService } from './saved-service.ts';
import { requireAgentPermission } from './saved-policy.ts';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';

function lifecycleCommandId(kind: DefinitionLifecycleProposal['kind'], commandId: string, id: string) {
  const hex = createHash('sha256').update(`${kind}:${commandId}:${id}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function agentStates(tx: AgentTransaction, ids: string[]) {
  const rows = (
    await tx.client.query(
      `SELECT id, deleted_at IS NOT NULL AS deleted, archived_at IS NOT NULL AS archived FROM ${relation(tx, 'tf_agents')} WHERE id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows as { id: string; deleted: boolean; archived: boolean }[];
  return new Map(rows.map(row => [row.id, row]));
}

export function createDefinitionLifecycleDrafts(storage: AgentStorage, workspaceId: string) {
  async function writable(tx: AgentTransaction, actor: HumanActor, proposal: DefinitionLifecycleProposal) {
    if (proposal.kind === 'agent-archive' || proposal.kind === 'agent-restore') {
      const states = await agentStates(
        tx,
        proposal.input.agents.map(item => item.id),
      );
      // A replayed approval finds agents already moved, so check permission in whichever state each agent is in now.
      for (const item of proposal.input.agents)
        await requireAgentPermission(tx, actor, item.id, 'delete', { archived: !!states.get(item.id)?.archived });
      return;
    }
    for (const item of proposal.input.skills) await requireSkillGrant(tx, actor, item.id, 'manage');
  }

  async function stale(tx: AgentTransaction, proposal: DefinitionLifecycleProposal) {
    if (proposal.kind === 'agent-archive' || proposal.kind === 'agent-restore') {
      const states = await agentStates(
        tx,
        proposal.input.agents.map(item => item.id),
      );
      return proposal.input.agents.some(item => {
        const state = states.get(item.id);
        if (!state) return true;
        return proposal.kind === 'agent-archive' ? state.deleted : !state.archived;
      });
    }
    const rows = (
      await tx.client.query(
        `SELECT id, version, deleted_at IS NOT NULL AS deleted, archived_at IS NOT NULL AS archived FROM ${relation(tx, 'tf_workspace_skills')} WHERE id = ANY($1::uuid[])`,
        [proposal.input.skills.map(item => item.id)],
      )
    ).rows as { id: string; version: number; deleted: boolean; archived: boolean }[];
    const states = new Map(rows.map(row => [row.id, row]));
    return proposal.input.skills.some(item => {
      const state = states.get(item.id);
      if (!state || state.deleted || Number(state.version) !== item.version) return true;
      return proposal.kind === 'skill-archive' ? state.archived : !state.archived;
    });
  }

  async function apply(
    actor: HumanActor,
    commandId: string,
    proposal: DefinitionLifecycleProposal,
  ): Promise<DraftOutcome> {
    if (proposal.kind === 'agent-archive' || proposal.kind === 'agent-restore') {
      const agents = createSavedAgentService(storage);
      for (const item of proposal.input.agents)
        await (proposal.kind === 'agent-archive' ? agents.archive : agents.restore)(workspaceId, actor, item.id);
      return { kind: proposal.kind, agentIds: proposal.input.agents.map(item => item.id) };
    }
    const skills = createWorkspaceSkills(storage);
    for (const item of proposal.input.skills) {
      const receipt = await skills.setLifecycle(workspaceId, actor, item.id, {
        requestId: lifecycleCommandId(proposal.kind, commandId, item.id),
        expectedVersion: item.version,
        lifecycle: proposal.kind === 'skill-archive' ? 'archived' : 'active',
      });
      if (!receipt) throw new AccessDenied();
    }
    return { kind: proposal.kind, skillIds: proposal.input.skills.map(item => item.id) };
  }

  return { writable, stale, apply };
}
