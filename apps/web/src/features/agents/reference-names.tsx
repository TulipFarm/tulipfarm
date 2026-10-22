import { Fragment, useMemo } from 'react';
import { ReferenceName } from '@/components/reference-name';
import { tableApi } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';
import { agentApi, type AgentDetail } from './api';
import { permissionText } from './labels';
import { useAgentDetail } from './queries';

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

export function ScopeSummary({
  workspaceId,
  scope,
}: {
  workspaceId: string;
  scope: AgentDetail['activations'][number]['scope'];
}) {
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
          ) : (
            <>
              {entry.permissions.some(permission => permission.startsWith('slack.'))
                ? 'Slack destination'
                : 'Configured asset'}{' '}
              {entry.assetId}: {entry.permissions.join(', ')}
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}
