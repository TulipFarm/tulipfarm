import {
  AccessDenied,
  mcpSourceClosure,
  requireMcpSource,
  requirePersonalGitHubSource,
  sourceDependenciesSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { relation, type AgentTransaction } from './store.ts';
import { savedSkillSources } from './skill-sources.ts';

export async function personalDefinitionSources(
  tx: AgentTransaction,
  sources: readonly SourceDependency[],
  visited = new Set<string>(),
): Promise<SourceDependency[]> {
  const references: SourceDependency[] = [];
  if (!visited.size)
    for (const source of sources) {
      if (source.kind === 'agent-definition' && source.revision === 'all-saved-revisions') {
        const saved = await tx.client.query(
          `SELECT soul_revision FROM ${relation(tx, 'tf_agent_saved_revisions')} WHERE agent_id=$1`,
          [source.agentId],
        );
        references.push(
          ...sourceDependenciesSchema.parse(
            saved.rows.map(row => ({ kind: 'agent-definition', agentId: source.agentId, revision: row.soul_revision })),
          ),
        );
      } else references.push(source);
    }
  const retained: SourceDependency[] = visited.size ? [] : await mcpSourceClosure(tx, references);
  for (const source of sources) {
    const key = JSON.stringify(source);
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > 1000) throw new AccessDenied();
    if (source.kind === 'github-personal' || source.kind === 'mcp-integration') {
      retained.push(source);
    }
    if (source.kind === 'workspace-skill')
      retained.push(
        ...(await personalDefinitionSources(tx, await savedSkillSources(tx, source.skillId, source.revision), visited)),
      );
    if (source.kind === 'agent-definition') {
      const rows = await tx.client.query(
        `SELECT d.sources FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE d.proposal->>'targetId'=$1 AND c.outcome->>'kind'='agent'`,
        [source.agentId],
      );
      for (const row of rows.rows)
        retained.push(...(await personalDefinitionSources(tx, sourceDependenciesSchema.parse(row.sources), visited)));
      const definitions = await tx.client.query(
        `SELECT definition->'skills' AS skills FROM ${relation(tx, 'tf_agent_definitions')} WHERE agent_id=$1`,
        [source.agentId],
      );
      for (const row of definitions.rows) {
        for (const skill of row.skills ?? []) {
          const reference = sourceDependenciesSchema.safeParse([
            { kind: 'workspace-skill', skillId: skill.id, revision: skill.revision },
          ]);
          if (
            reference.success &&
            (
              await tx.client.query(
                `SELECT 1 FROM ${relation(tx, 'tf_workspace_skill_revisions')} WHERE skill_id=$1 AND revision=$2`,
                [skill.id, skill.revision],
              )
            ).rowCount
          )
            retained.push(...(await personalDefinitionSources(tx, reference.data, visited)));
        }
      }
    }
  }
  return retained;
}

export async function requirePersonalDefinitionSources(
  tx: AgentTransaction,
  sources: readonly SourceDependency[],
  actor?: HumanActor,
) {
  for (const source of await personalDefinitionSources(tx, sources)) {
    if (!actor) throw new AccessDenied();
    if (source.kind === 'mcp-integration') await requireMcpSource(tx, actor, source);
    else if (source.kind === 'github-personal') await requirePersonalGitHubSource(tx, actor, source);
    else throw new AccessDenied();
  }
}
