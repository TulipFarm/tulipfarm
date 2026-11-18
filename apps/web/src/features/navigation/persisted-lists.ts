import { z } from 'zod';
import type { QueryKey } from '@tanstack/react-query';
import { agentContextSchema, agentListSchema } from '@tulipfarm/agents/saved-contracts';
import { libraryPageSchema } from '@tulipfarm/files/contracts';
import { workflowSchema } from '@tulipfarm/workflows/contracts';
import type { PersistedRead } from '@/lib/query/persisted-reads';
import { appSummarySchema } from '@/features/apps/api';
import { knowledgeEntrySchema } from '@/features/files/knowledge-api';
import { skillListSchema } from '@/features/skills/api';
import { tableListSchema } from '@/features/tables/api';
import { taskListSchema } from '@/features/tasks/api';

const matches = (schema: z.ZodType) => (key: QueryKey) => schema.safeParse(key).success;
const firstPage = <T extends z.ZodRawShape>(domain: string, shape: T) =>
  z.tuple([z.literal(domain), z.literal('list'), z.strictObject({ after: z.null(), ...shape })]);

const agentsKey = firstPage('agents', { search: z.literal(''), archived: z.boolean() });
const agentContextKey = z.tuple([z.literal('agents'), z.literal('authoring-context')]);
const tasksKey = firstPage('tasks', { search: z.literal('') });
const workflowsKey = z.tuple([z.literal('workflows'), z.literal('list')]);
const tablesKey = firstPage('tables', { search: z.null(), sort: z.string().nullable(), archived: z.boolean() });
const skillsKey = firstPage('skills', { search: z.literal(''), view: z.string() });
const appsKey = z.tuple([z.literal('apps'), z.literal('list')]);
const knowledgeKey = z.tuple([z.literal('knowledge'), z.literal('personal')]);
// Unsearched, unfiltered first pages of a files section, at its root or in a folder.
const filesKey = z.tuple([
  z.literal('files'),
  z.literal('library'),
  z.strictObject({
    section: z.string(),
    location: z.union([
      z.strictObject({ kind: z.literal('root') }),
      z.strictObject({ kind: z.literal('folder'), id: z.string() }),
    ]),
    query: z.literal(''),
    sort: z.strictObject({ key: z.string(), direction: z.string() }),
    filters: z.strictObject({}),
  }),
]);

/**
 * The first page of each top-level list, so opening a list after a reload shows the last answer
 * while the network refreshes it. Searches, later pages and filtered views stay memory-only.
 */
export const persistedListReads: PersistedRead[] = [
  { name: 'agents', limit: 2, match: matches(agentsKey), schema: agentListSchema },
  { name: 'agent-context', limit: 1, match: matches(agentContextKey), schema: agentContextSchema },
  { name: 'tasks', limit: 1, match: matches(tasksKey), schema: taskListSchema },
  { name: 'workflows', limit: 1, match: matches(workflowsKey), schema: workflowSchema.array() },
  { name: 'tables', limit: 3, match: matches(tablesKey), schema: tableListSchema },
  { name: 'skills', limit: 3, match: matches(skillsKey), schema: skillListSchema },
  { name: 'apps', limit: 1, match: matches(appsKey), schema: appSummarySchema.array() },
  { name: 'knowledge', limit: 1, match: matches(knowledgeKey), schema: knowledgeEntrySchema.array() },
  { name: 'files', limit: 6, match: matches(filesKey), schema: libraryPageSchema },
];
