import { AccessDenied, currentMember, type HumanActor, type SourceDependency } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createAgentRecordTools } from './record-tools.ts';
import { createSavedAgentService } from './saved-service.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { createWorkflowDrafts } from './workflow-drafts.ts';
import { personalDefinitionSources } from './personal-definition-sources.ts';
import { requireDraftSources } from './draft-sources.ts';
import { withHuman } from './saved-policy.ts';
import type { AgentStorage } from './store.ts';
import { relation } from './store.ts';
import { activeMembers } from './members.ts';
import { directoryNameLimit } from './workspace-directory.ts';
import { z } from 'zod';

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

/**
 * Lists what the requester can read, for a reply's context. An item whose sources the requester can no longer read is
 * left out. A workspace whose storage is not yet on a version every listing reads has no inventory, so the model lists
 * through its tools instead.
 */
export async function readWorkspaceInventory(runtime: AgentStorage, workspaceId: string, actor: HumanActor) {
  try {
    return await listWorkspaceInventory(runtime, workspaceId, actor);
  } catch (error) {
    if (error instanceof StorageUnavailableError && error.code === 'incompatible_version')
      return { inventory: undefined, sources: [] };
    throw error;
  }
}

async function listWorkspaceInventory(runtime: AgentStorage, workspaceId: string, actor: HumanActor) {
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
  const tableSource = (table: (typeof tables)[number]): SourceDependency => ({
    kind: 'table-schema',
    tableId: table.id,
    revision: table.savedRevision,
  });
  const agentSource = (agent: (typeof agents)[number]): SourceDependency => ({
    kind: 'agent-definition',
    agentId: agent.id,
    revision: agent.savedRevision,
  });
  const skillSource = (skill: (typeof skills)[number]): SourceDependency => ({
    kind: 'workspace-skill',
    skillId: skill.id,
    revision: skill.revision,
  });
  const readable = await withHuman(runtime, workspaceId, actor, 'read', async tx => {
    // Only an item's own sources may leave it out; a requester who is no longer a member still fails.
    await currentMember(tx, actor);
    const memberIds = z
      .array(z.object({ id: z.uuid() }))
      .parse(
        (
          await tx.client.query(
            `SELECT id FROM ${relation(tx, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY id LIMIT $1`,
            [directoryNameLimit + 1],
          )
        ).rows,
      );
    const teamNames = z
      .array(z.object({ name: z.string() }))
      .parse(
        (
          await tx.client.query(`SELECT name FROM ${relation(tx, 'tf_teams')} ORDER BY id LIMIT $1`, [
            directoryNameLimit + 1,
          ])
        ).rows,
      );
    const members =
      memberIds.length && memberIds.length <= directoryNameLimit
        ? await activeMembers(
            tx,
            memberIds.map(member => member.id),
          )
        : [];
    const directoryNames = {
      members: members
        .filter(member => !member.name.includes('@') && member.name !== 'Unnamed member')
        .map(member => member.name),
      teams:
        teamNames.length <= directoryNameLimit
          ? teamNames.map(team => (team.name === '_admin' ? 'Workspace admins' : team.name))
          : [],
    };
    const inherited: SourceDependency[] = [];
    async function keep<T>(items: readonly T[], sourceOf: (item: T) => SourceDependency) {
      const kept: T[] = [];
      for (const item of items) {
        const source = sourceOf(item);
        try {
          const dependencies = await personalDefinitionSources(tx, [source]);
          await requireDraftSources(tx, actor, [source]);
          inherited.push(...dependencies);
          kept.push(item);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
        }
      }
      return kept;
    }
    return {
      tables: await keep(tables, tableSource),
      agents: await keep(agents, agentSource),
      skills: await keep(skills, skillSource),
      inherited,
      directoryNames,
    };
  });
  return {
    inventory: {
      visibility: 'requester-readable' as const,
      complete: true as const,
      tables: readable.tables,
      agents: readable.agents,
      workflows,
      skills: readable.skills,
      directoryNames: readable.directoryNames,
    },
    sources: [
      ...readable.tables.map(tableSource),
      ...readable.agents.map(agentSource),
      ...readable.skills.map(skillSource),
      ...readable.inherited,
    ],
  };
}

export type WorkspaceInventory = NonNullable<Awaited<ReturnType<typeof readWorkspaceInventory>>['inventory']>;
