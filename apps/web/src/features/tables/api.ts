import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from './request-state';
import type { rowFilterOps } from './row-query';
import {
  queryCapabilitiesSchema,
  queryErrorSchema,
  queryResultSchema,
  queryValidationSchema,
  referenceChoicesSchema,
  type QueryIssue,
  type TableQueryRequest,
} from '@tulipfarm/tables/query';
import { workspaceMembersStateSchema, workspaceMemberStateSchema } from '@tulipfarm/tables/workspace-members';
import { executionReceiptSchema, tableDefinitionSchema, tableValuesSchema, type TableValues } from './review-contracts';

const tableSchema = z.object({
  id: z.uuid(),
  revision: z.string(),
  definition: tableDefinitionSchema,
  systemKind: z.literal('workspace-members').optional(),
});
const listSchema = z.object({
  tables: z.array(tableSchema.extend({ appliedAt: z.iso.datetime().nullable(), recordCount: z.string() })),
  nextCursor: z.string().nullable(),
});
export type TableListSort = { by: 'name' | 'records' | 'changed'; direction: 'asc' | 'desc' };
const schemaHistoryEntrySchema = z.object({
  id: z.uuid(),
  revision: z.string().nullable(),
  phase: z.enum(['publishing', 'copying', 'reconciling', 'completed', 'blocked']),
  createdAt: z.iso.datetime(),
  savedAt: z.iso.datetime().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  definition: tableDefinitionSchema.nullable(),
  receipt: executionReceiptSchema.nullable(),
});
const schemaHistorySchema = z.object({ entries: z.array(schemaHistoryEntrySchema), nextCursor: z.uuid().nullable() });
const definitionStateSchema = z.object({
  id: z.uuid(),
  systemKind: z.literal('workspace-members').optional(),
  saved: schemaHistoryEntrySchema.nullable(),
  applied: z
    .object({ revision: z.string(), definition: tableDefinitionSchema, appliedAt: z.iso.datetime().nullable() })
    .nullable(),
  rowPermissions: z
    .object({ create: z.boolean(), update: z.boolean(), delete: z.boolean() })
    .default({ create: false, update: false, delete: false }),
});
const deletedRecordSchema = z.object({
  id: z.uuid(),
  token: z.uuid(),
  deletedAt: z.iso.datetime(),
  recoverableUntil: z.iso.datetime().nullable(),
});
const deletedRecordsSchema = z.object({ records: z.array(deletedRecordSchema), nextCursor: z.uuid().nullable() });
const reverseFieldsSchema = z.object({
  fields: z.array(
    z.object({ fieldId: z.uuid(), tableId: z.uuid(), label: z.string(), cardinality: z.enum(['one', 'many']) }),
  ),
  nextCursor: z.uuid().nullable(),
});
const reverseRecordsSchema = z.object({
  kind: z.literal('relationship'),
  tableId: z.uuid(),
  cardinality: z.enum(['one', 'many']),
  recordIds: z.array(z.uuid()),
  nextCursor: z.uuid().nullable(),
});
export type SchemaHistoryEntry = z.infer<typeof schemaHistoryEntrySchema>;
export type DefinitionState = z.infer<typeof definitionStateSchema>;
export type DeletedRecord = z.infer<typeof deletedRecordSchema>;
export const recordSchema = z.object({
  id: z.uuid(),
  token: z.uuid(),
  values: tableValuesSchema,
  unavailableFileIds: z.array(z.uuid()).default([]),
});
const mutationResultSchema = z.discriminatedUnion('kind', [
  recordSchema
    .omit({ unavailableFileIds: true })
    .extend({ kind: z.literal('available'), values: tableValuesSchema.nullable() }),
  z.object({ kind: z.literal('expired'), id: z.uuid(), token: z.uuid() }),
]);
const requestStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }),
  z.object({ status: z.literal('applied'), result: mutationResultSchema }),
]);
const historyEntrySchema = z.object({
  id: z.uuid(),
  token: z.uuid(),
  actor: z.unknown(),
  operation: z.enum(['create', 'update', 'delete', 'restore', 'transform']),
  field_ids: z.array(z.uuid()),
  outcome: z.literal('applied'),
  created_at: z.iso.datetime(),
  recoverable_until: z.iso.datetime(),
  values: tableValuesSchema.nullable(),
  before_values: tableValuesSchema.nullable(),
  unavailable_file_ids: z.array(z.uuid()).default([]),
});
export type RecordHistoryEntry = z.infer<typeof historyEntrySchema>;
export type TableDefinition = z.infer<typeof tableSchema>;
export type TableDataRow = z.infer<typeof recordSchema>;
export type RowPermissions = DefinitionState['rowPermissions'];
const rowPageSchema = z.object({
  records: z.array(recordSchema),
  total: z.string().nullable(),
  nextCursor: z.string().nullable(),
});
export type RowPage = z.infer<typeof rowPageSchema>;
export type RowFilterOp = (typeof rowFilterOps)[number];
export type ValuelessOp = Extract<RowFilterOp, 'is-null' | 'not-null'>;
export type RowFilter =
  | { fieldId: string; op: Exclude<RowFilterOp, ValuelessOp>; value: string | boolean }
  | { fieldId: string; op: ValuelessOp };
