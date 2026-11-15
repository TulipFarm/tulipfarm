import { z } from 'zod';
import { hashKey, type QueryKey } from '@tanstack/react-query';
import { googleAvailabilitySchema, googleStatusSchema } from '@tulipfarm/google-workspace/public-contracts';
import { integrationListSchema } from '@tulipfarm/integrations/contracts';
import { accountListSchema as githubAccountsSchema } from '@tulipfarm/github/contracts';
import { accountListSchema as atlassianAccountsSchema } from '@tulipfarm/atlassian/account-contracts';
import type { EarlyRead } from '@/lib/query/early-reads';
import type { PersistedRead } from '@/lib/query/persisted-reads';
import { loadGoogleIntegration } from '@/lib/google-workspace';
import { integrationsApi } from '@/lib/integrations';
import { githubApi } from '@/lib/github';
import { atlassianApi } from '@/lib/atlassian';
import { mcpApi } from '@/features/workspace-mcp/api';
import { capabilitiesSchema, integrationSchema } from '@/features/workspace-mcp/contracts';
import { mcpKeys } from '@/features/workspace-mcp/queries';
import { integrationKeys } from './queries';
import { loadSlackStatus, slackStatusSchema } from './slack-status';

/**
 * Every status the Integrations directory shows, keyed and loaded exactly as its queries do. Starting
 * them together during admission, and keeping the last answers on disk, lets the whole directory
 * appear at once instead of filling in as each provider answers.
 */
export function integrationDirectoryReads(workspaceId: string): EarlyRead[] {
  const mcp = mcpApi(workspaceId, () => {});
  return [
    { key: integrationKeys.accounts('google'), load: signal => loadGoogleIntegration(workspaceId, signal) },
    { key: integrationKeys.accounts('slack'), load: signal => loadSlackStatus(workspaceId, signal) },
    { key: integrationKeys.accounts('github'), load: signal => integrationsApi.list(workspaceId, signal) },
    { key: integrationKeys.accounts('github-personal'), load: signal => githubApi.list(workspaceId, signal) },
    { key: integrationKeys.accounts('atlassian'), load: signal => atlassianApi.accounts(workspaceId, signal) },
    { key: mcpKeys.capabilities, load: mcp.capabilities },
    { key: mcpKeys.integrations, load: mcp.integrations },
  ];
}

const exactly = (key: QueryKey) => {
  const hash = hashKey(key);
  return (candidate: QueryKey) => hashKey(candidate) === hash;
};
const read = (name: string, key: QueryKey, schema: z.ZodType): PersistedRead => ({
  name,
  limit: 1,
  match: exactly(key),
  schema,
});

export const integrationDirectoryPersistedReads: PersistedRead[] = [
  read(
    'integrations-google',
    integrationKeys.accounts('google'),
    googleAvailabilitySchema.extend({ status: googleStatusSchema }),
  ),
  read('integrations-slack', integrationKeys.accounts('slack'), z.union([z.literal('unavailable'), slackStatusSchema])),
  read('integrations-github', integrationKeys.accounts('github'), integrationListSchema),
  read('integrations-github-personal', integrationKeys.accounts('github-personal'), githubAccountsSchema),
  read('integrations-atlassian', integrationKeys.accounts('atlassian'), atlassianAccountsSchema),
  read('mcp-capabilities', mcpKeys.capabilities, capabilitiesSchema),
  read('mcp-integrations', mcpKeys.integrations, z.object({ integrations: z.array(integrationSchema) })),
];
