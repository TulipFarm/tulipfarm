import { currentMember, type HumanActor } from '@tulipfarm/access';
import { createProjectMembership, requireProjectAccess } from '@tulipfarm/conversations/project-membership';
import type { DraftOutcome, ProjectProposal } from './draft-contracts.ts';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';

export function createProjectDrafts(storage: AgentStorage, workspaceId: string) {
  async function writable(tx: AgentTransaction, actor: HumanActor, proposal: ProjectProposal) {
    if (proposal.input.current) await requireProjectAccess(tx, actor, proposal.targetId, true);
    else await currentMember(tx, actor);
  }

  async function stale(tx: AgentTransaction, proposal: ProjectProposal) {
    const row = (
      await tx.client.query(`SELECT revision FROM ${relation(tx, 'tf_projects')} WHERE id=$1`, [proposal.targetId])
    ).rows[0] as { revision: number } | undefined;
    return proposal.input.expectedRevision === null ? !!row : row?.revision !== proposal.input.expectedRevision;
  }

  async function apply(actor: HumanActor, proposal: ProjectProposal): Promise<DraftOutcome> {
    const projects = createProjectMembership(storage);
    const { settings, expectedRevision } = proposal.input;
    let project =
      expectedRevision === null
        ? await projects.create(workspaceId, actor.userId, { id: proposal.targetId, name: settings.name })
        : null;
    const revision = project ? project.revision : expectedRevision!;
    if (!project || project.instructions !== settings.instructions)
      project = await projects.edit(workspaceId, actor.userId, proposal.targetId, {
        expectedRevision: revision,
        ...settings,
      });
    return { kind: 'project', projectId: project.id, revision: project.revision };
  }

  return { writable, stale, apply };
}
