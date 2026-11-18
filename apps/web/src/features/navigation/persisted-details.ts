import { z } from 'zod';
import type { QueryKey } from '@tanstack/react-query';
import { agentPolicyDetailSchema } from '@tulipfarm/agents/saved-contracts';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { definitionViewSchema } from '@tulipfarm/workflows/contracts';
import type { PersistedRead } from '@/lib/query/persisted-reads';
import { webAgentDetailSchema } from '@/features/agents/api';
import { appDetailSchema } from '@/features/apps/api';
import { projectDetailSchema } from '@/features/projects/api';
import { tableStateSchema } from '@/features/tables/api';

const matches = (schema: z.ZodType) => (key: QueryKey) => schema.safeParse(key).success;
const id = z.string().min(1);
const detail = (domain: string, ...rest: [z.ZodType, ...z.ZodType[]] | []) =>
  z.tuple([z.literal(domain), z.literal('detail'), id, ...rest]);

/** How many recently opened records of each kind stay on disk. */
const recent = 15;

/**
 * The records people opened most recently, so returning to one after a reload shows its last answer
 * while the network refreshes it. Histories, runs, record pages and other revisions stay memory-only.
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
  { name: 'project', limit: recent, match: matches(detail('projects')), schema: projectDetailSchema },
  { name: 'app', limit: recent, match: matches(detail('apps')), schema: appDetailSchema },
];
