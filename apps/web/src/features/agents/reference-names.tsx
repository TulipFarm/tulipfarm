import { Fragment, useMemo } from 'react';
import { ReferenceName } from '@/components/reference-name';
import { tableApi } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';
import { agentApi, type AgentDetail } from './api';
import { permissionText } from './labels';
import { agentKeys, useAgentDetail } from './queries';
import { useFeatureRead } from '@/lib/query';
import { useAgentSlackApi } from './slack-queries';

type Scope = AgentDetail['activations'][number]['scope'];
const slackEntry = (entry: Scope[number]) => entry.permissions.some(permission => permission.startsWith('slack.'));
const channelName = (name: string) => (name.startsWith('#') ? name : `#${name}`);

/** Slack destination names by ID, read only when the scope has a Slack destination. */
export function useSlackDestinationNames(workspaceId: string, scope: Scope) {
  const api = useAgentSlackApi(workspaceId);
  const ids = scope.filter(slackEntry).map(entry => entry.assetId);
  const read = useFeatureRead({
    key: agentKeys.slackDestinations,
    enabled: ids.length > 0,
    load: signal => api.destinations(signal),
  });
  const known = read.state.kind === 'ready' ? read.state.data.destinations : [];
  const list = ids
    .map(id => known.find(item => item.id === id))
    .flatMap(item => (item ? [channelName(item.name)] : []));
  return {
    read,
    names: Object.fromEntries(known.map(item => [item.id, channelName(item.name)])) as Record<string, string>,
    /** Names for a summary; a count when some names are unknown. */
    postsTo: list.length === ids.length ? list : [`${ids.length} Slack channel${ids.length === 1 ? '' : 's'}`],
  };
}

export function AgentName({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const api = useMemo(() => agentApi(workspaceId), [workspaceId]);
  const read = useAgentDetail(api, agentId);
  return (
    <ReferenceName
      noun="Agent"
      name={read.state.kind === 'ready' ? read.state.data.name : null}
      state={read.state}
      refresh={read.refresh}
    />
  );
}

export function TableName({ workspaceId, tableId }: { workspaceId: string; tableId: string }) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const name =
    read.state.kind === 'ready'
      ? (read.state.data.find(table => table.id === tableId)?.definition.label ?? null)
      : null;
  return <ReferenceName noun="Table" name={name} state={read.state} refresh={read.refresh} />;
}

export function ScopeSummary({ workspaceId, scope }: { workspaceId: string; scope: Scope }) {
  const slack = useSlackDestinationNames(workspaceId, scope);
  if (!scope.length) return <>No table access</>;
  return (
    <>
      {scope.map((entry, index) => (
        <Fragment key={entry.assetId}>
          {index > 0 && '; '}
          {entry.permissions.some(permission => permission.startsWith('table.')) ? (
            <>
              <TableName workspaceId={workspaceId} tableId={entry.assetId} />: {permissionText(entry.permissions)}
            </>
          ) : slackEntry(entry) ? (
            <>
              Slack{' '}
              <ReferenceName
                noun="Slack channel"
                name={slack.names[entry.assetId] ?? null}
                state={slack.read.state}
                refresh={slack.read.refresh}
              />
              : {entry.permissions.join(', ')}
            </>
          ) : (
            <>
              Configured asset {entry.assetId}: {entry.permissions.join(', ')}
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}
