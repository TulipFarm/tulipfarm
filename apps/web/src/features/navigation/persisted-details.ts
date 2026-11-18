import { z } from 'zod';
import type { QueryKey } from '@tanstack/react-query';
import { agentPolicyDetailSchema } from '@tulipfarm/agents/saved-contracts';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { fileSummarySchema } from '@tulipfarm/files/contracts';
import { queryResultSchema } from '@tulipfarm/tables/query';
import { definitionViewSchema } from '@tulipfarm/workflows/contracts';
import type { PersistedRead } from '@/lib/query/persisted-reads';
import { webAgentDetailSchema } from '@/features/agents/api';
import { appDetailSchema } from '@/features/apps/api';
import { projectDetailSchema } from '@/features/projects/api';
import { tableStateSchema } from '@/features/tables/api';

const matches = (schema: z.ZodType) => (key: QueryKey) => schema.safeParse(key).success;
const id = z.string().min(1);
const firstPage = z.looseObject({ after: z.undefined().optional(), search: z.undefined().optional() });
// A table's unsearched first page of rows at a definition revision; later pages and searches stay memory-only.
const firstRows = z.tuple([
  z.literal('tables'),
  z.literal('detail'),
  id,
  z.literal('records'),
  z.literal('query'),
  z.strictObject({
    revision: z.string(),
    request: z.union([z.strictObject({ rsql: z.string(), options: firstPage }), z.strictObject({ query: firstPage })]),
  }),
]);
const detail = (domain: string, ...rest: [z.ZodType, ...z.ZodType[]] | []) =>
  z.tuple([z.literal(domain), z.literal('detail'), id, ...rest]);

/** How many recently opened records of each kind stay on disk. */
const recent = 15;

/**
 * The records people opened most recently, so returning to one after a reload shows its last answer
 * while the network refreshes it. Histories, runs, single records and later pages stay memory-only.
 */
export const persistedDetailReads: PersistedRead[] = [
  { name: 'agent', limit: recent, match: matches(detail('agents')), schema: webAgentDetailSchema },
  {
    name: 'agent-policy',
    limit: recent,
    match: matches(detail('agents', z.literal('policy'))),
    schema: agentPolicyDetailSchema,
  },
  { name: 'task', limit: recent, match: matches(detail('tasks', z.literal('summary'))), schema: taskSummarySchema },
  {
    name: 'workflow',
    limit: recent,
    match: matches(detail('workflows', z.literal('definition'), z.literal('saved'))),
    schema: definitionViewSchema,
  },
  { name: 'table', limit: recent, match: matches(detail('tables', z.literal('definition'))), schema: tableStateSchema },
  // A table page can also read board or summary counts, so allow more than one per table.
  { name: 'table-rows', limit: recent * 2, match: matches(firstRows), schema: queryResultSchema },
  {
    name: 'file',
    limit: recent,
    match: matches(z.tuple([z.literal('files'), z.literal('item'), id])),
    schema: fileSummarySchema,
  },
  { name: 'project', limit: recent, match: matches(detail('projects')), schema: projectDetailSchema },
  { name: 'app', limit: recent, match: matches(detail('apps')), schema: appDetailSchema },
];
