import { useEffect, useMemo } from 'react';
import { featureKey, featureReadOptions, useFeatureRead, type FeatureReadOptions } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { linkedRefs, tableKeys, tableQueries, type ProposalIdentity } from './queries';
import { useTableChanges, useTableTransition } from './changes';
import type { ProposalApi } from './proposal-api';
import type { RowPage, RowQuery, TableDataRow, TableDefinition, TableApi, TableListSort } from './api';
import { workspaceMembersApi, type MemberStateQuery } from './api';
import type { TableQueryRequest } from '@tulipfarm/tables/query';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import type { ReadState } from './request-state';
import { TableRequestError } from './request-state';
import { concealTableQueries, useTableAuthority } from './authority';
import { useTableWrite } from './use-table-write';
import type { ProposalCommand, TableValues } from './review-contracts';

function useTableQuery<T>(options: FeatureReadOptions<T>) {
  useTableAuthority();
  return useFeatureRead(options);
}

export function useTableList(api: TableApi, after?: string, search?: string, sort?: TableListSort) {
  return useTableQuery(tableQueries.list(api, after, search, sort));
}
export function useTableNames(api: TableApi, enabled = true) {
  const read = useTableQuery({ ...tableQueries.picker(api), enabled });
  return useMemo(
    () => new Map(read.state.kind === 'ready' ? read.state.data.map(table => [table.id, table.definition.label]) : []),
    [read.state],
  );
}
export function useTableDetail(api: TableApi, id: string) {
  const read = useTableQuery(tableQueries.detail(api, id));
  const data = read.state.kind === 'ready' ? read.state.data : null;
  useTableTransition(
    tableKeys.definition(id),
    data ? JSON.stringify([data.saved?.id, data.saved?.phase, data.saved?.revision, data.applied?.revision]) : null,
    [id],
  );
  return read;
}
export function useTableRows(api: TableApi, table: TableDefinition, query: RowQuery, after?: string) {
  return useTableQuery(tableQueries.recordPage(api, table, query, after));
}
export function useTableCapabilities(api: TableApi, table: Pick<TableDefinition, 'id' | 'revision'>) {
  return useTableQuery(tableQueries.capabilities(api, table));
}
export function useWorkspaceMembers(workspaceId: string, tableId: string, query: MemberStateQuery, enabled = true) {
  const api = useMemo(() => workspaceMembersApi(workspaceId), [workspaceId]);
  return useTableQuery({ ...tableQueries.members(api, tableId, query), enabled });
}
export function useTableQueryResult(
  api: TableApi,
  table: Pick<TableDefinition, 'id' | 'revision'>,
  request: TableQueryRequest,
  enabled = true,
) {
  return useTableQuery({ ...tableQueries.query(api, table, request), enabled });
}
export function useMemberDirectory(workspaceId: string) {
  const api = useMemo(() => workspaceMembersApi(workspaceId), [workspaceId]);
  return useTableQuery({
    key: [...tableKeys.picker, 'workspace-members'],
    load: (signal: AbortSignal) => api.state({}, signal),
  });
}
export function useTableRowsById(
  api: TableApi,
  table: Pick<TableDefinition, 'id' | 'revision'>,
  recordIds: readonly string[],
) {
  return useTableQuery(tableQueries.recordsById(api, table, recordIds));
}
export function useTableRow(api: TableApi, table: TableDefinition, recordId: string) {
  return useTableQuery<TableDataRow | null>(tableQueries.record(api, table, recordId));
}
export function useTableRelationship(api: TableApi, id: string, after?: string, search?: string) {
  const detail = useTableDetail(api, id);
  const applied = detail.state.kind === 'ready' ? detail.state.data.applied : null;
  const systemKind = detail.state.kind === 'ready' ? detail.state.data.systemKind : undefined;
  const query: RowQuery = {
    ...(search ? { search } : {}),
    ...(systemKind === 'workspace-members'
      ? { filter: { fieldId: workspaceMemberFields.active, op: 'eq' as const, value: true } }
      : {}),
  };
  const records = useTableQuery({
    key: tableKeys.recordPage(id, applied?.revision ?? '', query, after),
    enabled: !!applied && detail.state.kind === 'ready' && !detail.state.error,
    load: (signal: AbortSignal) => {
      if (!applied)
        throw new TableRequestError(
          409,
          'not-active',
          'This table has no active fields yet. Check again after its schema change completes.',
        );
      return tableQueries.recordPage(api, { id, revision: applied.revision }, query, after).load(signal);
    },
  });
  type Result = RowPage & { target: TableDefinition };
  let state: ReadState<Result>;
  if (detail.state.kind !== 'ready') state = detail.state;
  else if (!applied)
    state = {
      kind: 'error',
      message: 'This table has no active fields yet. Check again after its schema change completes.',
    };
  else if (records.state.kind !== 'ready') state = records.state;
  else if (records.state.data === 'invalid-query')
    state = { kind: 'error', message: 'These rows changed since this page loaded. Go back to the first rows.' };
  else
    state = {
      ...records.state,
      data: { ...records.state.data, target: { id, ...applied, systemKind } },
      refreshing: detail.state.refreshing || records.state.refreshing,
      error: detail.state.error ?? records.state.error,
    };
  return {
    state,
    refresh: async () => {
      await detail.refresh();
      await records.refresh();
    },
  };
}
const noLinks: ReadState<Record<string, string>> = { kind: 'ready', data: {}, refreshing: false, error: null };
export function useLinkedRows(api: TableApi, values: readonly (TableValues | null)[]) {
  const refs = linkedRefs(values);
  const read = useTableQuery({ ...tableQueries.linked(api, refs), enabled: refs.length > 0 });
  return refs.length ? read : { ...read, state: noLinks };
}
export function useTableSchemaHistory(api: TableApi, id: string, after?: string) {
  const read = useTableQuery(tableQueries.schemaHistory(api, id, after));
  const data = read.state.kind === 'ready' ? read.state.data : null;
  useTableTransition(
    tableKeys.schemaHistory(id, after),
    data ? JSON.stringify(data.entries.map(entry => [entry.id, entry.phase, entry.revision, entry.appliedAt])) : null,
    [id],
  );
  return read;
}
export function useTableRowHistory(api: TableApi, id: string, recordId: string, after?: string) {
  return useTableQuery(tableQueries.history(api, id, recordId, after));
}
export function useTableReverseFields(api: TableApi, id: string, recordId: string, after?: string) {
  return useTableQuery(tableQueries.reverseFields(api, id, recordId, after));
}
export function useTableReverseRecords(api: TableApi, id: string, recordId: string, fieldId: string, after?: string) {
  return useTableQuery(tableQueries.reverseRecords(api, id, recordId, fieldId, after));
}
export function useTableDeletedRows(api: TableApi, id: string, after?: string) {
  return useTableQuery(tableQueries.deleted(api, id, after));
}
export function useTableReceipt(api: TableApi) {
  useTableAuthority();
  const { runtime, scope, current } = useFeatureContext();
  return (input: Parameters<typeof tableQueries.receipt>[1]) =>
    runtime.client.fetchQuery(featureReadOptions(runtime, scope, tableQueries.receipt(api, input), current));
}
export function useTablePicker(...args: Parameters<typeof tableQueries.picker>) {
  return useTableQuery(tableQueries.picker(...args));
}
export function useTableProposal(api: ProposalApi, identity: ProposalIdentity) {
  const read = useTableQuery(tableQueries.proposal(api, identity));
  const { runtime, scope } = useFeatureContext();
  const view = read.state.kind === 'ready' ? read.state.data : null;
  useEffect(() => {
    if (view?.content === 'redacted')
      concealTableQueries(
        runtime.client,
        [featureKey(scope, tableKeys.proposalEffects(identity))],
        new TableRequestError(403, 'proposal-redacted', 'Proposal effects are no longer available.'),
      );
  }, [runtime, scope, identity.chatId, identity.proposalId, view?.content]);
  useTableTransition(
    tableKeys.proposalView(identity),
    view ? JSON.stringify([view.status, view.plans]) : null,
    view?.plans.filter(plan => plan.receipt !== null).map(plan => plan.tableId) ?? [],
    !!view?.plans.some(plan => plan.receipt !== null),
  );
  return read;
}
export function useTableProposalOutcome(...args: Parameters<typeof tableQueries.outcome>) {
  return useTableQuery(tableQueries.outcome(...args));
}
export function useTableProposalEffects(...args: Parameters<typeof tableQueries.effects>) {
  return useTableQuery(tableQueries.effects(...args));
}
export function useTablePersonGrants(workspaceId: string) {
  return useTableQuery(tableQueries.personGrants(workspaceId));
}

export function useTableProposalCommand(api: ProposalApi, identity: ProposalIdentity) {
  const changes = useTableChanges();
  return useTableWrite(
    async (input: ProposalCommand) => {
      try {
        const result = await api.command(input);
        await changes.proposalResult(identity, result);
        return result;
      } catch (error) {
        changes.denied(error, [tableKeys.proposal(identity)]);
        throw error;
      }
    },
    () => {},
  );
}
