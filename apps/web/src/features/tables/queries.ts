import type { ProposalApi } from './proposal-api';
import type { ProposalView } from './review-contracts';
import {
  TableQueryRejected,
  type RecordMutation,
  type RowQuery,
  type TableDataRow,
  type TableDefinition,
  type TableApi,
  type TableListSort,
  type MemberStateQuery,
  type WorkspaceMembersApi,
} from './api';
import type { QueryIssue, TableQueryRequest, TableQueryResult } from '@tulipfarm/tables/query';
import { z } from 'zod';
import { grantTargetSchema } from '@tulipfarm/workspaces/governance-contracts';
import { governancePath, governanceRequest, GovernanceRequestError, governanceError } from '@/lib/governance';
import { TableRequestError } from './request-state';
import { rowLabel } from './definition-view';
import type { TableValues } from './review-contracts';

type Cursor = string | undefined;
const personGrantListSchema = z.object({
  grants: z.array(z.object({ membershipId: z.uuid(), target: grantTargetSchema })),
});
export type ProposalIdentity = { chatId: string; proposalId: string };

export const tableKeys = {
  all: ['tables'] as const,
  lists: ['tables', 'list'] as const,
  list: (after: Cursor, search?: string, sort?: TableListSort) =>
    [
      'tables',
      'list',
      { after: after ?? null, search: search ?? null, sort: sort ? `${sort.by}:${sort.direction}` : null },
    ] as const,
  detail: (id: string) => ['tables', 'detail', id] as const,
  definition: (id: string) => [...tableKeys.detail(id), 'definition'] as const,
  capabilities: (id: string, revision: string) => [...tableKeys.detail(id), 'capabilities', revision] as const,
  members: (id: string, query: MemberStateQuery) => [...tableKeys.detail(id), 'members', query] as const,
  schemaHistory: (id: string, after: Cursor) =>
    [...tableKeys.detail(id), 'schema-history', { after: after ?? null }] as const,
  records: (id: string) => [...tableKeys.detail(id), 'records'] as const,
  recordPage: (id: string, revision: string, query: RowQuery, after: Cursor) =>
    [...tableKeys.records(id), { revision, after: after ?? null, query }] as const,
  record: (id: string, revision: string, recordId: string) =>
    [...tableKeys.records(id), { revision, recordId }] as const,
  recordsById: (id: string, revision: string, recordIds: readonly string[]) =>
    [...tableKeys.records(id), 'ids', { revision, recordIds }] as const,
  query: (id: string, revision: string, request: TableQueryRequest) =>
    [...tableKeys.records(id), 'query', { revision, request }] as const,
  linked: ['tables', 'linked'] as const,
  history: (id: string, recordId: string, after: Cursor) =>
    [...tableKeys.detail(id), 'record-history', recordId, { after: after ?? null }] as const,
  reverseFields: (id: string, recordId: string, after: Cursor) =>
    [...tableKeys.detail(id), 'reverse-fields', recordId, { after: after ?? null }] as const,
  reverseRecords: (id: string, recordId: string, fieldId: string, after: Cursor) =>
    [...tableKeys.detail(id), 'reverse-records', recordId, fieldId, { after: after ?? null }] as const,
  deleted: (id: string, after: Cursor) => [...tableKeys.detail(id), 'deleted', { after: after ?? null }] as const,
  receipt: (id: string, requestId: string) => [...tableKeys.detail(id), 'requests', requestId] as const,
  picker: ['tables', 'picker'] as const,
  grants: ['tables', 'person-grants'] as const,
  proposals: ['tables', 'proposals'] as const,
  proposal: ({ chatId, proposalId }: ProposalIdentity) => ['tables', 'proposals', chatId, proposalId] as const,
  proposalView: (identity: ProposalIdentity) => [...tableKeys.proposal(identity), 'view'] as const,
  proposalOutcome: (identity: ProposalIdentity) => [...tableKeys.proposal(identity), 'outcome'] as const,
  proposalEffects: (identity: ProposalIdentity) => [...tableKeys.proposal(identity), 'effects'] as const,
  effects: (identity: ProposalIdentity, tableId: string, digest: string, total: number, after: number) =>
    [...tableKeys.proposal(identity), 'effects', tableId, { digest, total, after }] as const,
};

