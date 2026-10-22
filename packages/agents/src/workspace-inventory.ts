import type { HumanActor, SourceDependency } from '@tulipfarm/access';
import { createAgentRecordTools } from './record-tools.ts';
import { createSavedAgentService } from './saved-service.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { createWorkflowDrafts } from './workflow-drafts.ts';
import { personalDefinitionSources } from './personal-definition-sources.ts';
import { requireDraftSources } from './draft-sources.ts';
import { withHuman } from './saved-policy.ts';
import type { AgentStorage } from './store.ts';

async function allPages<T>(read: (after?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await read(after);
    items.push(...page.items);
    if (page.nextCursor !== null && after !== undefined && page.nextCursor <= after)
      throw new Error('workspace-inventory-invalid-cursor');
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  return items;
}

export async function readWorkspaceInventory(runtime: AgentStorage, workspaceId: string, actor: HumanActor) {
  const tables = await allPages(async after => {
    const page = await createAgentRecordTools(runtime).listMetadata(workspaceId, actor, { after, limit: 100 });
    return { items: page.tables, nextCursor: page.nextCursor };
  });
  const agents = await allPages(async after => {
    const page = await createSavedAgentService(runtime).list(workspaceId, actor, { after, limit: 100 });
    return {
      items: page.agents.map(({ id, name, savedRevision, definitionRevision }) => ({
        id,
        name,
        savedRevision,
        definitionRevision,
      })),
      nextCursor: page.nextCursor,
    };
  });
  const workflows = (await createWorkflowDrafts(runtime, workspaceId).list(actor)).map(
    ({ id, definition, revision, activeRevision, enabled }) => ({
      id,
      name: definition.name,
      revision,
      activeRevision,
      enabled,
    }),
  );
  const skills = await allPages(async after => {
    const page = await createWorkspaceSkills(runtime).list(workspaceId, actor, { after, limit: 100, view: 'reviewed' });
    return {
      items: page.workspace.map(({ id, name, description, revision, status }) => ({
        id,
        name,
        description,
        revision,
        status,
      })),
      nextCursor: page.nextCursor,
    };
  });
  const sources: SourceDependency[] = [
    ...tables.map(table => ({ kind: 'table-schema' as const, tableId: table.id, revision: table.savedRevision })),
    ...agents.map(agent => ({ kind: 'agent-definition' as const, agentId: agent.id, revision: agent.savedRevision })),
    ...skills.map(skill => ({ kind: 'workspace-skill' as const, skillId: skill.id, revision: skill.revision })),
  ];
  const inherited = await withHuman(runtime, workspaceId, actor, 'read', async tx => {
    const dependencies: SourceDependency[] = [];
    for (const source of sources) {
      dependencies.push(...(await personalDefinitionSources(tx, [source])));
      await requireDraftSources(tx, actor, [source]);
    }
    return dependencies;
  });
  return {
    inventory: {
      visibility: 'requester-readable' as const,
      complete: true as const,
      tables,
      agents,
      workflows,
      skills,
    },
    sources: [...sources, ...inherited],
  };
}

export type WorkspaceInventory = Awaited<ReturnType<typeof readWorkspaceInventory>>['inventory'];
