import { createWorkspaceTableAuthoring } from '@tulipfarm/workspaces/table-authoring';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createTablePublication } from '@tulipfarm/tables/execution';
import { requireTableSources, requireTableFiles, requireTableImportReference } from '@tulipfarm/agents/table-sources';
import { retryError } from '@tulipfarm/observability';

export function createTableAuthoringComposition() {
  const tables = createWorkspaceTableAuthoring();
  const runtime = withGitHubSourceAuthorization(tables.runtime);
  const agents = createAgentAuthoring(runtime).withWriter(tables.prepareAgentRevision);
  const access = {
    requireSources: requireTableSources,
    requireFiles: requireTableFiles,
    requireImportReference: requireTableImportReference,
  };
  const publishTableProposal = createTablePublication({
    ...access,
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