export type LinkedRef = { tableId: string; recordIds: string[] };
export function linkedRefs(values: readonly (TableValues | null)[]): LinkedRef[] {
  const tables = new Map<string, Set<string>>();
  for (const value of values.flatMap(record => Object.values(record ?? {}))) {
    if (value?.kind !== 'relationship') continue;
    const ids = tables.get(value.tableId) ?? new Set<string>();
    for (const id of value.recordIds) ids.add(id);
    tables.set(value.tableId, ids);
  }
  return [...tables]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tableId, ids]) => ({ tableId, recordIds: [...ids].sort() }));
}

export const proposalProgressing = (view: ProposalView) =>
  view.content === 'available' &&
  ['approved', 'running', 'partial'].includes(view.status) &&
  !view.cancelled &&
  !view.expired &&
  !view.plans.some(plan => plan.receipt?.status === 'failed');

// These inputs also work with featureReadOptions for scoped router prefetches.
export const tableQueries = {
  personGrants: (workspaceId: string) => ({
    key: tableKeys.grants,
    load: async (signal: AbortSignal) => {
      try {
        return personGrantListSchema.parse(
          await governanceRequest(`${governancePath(workspaceId)}/person-grants`, 'GET', undefined, signal),
        );
      } catch (error) {
        if (error instanceof GovernanceRequestError)
          throw new TableRequestError(error.status, error.code, governanceError(error));
        throw error;
      }
    },
  }),
  list: (api: TableApi, after?: string, search?: string, sort?: TableListSort) => ({
    key: tableKeys.list(after, search, sort),
    load: (signal: AbortSignal) => api.list(after, signal, search, false, sort),
  }),
  detail: (api: TableApi, id: string) => ({
    key: tableKeys.definition(id),
    load: (signal: AbortSignal) => api.detail(id, signal),
  }),
  capabilities: (api: TableApi, table: Pick<TableDefinition, 'id' | 'revision'>) => ({
    key: tableKeys.capabilities(table.id, table.revision),
    load: (signal: AbortSignal) => api.capabilities(table.id, signal),
  }),
  members: (api: WorkspaceMembersApi, id: string, query: MemberStateQuery) => ({
    key: tableKeys.members(id, query),
    load: (signal: AbortSignal) => api.state(query, signal),
  }),
  /** The server refuses a filter value it cannot parse or a cursor from another query with 400; that read resolves to `'invalid-query'` so the reader can offer to clear them instead of a retry that repeats it. */
  recordPage: (api: TableApi, table: Pick<TableDefinition, 'id' | 'revision'>, query: RowQuery, after?: string) => ({
    key: tableKeys.recordPage(table.id, table.revision, query, after),
    load: async (signal: AbortSignal) => {
      try {
        return await api.recordPage(table, query, after, signal);
      } catch (error) {
        if ((after || query.search || query.filter) && error instanceof TableRequestError && error.status === 400)
          return 'invalid-query' as const;
        throw error;
      }
    },
  }),
  /** A rejected query or page cursor resolves to its issues so the page can offer Clear filters or Back to first rows instead of a retry that repeats it. */
  query: (api: TableApi, table: Pick<TableDefinition, 'id' | 'revision'>, request: TableQueryRequest) => ({
    key: tableKeys.query(table.id, table.revision, request),
    load: async (signal: AbortSignal): Promise<TableQueryResult | { mode: 'invalid'; issues: QueryIssue[] }> => {
      try {
        return await api.query(table, request, signal);
      } catch (error) {
        if (error instanceof TableQueryRejected) return { mode: 'invalid', issues: error.issues };
        const after = 'rsql' in request ? request.options.after : request.query.after;
        if (after && error instanceof TableRequestError && error.status === 400) return { mode: 'invalid', issues: [] };
        throw error;
      }
    },
  }),
  record: (api: TableApi, table: Pick<TableDefinition, 'id' | 'revision'>, recordId: string) => ({
    key: tableKeys.record(table.id, table.revision, recordId),
    load: async (signal: AbortSignal) => (await api.rowsById(table, [recordId], signal))[0] ?? null,
  }),
  /** Rows that still exist and remain readable, in request order. */
  recordsById: (api: TableApi, table: Pick<TableDefinition, 'id' | 'revision'>, recordIds: readonly string[]) => ({
    key: tableKeys.recordsById(table.id, table.revision, recordIds),
    load: async (signal: AbortSignal) => {
      const found = new Map<string, TableDataRow>();
      for (let start = 0; start < recordIds.length; start += 100) {
        for (const record of await api.rowsById(table, recordIds.slice(start, start + 100), signal))
          found.set(record.id, record);
      }
      return recordIds.flatMap(id => found.get(id) ?? []);
    },
  }),
  schemaHistory: (api: TableApi, id: string, after?: string) => ({
    key: tableKeys.schemaHistory(id, after),
    load: (signal: AbortSignal) => api.schemaHistory(id, after, signal),
  }),
  history: (api: TableApi, id: string, recordId: string, after?: string) => ({
    key: tableKeys.history(id, recordId, after),
    load: (signal: AbortSignal) => api.history(id, recordId, after, signal),
  }),
  reverseFields: (api: TableApi, id: string, recordId: string, after?: string) => ({
    key: tableKeys.reverseFields(id, recordId, after),
    load: (signal: AbortSignal) => api.reverseFields(id, recordId, after, signal),
  }),
  reverseRecords: (api: TableApi, id: string, recordId: string, fieldId: string, after?: string) => ({
    key: tableKeys.reverseRecords(id, recordId, fieldId, after),
    load: (signal: AbortSignal) => api.reverseRecords(id, recordId, fieldId, after, signal),
  }),
  deleted: (api: TableApi, id: string, after?: string) => ({
    key: tableKeys.deleted(id, after),
    load: (signal: AbortSignal) => api.deletedRecords(id, after, signal),
  }),
  receipt: (api: TableApi, input: Pick<RecordMutation, 'tableId' | 'requestId'>) => ({
    key: tableKeys.receipt(input.tableId, input.requestId),
    load: (signal: AbortSignal) => api.receipt(input, signal),
    staleTime: 0,
  }),
  /** Labels of the linked rows the reader can see, by row id. A missing row, table, or permission leaves its id out. */
  linked: (api: TableApi, refs: LinkedRef[]) => ({
    key: [...tableKeys.linked, refs],
    load: async (signal: AbortSignal) => {
      const labels: Record<string, string> = {};
      for (const { tableId, recordIds } of refs) {
        try {
          const { applied, systemKind } = await api.detail(tableId, signal);
          if (!applied) continue;
          for (let start = 0; start < recordIds.length; start += 100) {
            for (const record of await api.rowsById(
              { id: tableId, revision: applied.revision },
              recordIds.slice(start, start + 100),
              signal,
            ))
              labels[record.id] = rowLabel(applied.definition, record.values, systemKind);
          }
        } catch (error) {
          if (!(error instanceof TableRequestError && [403, 404].includes(error.status))) throw error;
        }
      }
      return labels;
    },
  }),
  picker: (api: TableApi) => ({
    key: tableKeys.picker,
    load: async (signal: AbortSignal) => {
      const tables = [];
      let after: string | undefined;
      do {
        const page = await api.list(after, signal);
        tables.push(...page.tables);
        after = page.nextCursor ?? undefined;
      } while (after && !signal.aborted);
      return tables;
    },
  }),
  proposal: (api: ProposalApi, identity: ProposalIdentity) => ({
    key: tableKeys.proposalView(identity),
    load: api.read,
    pollWhile: proposalProgressing,
  }),
  outcome: (api: ProposalApi, identity: ProposalIdentity) => ({
    key: tableKeys.proposalOutcome(identity),
    load: api.outcome,
  }),
  effects: (
    api: ProposalApi,
    identity: ProposalIdentity,
    tableId: string,
    digest: string,
    total: number,
    after: number,
  ) => ({
    key: tableKeys.effects(identity, tableId, digest, total, after),
    enabled: total > 0,
    load: async (signal: AbortSignal) => {
      const page = await api.effects(tableId, after, signal);
      if (page.digest !== digest || page.total !== total) throw new Error('Effects do not match the reviewed proposal');
      return page;
    },
  }),
};
