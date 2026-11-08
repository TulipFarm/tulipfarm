import { createWorkspaceTableAuthoring } from '@tulipfarm/workspaces/table-authoring';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createTablePublication } from '@tulipfarm/tables/execution';
import { retryError } from '@tulipfarm/observability';
import { tableExecutionAccess } from './table-access.ts';

export function createTableAuthoringComposition() {
  const tables = createWorkspaceTableAuthoring();
  const runtime = withGitHubSourceAuthorization(tables.runtime);
  const agents = createAgentAuthoring(runtime).withWriter(tables.prepareAgentRevision);
  const publishTableProposal = createTablePublication({
    ...tableExecutionAccess,
    runtime,
    prepareRevision: tables.prepareTableDefinition,
  });
  return {
    runtime,
    readyTaskWorkspaces: tables.readyTaskWorkspaces,
    convertTableName: tables.convertTableName,
    memberProfiles: tables.memberProfiles,
    flagContext: tables.flagContext,
    activities: {
      async publishTableProposal(workspaceId: string, proposalId: string) {
        try {
          return await publishTableProposal(workspaceId, proposalId);
        } catch (error) {
          throw retryError('table-publication-retry', error);
        }
      },
      async prepareAgentDefinition(workspaceId: string, commandId: string) {
        return (await agents.prepare(workspaceId, commandId)).status;
      },
    },
    close: tables.close,
  };
}
