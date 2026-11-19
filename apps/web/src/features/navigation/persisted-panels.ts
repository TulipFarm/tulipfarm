import { z } from 'zod';
import type { QueryKey } from '@tanstack/react-query';
import { planListItemSchema, planViewSchema } from '@tulipfarm/agents/plan-contracts';
import { definitionSharingCandidatesSchema } from '@tulipfarm/agents/saved-contracts';
import { agentLinkedWorkflowSchema } from '@tulipfarm/agents/setup-contracts';
import { skillHistoryPageSchema, skillProvenanceSchema } from '@tulipfarm/agents/skill-import-contracts';
import { taskBatchStatusSchema } from '@tulipfarm/agents/task-approval-contracts';
import { taskMessageSchema } from '@tulipfarm/agents/task-contracts';
import { skillSharingSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { fileDetailsSchema, fileSharingSnapshotSchema, fileVersionsSchema } from '@tulipfarm/files/contracts';
import { integrationDetailSchema as githubIntegrationSchema } from '@tulipfarm/integrations/contracts';
import {
  providerIntegrationSchema,
  providerStatusSchema,
  runDetailSchema,
  runHistoryPageSchema,
  workflowSchema,
} from '@tulipfarm/workflows/contracts';
import { accountSignInMethodsSchema } from '@tulipfarm/workspaces/contracts';
import type { PersistedRead } from '@/lib/query/persisted-reads';
import { appGrantSchema, appReleaseSchema } from '@/features/apps/api';
import { subscriptionSchema } from '@/features/models/subscriptions';
import { skillDetailSchema } from '@/features/skills/api';
import {
  agentPermissionsSchema,
  integrationDetailSchema as mcpIntegrationSchema,
} from '@/features/workspace-mcp/contracts';

const matches = (schema: z.ZodType) => (key: QueryKey) => schema.safeParse(key).success;
const exactly = (...parts: string[]) => {
  const text = JSON.stringify(parts);
  return (key: QueryKey) => JSON.stringify(key) === text;
};
const id = z.string().min(1);
const under = (...parts: [z.ZodType, ...z.ZodType[]]) => matches(z.tuple(parts));
const literal = (value: string) => z.literal(value);
const taskHistory = z.object({ messages: z.array(taskMessageSchema), nextCursor: z.number().nullable() });

/** How many recently opened records keep each panel on disk, matching the record reads themselves. */
const recent = 15;
// Transcripts and documents can be large, and every saved read is parsed when the app starts.
const large = 5;

/**
 * The panels and settings a page shows beside its record, so a reload shows their last answer while the
 * network refreshes them. Later pages, filtered views, searches, receipts and file bytes stay memory-only.
 */
export const persistedPanelReads: PersistedRead[] = [
  {
    name: 'sign-in-methods',
    limit: 1,
    match: exactly('account', 'sign-in-methods'),
    schema: accountSignInMethodsSchema,
  },
  {
    name: 'plan-subscriptions',
    limit: 1,
    match: exactly('models', 'subscriptions'),
    schema: z.array(subscriptionSchema),
  },
  {
    name: 'task-context',
    limit: large,
    match: under(literal('tasks'), literal('detail'), id, literal('context')),
    schema: z.array(taskMessageSchema),
  },
  {
    name: 'task-history',
    limit: large,
    match: under(literal('tasks'), literal('detail'), id, literal('history'), z.strictObject({ after: z.literal(-1) })),
    schema: taskHistory,
  },
  {
    name: 'task-proposals',
    limit: recent,
    match: under(
      literal('tasks'),
      literal('detail'),
      id,
      literal('proposals'),
      literal('list'),
      z.strictObject({ after: z.null() }),
    ),
    schema: z.object({ proposals: z.array(taskBatchStatusSchema), nextCursor: z.string().nullable() }),
  },
  {
    // The unfiltered newest runs only: filters and older pages are read on demand.
    name: 'workflow-runs',
    limit: recent,
    match: under(
      literal('workflows'),
      literal('detail'),
      id,
      literal('runs'),
      z.strictObject({ status: z.null(), triggerId: z.null(), pages: z.literal(1) }),
    ),
    schema: z.object({
      pages: z.tuple([runHistoryPageSchema]),
      runs: runHistoryPageSchema.shape.runs,
      nextCursor: z.string().nullable(),
    }),
  },
  {
    name: 'workflow-run',
    limit: recent,
    match: under(literal('workflows'), literal('detail'), id, literal('run'), id),
    schema: runDetailSchema,
  },
  {
    name: 'workflow-provider-status',
    limit: recent,
    match: under(literal('workflows'), literal('detail'), id, literal('provider-status')),
    schema: providerStatusSchema,
  },
  { name: 'workflows-archived', limit: 1, match: exactly('workflows', 'archived'), schema: workflowSchema.array() },
  {
    name: 'workflow-providers',
    limit: 1,
    match: exactly('workflows', 'providers'),
    schema: providerIntegrationSchema.array(),
  },
  {
    name: 'skill',
    limit: recent,
    match: under(literal('skills'), literal('detail'), z.uuid()),
    schema: skillDetailSchema,
  },
  {
    name: 'skill-history',
    limit: recent,
    match: under(literal('skills'), z.uuid(), literal('history'), z.string(), z.literal(0)),
    schema: skillHistoryPageSchema,
  },
  {
    name: 'skill-runtime',
    limit: recent,
    match: under(literal('skills'), z.uuid(), literal('runtime')),
    schema: z.strictObject({ available: z.boolean(), profile: z.literal('skill-runtime-v1') }),
  },
  {
    name: 'skill-provenance',
    limit: recent,
    match: under(literal('skills'), z.uuid(), literal('provenance'), z.string()),
    schema: skillProvenanceSchema.nullable(),
  },
  {
    name: 'skill-sharing',
    limit: recent,
    match: under(literal('skills'), literal('sharing'), z.uuid()),
    schema: skillSharingSchema,
  },
  {
    name: 'app-releases',
    limit: recent,
    match: under(literal('apps'), literal('releases'), id),
    schema: z.array(appReleaseSchema),
  },
  {
    name: 'app-grants',
    limit: recent,
    match: under(literal('apps'), literal('grants'), id),
    schema: z.array(appGrantSchema),
  },
  {
    name: 'github-integration',
    limit: recent,
    match: under(literal('integrations'), literal('github'), literal('detail'), id),
    schema: githubIntegrationSchema,
  },
  {
    name: 'mcp-integration',
    limit: recent,
    match: under(literal('workspace-mcp'), literal('integration'), id),
    schema: mcpIntegrationSchema,
  },
  {
    name: 'mcp-permissions',
    limit: recent,
    match: under(literal('workspace-mcp'), literal('permissions'), id),
    schema: agentPermissionsSchema,
  },
  {
    name: 'chat-plans',
    limit: recent,
    match: under(literal('conversations'), literal('detail'), id, literal('plans'), literal('list')),
    schema: z.array(planListItemSchema),
  },
  {
    name: 'chat-plan',
    limit: recent,
    match: under(
      literal('conversations'),
      literal('detail'),
      id,
      literal('plans'),
      id.refine(value => value !== 'list'),
    ),
    schema: planViewSchema,
  },
  {
    // A revision's document never changes, so a saved copy stays right until the plan moves on.
    name: 'chat-plan-document',
    limit: large,
    match: under(
      literal('conversations'),
      literal('detail'),
      id,
      literal('plans'),
      id,
      literal('document'),
      z.number(),
    ),
    schema: z.string(),
  },
  {
    name: 'file-details',
    limit: recent,
    match: under(literal('files'), literal('details'), id),
    schema: fileDetailsSchema,
  },
  {
    name: 'file-versions',
    limit: recent,
    match: under(literal('files'), literal('versions'), id),
    schema: fileVersionsSchema,
  },
  {
    name: 'file-sharing',
    limit: recent,
    match: under(literal('files'), literal('sharing'), id),
    schema: fileSharingSnapshotSchema,
  },
  {
    name: 'agent-linked-workflow',
    limit: recent,
    match: under(literal('agents'), literal('linked-workflow'), id),
    schema: agentLinkedWorkflowSchema,
  },
  {
    name: 'agent-sharing-candidates',
    limit: 1,
    match: exactly('agents', 'sharing-candidates'),
    schema: definitionSharingCandidatesSchema,
  },
];