export type RowQuery = { search?: string; sort?: { fieldId: string; direction: 'asc' | 'desc' }; filter?: RowFilter };
type MutationBase = { requestId: string; tableId: string; revision: string; recordId: string };
export type RecordMutation = MutationBase &
  (
    | { kind: 'create'; values: TableValues }
    | { kind: 'update'; expectedToken: string; values: TableValues }
    | { kind: 'delete'; expectedToken: string }
    | { kind: 'restore'; expectedToken: string; historyId: string; version: 'before' | 'after' }
    | { kind: 'member-photo'; expectedToken: string; image: string | null }
    | { kind: 'member-repair'; expectedToken: string; values: TableValues }
  );

export type WorkspaceMemberState = z.infer<typeof workspaceMemberStateSchema>;
export type MemberStateQuery = { ids?: readonly string[]; after?: string; attention?: boolean };
export const memberMessages: Readonly<Record<string, string>> = {
  'member-table-protected':
    'Workspace members is a built-in table. Its name, owner, and core fields stay fixed. Add your own business fields in chat.',
  'member-field-protected':
    'This member field is protected. Account name and photo come from the linked personal profile. Use member photo controls for a person without access.',
  'member-inactive':
    'An inactive member cannot receive a new link. Choose an active member, or keep the existing links unchanged.',
  'member-selection-required':
    'Select an existing workspace member before inviting them. Create a member first if they are not listed.',
  'member-link-conflict':
    'This member is already linked to an account or another invitation. Review workspace access before trying again.',
  'member-unavailable': 'Member details are not available right now. Open Workspace members and check profile status.',
  'member-profile-pending': 'Your member profile is still being prepared. Open Workspace members to check its status.',
  'member-profile-failed':
    'Your member profile needs another sync attempt. Open Workspace members to retry or ask an admin.',
  'member-not-found':
    'This workspace member is unavailable or your access changed. Ask a workspace admin to review it.',
};

