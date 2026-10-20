import { AccessDenied, sourceDependenciesSchema, type HumanActor, type SourceDependency } from '@tulipfarm/access';
import { relation, type AgentTransaction } from './store.ts';
import { requireDraftSources } from './draft-sources.ts';
import { personalDefinitionSources, requirePersonalDefinitionSources } from './personal-definition-sources.ts';

export async function savedSkillSources(
  tx: AgentTransaction,
  id: string,
  revision: string,
): Promise<SourceDependency[]> {
  const row = (
    await tx.client.query(
      `SELECT definition FROM ${relation(tx, 'tf_workspace_skill_revisions')} WHERE skill_id=$1 AND revision=$2`,
      [id, revision],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  const sources = sourceDependenciesSchema.parse(row.definition.sources ?? []);
  const drafts = await tx.client.query(
    `SELECT d.sources FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE d.proposal->>'targetId'=$1 AND c.outcome->>'kind'='skill' AND c.outcome->'receipt'->>'savedRevision'=$2`,
    [id, revision],
  );
  for (const draft of drafts.rows) sources.push(...sourceDependenciesSchema.parse(draft.sources));
  return sourceDependenciesSchema.parse([...new Map(sources.map(source => [JSON.stringify(source), source])).values()]);
}

export async function requireSavedSkillSources(tx: AgentTransaction, id: string, revision: string, actor?: HumanActor) {
  const sources = await savedSkillSources(tx, id, revision);
  if (!sources.length) return;
  if (!actor) {
    await requirePersonalDefinitionSources(tx, sources);
    return;
  }
  if ((await personalDefinitionSources(tx, sources)).length) await requireDraftSources(tx, actor, sources);
}