export function workspaceMembersApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/workspace-members`;
  async function request(path: string, signal: AbortSignal, method: 'GET' | 'POST' = 'GET') {
    const response = await jsonResponse(`${base}${path}`, { method, signal, cache: 'no-store' });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'member-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        memberMessages[code] ?? 'Member details could not be checked. Try again.',
      );
    }
    return value;
  }
  return {
    async state(query: MemberStateQuery, signal: AbortSignal) {
      const params = new URLSearchParams({ limit: '100' });
      if (query.ids?.length) params.set('ids', query.ids.join(','));
      if (query.after) params.set('after', query.after);
      if (query.attention) params.set('attention', 'true');
      return workspaceMembersStateSchema.parse(await request(`?${params}`, signal));
    },
    async retry(memberId: string) {
      return z
        .object({ status: z.literal('pending') })
        .parse(
          await request(`/${encodeURIComponent(memberId)}/profile-sync/retry`, AbortSignal.timeout(15_000), 'POST'),
        );
    },
  };
}
export type WorkspaceMembersApi = ReturnType<typeof workspaceMembersApi>;

/** The server rejected a query with precise issues. The query text stays in the editor. */
export class TableQueryRejected extends TableRequestError {
  readonly issues: QueryIssue[];
  constructor(issues: QueryIssue[]) {
    super(400, 'invalid-query', issues.map(issue => issue.message).join(' ') || 'This search is not valid.');
    this.issues = issues;
  }
}
const translationChoiceSchema = z.object({ label: z.string(), prompt: z.string() });
export const translationSchema = z.discriminatedUnion('status', [
  queryValidationSchema.extend({ requestId: z.uuid(), status: z.literal('query'), interpretation: z.string() }),
  z.object({
    requestId: z.uuid(),
    status: z.literal('clarification'),
    message: z.string(),
    choices: z.array(translationChoiceSchema).default([]),
  }),
  z.object({ requestId: z.uuid(), status: z.literal('unsupported'), message: z.string() }),
  z.object({ requestId: z.uuid(), status: z.enum(['pending', 'failed', 'uncertain']), message: z.string().optional() }),
]);
export type Translation = z.infer<typeof translationSchema>;
export type TranslationInput = {
  requestId: string;
  revision: string;
  prompt: string;
  timezone: string;
  current?: TableQueryRequest;
};

export function tableApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/tables`;
  async function request(path: string, signal: AbortSignal, body?: RecordMutation, root = base) {
    const response = await jsonResponse(`${root}${path}`, {
      method: body ? 'POST' : 'GET',
      body,
      signal,
      cache: 'no-store',
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'table-operation-failed');
      const message =
        body?.kind === 'delete' && code === 'linked-record'
          ? 'Linked deletion is blocked. Another row still links to this row. Remove those links, then delete it again.'
          : body?.kind === 'delete' && code === 'stale-record'
            ? 'This row changed since you opened it. Close this dialog and review the current row before deleting it.'
            : code === 'stale-record'
              ? 'This row changed since you opened it. Your edits are retained. Close the editor or history and reload the current row before trying again.'
              : code === 'stale-generation'
                ? 'Table fields changed. Reload the table before editing again.'
                : code === 'recovery-expired'
                  ? 'These historical values are no longer recoverable. Close history and load it again to review any remaining retained values.'
                  : code === 'duplicate-key'
                    ? 'These values conflict with an existing unique row. Review the current rows before trying again.'
                    : code === 'linked-record'
                      ? 'A linked row is unavailable or still referenced. Review the relationship and your access.'
                      : response.status === 400
                        ? 'The server rejected these values. Check required fields, limits, and references.'
                        : [403, 404].includes(response.status)
                          ? 'This table or a referenced file is missing, or your permission changed. A workspace admin can review your access.'
                          : 'The table request could not be confirmed. Check the current rows before trying again.';
      throw new TableRequestError(response.status, code, memberMessages[code] ?? message);
    }
    return value;
  }
  async function queryRequest(path: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      body,
      signal,
      cache: 'no-store',
    });
    const value = await readJson(response, true);
    if (response.ok) return value;
    const rejected = queryErrorSchema.safeParse(value);
    if (response.status === 400 && rejected.success) throw new TableQueryRejected(rejected.data.issues as QueryIssue[]);
    const code = responseError(value, 'table-operation-failed');
    const message =
      code === 'stale-generation' || code === 'stale-revision'
        ? 'Table fields changed. Reload the table to search again.'
        : code === 'insufficient-credits'
          ? 'Your workspace is out of AI credits. Filters and RSQL still work.'
          : code === 'rate-limited'
            ? 'Too many AI searches just now. Wait a minute, or use Filters or RSQL.'
            : code === 'translation-unavailable'
              ? 'AI search is unavailable right now. Filters and RSQL still work.'
              : code === 'request-mismatch'
                ? 'This AI search request was reused with different text. Submit it again.'
                : [403, 404].includes(response.status)
                  ? 'This table is missing or your permission changed. A workspace admin can review your access.'
                  : response.status === 400
                    ? 'This search is not valid. Check its fields and values.'
                    : 'The search could not be completed. Check your connection and try again.';
    throw new TableRequestError(response.status, code, memberMessages[code] ?? message);
  }
  async function list(
    after: string | undefined,
    signal: AbortSignal,
    search?: string,
    archived = false,
    sort?: TableListSort,
  ) {
    return listSchema.parse(
      await request(
        `?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}${archived ? '&archived=true' : ''}${sort ? `&sort=${sort.by}&direction=${sort.direction}` : ''}`,
        signal,
      ),
    );
  }
  async function detail(id: string, signal: AbortSignal) {
    return definitionStateSchema.parse(await request(`/${encodeURIComponent(id)}`, signal));
  }
  return {
    list,
    detail,
    async active(id: string, signal: AbortSignal): Promise<TableDefinition> {
      const state = await detail(id, signal);
      if (!state.applied)
        throw new TableRequestError(
          409,
          'not-active',
          'This table has no active fields yet. Check again after its schema change completes.',
        );
      return {
        id: state.id,
        revision: state.applied.revision,
        definition: state.applied.definition,
        systemKind: state.systemKind,
      };
    },
    async schemaHistory(id: string, after: string | undefined, signal: AbortSignal) {
      return schemaHistorySchema.parse(
        await request(
          `/${encodeURIComponent(id)}/schema-history?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
          signal,
        ),
      );
    },
    async deletedRecords(id: string, after: string | undefined, signal: AbortSignal) {
      return deletedRecordsSchema.parse(
        await request(
          `/${encodeURIComponent(id)}/deleted-rows?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
          signal,
        ),
      );
    },
    /** Pass `after` back exactly as the previous page's `nextCursor`; a cursor belongs to one query. */
    async recordPage(
      table: Pick<TableDefinition, 'id' | 'revision'>,
      query: RowQuery,
      after: string | undefined,
      signal: AbortSignal,
    ) {
      const params = new URLSearchParams({ revision: table.revision, limit: '50' });
      if (after) params.set('after', after);
      if (query.search) params.set('search', query.search);
      if (query.sort) {
        params.set('sort', query.sort.fieldId);
        params.set('direction', query.sort.direction);
      }
      if (query.filter) params.set('filters', JSON.stringify([query.filter]));
      return rowPageSchema.parse(await request(`/${encodeURIComponent(table.id)}/rows/page?${params}`, signal));
    },
    /** Returns only the requested rows that still exist, at most 100. */
    async rowsById(table: Pick<TableDefinition, 'id' | 'revision'>, ids: readonly string[], signal: AbortSignal) {
      return z
        .array(recordSchema)
        .parse(
          await request(
            `/${encodeURIComponent(table.id)}/rows?revision=${encodeURIComponent(table.revision)}&limit=100&ids=${ids.map(encodeURIComponent).join(',')}`,
            signal,
          ),
        );
    },
    async capabilities(tableId: string, signal: AbortSignal) {
      return queryCapabilitiesSchema.parse(
        await queryRequest(`/${encodeURIComponent(tableId)}/query-capabilities`, signal),
      );
    },
    /** Normalizes typed RSQL or a filter tree without reading rows. Linked-row names resolve to IDs or return choices. */
    async validateQuery(
      table: Pick<TableDefinition, 'id' | 'revision'>,
      request: TableQueryRequest,
      signal: AbortSignal,
    ) {
      return queryValidationSchema.parse(
        await queryRequest(`/${encodeURIComponent(table.id)}/query/validate`, signal, {
          revision: table.revision,
          request,
        }),
      );
    },
    /** Pass `after` inside the options exactly as the previous page's `nextCursor`; a cursor belongs to one query. */
    async query(table: Pick<TableDefinition, 'id' | 'revision'>, request: TableQueryRequest, signal: AbortSignal) {
      return queryResultSchema.parse(
        await queryRequest(`/${encodeURIComponent(table.id)}/query`, signal, { revision: table.revision, request }),
      );
    },
    async queryReferences(
      tableId: string,
      fieldId: string,
      lookup: { search?: string; ids?: readonly string[] },
      signal: AbortSignal,
    ) {
      const params = new URLSearchParams({ fieldId, limit: '20' });
      if (lookup.search) params.set('search', lookup.search);
      if (lookup.ids?.length) params.set('ids', lookup.ids.join(','));
      return referenceChoicesSchema.parse(
        await queryRequest(`/${encodeURIComponent(tableId)}/query/references?${params}`, signal),
      ).choices;
    },
    /** Turns a description into a query. It never reads rows; the browser runs the returned query separately. */
    async translate(tableId: string, input: TranslationInput, signal: AbortSignal) {
      return translationSchema.parse(
        await queryRequest(`/${encodeURIComponent(tableId)}/query/translate`, signal, input),
      );
    },
    /** Recovers the outcome of a translation whose response was lost. It never starts a new model call. */
    async translation(tableId: string, requestId: string, signal: AbortSignal) {
      return translationSchema.parse(
        await queryRequest(
          `/${encodeURIComponent(tableId)}/query/translations/${encodeURIComponent(requestId)}`,
          signal,
        ),
      );
    },
    async mutate(input: RecordMutation) {
      if (input.kind === 'member-photo' || input.kind === 'member-repair') {
        return mutationResultSchema.parse(
          await request(
            `/${encodeURIComponent(input.recordId)}`,
            AbortSignal.timeout(15_000),
            input,
            `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/workspace-members`,
          ),
        );
      }
      return mutationResultSchema.parse(
        await request(`/${encodeURIComponent(input.tableId)}/rows`, AbortSignal.timeout(15_000), input),
      );
    },
    async receipt(
      input: Pick<RecordMutation, 'tableId' | 'requestId'>,
      signal: AbortSignal = AbortSignal.timeout(15_000),
    ) {
      return requestStatusSchema.parse(
        await request(`/${encodeURIComponent(input.tableId)}/requests/${encodeURIComponent(input.requestId)}`, signal),
      );
    },
    async history(tableId: string, recordId: string, after: string | undefined, signal: AbortSignal) {
      return z
        .array(historyEntrySchema)
        .parse(
          await request(
            `/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(recordId)}/history?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
            signal,
          ),
        );
    },
    async reverseFields(tableId: string, recordId: string, after: string | undefined, signal: AbortSignal) {
      return reverseFieldsSchema.parse(
        await request(
          `/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(recordId)}/reverse-fields?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
          signal,
        ),
      );
    },
    async reverseRecords(
      tableId: string,
      recordId: string,
      fieldId: string,
      after: string | undefined,
      signal: AbortSignal,
    ) {
      return reverseRecordsSchema.parse(
        await request(
          `/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(recordId)}/reverse/${encodeURIComponent(fieldId)}?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
          signal,
        ),
      );
    },
  };
}
export type TableApi = ReturnType<typeof tableApi>;
