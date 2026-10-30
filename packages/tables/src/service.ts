import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  lockAuthorization,
  queryHumanContext,
  requireNoMcpDerived,
  resolveActor,
  requireTablePermission,
  type Actor,
  type TablePermission,
} from '@tulipfarm/access';
import type { TableRuntime, TableTransaction } from './service-store.ts';
import { table } from './service-store.ts';
import {
  tableIdSchema,
  recordIdSchema,
  fieldIdSchema,
  revisionSchema,
  recordQuerySchema,
  sortDirectionSchema,
  TableValidationError,
  validateRecord,
  validateValue,
  valuesSchema,
  type TableValue,
  type TableValues,
} from './definition.ts';
import * as store from './store.ts';
import {
  nameField,
  normalizeQueryRequest,
  queryCapabilities,
  recordLabel,
  referencedRecordIds,
  TableQueryError,
  type QueryIssue,
  type ReferenceNames,
  type TableQuery,
} from './query.ts';
import { bindCurrentMemberQuery, runRowsQuery, runSummaryQuery } from './query-execution.ts';
import { workspaceMemberFields, workspaceMemberMutationSchema, WorkspaceMemberError } from './workspace-members.ts';

/** listPage counts matching rows on the first page only and stops at this many, reporting `"10000+"` beyond it. */
export const listPageCountLimit = 10000;

async function countUpTo(tx: TableTransaction, source: string, parameters: unknown[]) {
  const counted = z.coerce
    .number()
    .parse(
      (
        await tx.client.query(
          `SELECT count(*) AS total FROM (SELECT 1 FROM ${source} LIMIT ${listPageCountLimit + 1}) capped`,
          parameters,
        )
      ).rows[0]?.total,
    );
  return counted > listPageCountLimit ? `${listPageCountLimit}+` : String(counted);
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;
const scalarKinds: readonly string[] = ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select'];
const sortCursorTupleSchema = z.tuple([fieldIdSchema, sortDirectionSchema, z.string().nullable(), recordIdSchema]);

// The cursor carries the anchor's sort key so paging survives the anchor row being deleted.
function decodeCursor(cursor: string, sort: { fieldId: string; direction: 'asc' | 'desc' }) {
  let decoded: z.infer<typeof sortCursorTupleSchema>;
  try {
    decoded = sortCursorTupleSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new TableValidationError('Malformed cursor');
  }
  if (decoded[0] !== sort.fieldId || decoded[1] !== sort.direction)
    throw new TableValidationError('Cursor does not match the sort');
  return decoded;
}

const baseSchema = z.object({ tableId: tableIdSchema, revision: revisionSchema, recordId: recordIdSchema });
export const mutationSchema = z.discriminatedUnion('kind', [
  baseSchema.extend({ kind: z.literal('create'), values: valuesSchema }).strict(),
  baseSchema.extend({ kind: z.literal('update'), expectedToken: z.uuid(), values: valuesSchema }).strict(),
  baseSchema.extend({ kind: z.literal('delete'), expectedToken: z.uuid() }).strict(),
  baseSchema
    .extend({
      kind: z.literal('restore'),
      expectedToken: z.uuid(),
      historyId: z.uuid(),
      version: z.enum(['before', 'after']).default('after'),
    })
    .strict(),
]);
export type RecordMutation = z.infer<typeof mutationSchema>;
const createBatchSchema = z.strictObject({
  tableId: tableIdSchema,
  revision: revisionSchema,
  rows: z
    .array(z.strictObject({ recordId: recordIdSchema, values: valuesSchema }))
    .min(1)
    .max(100),
});
export type RecordAccessHooks = {
  /** Returns the subset of `fileIds` the actor can open now. Called once per read, page, or mutation. */
  readableFiles: (tx: TableTransaction, actor: Actor, fileIds: readonly string[]) => Promise<ReadonlySet<string>>;
  admitMutation?: (tx: TableTransaction, actor: Actor, mutation: RecordMutation) => Promise<void>;
};

// A direct-human composition omits admitMutation. Agent writes then fail closed.
// Chat and import compositions must require their protected approval capability here.
export function createTableService(
  runtime: TableRuntime,
  hooks: RecordAccessHooks,
  compatibility: { minimum: number; maximum: number },
) {
  async function authorized<T>(
    workspaceId: string,
    principal: string | Actor,
    action: (tx: TableTransaction, actor: Actor) => Promise<T>,
  ) {
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveActor(tx, principal);
      return action(tx, actor);
    });
  }

  const fileIds = (value: TableValue | undefined) => (value?.kind === 'file' ? value.fileIds : []);

  const referenced = (values: TableValues[]) =>
    [...new Set(values.flatMap(record => Object.values(record).flatMap(fileIds)))].sort();

  // A reference the reader cannot open stays visible as an opaque id so one file cannot hide a shared row.
  async function unavailableFiles(tx: TableTransaction, actor: Actor, values: TableValues[][]) {
    const ids = referenced(values.flat());
    const readable = ids.length ? await hooks.readableFiles(tx, actor, ids) : new Set<string>();
    return values.map(group => referenced(group).filter(id => !readable.has(id)));
  }

  async function marked<T extends { values: TableValues }>(
    tx: TableTransaction,
    actor: Actor,
    records: T[],
  ): Promise<(T & { unavailableFileIds?: string[] })[]> {
    const unavailable = await unavailableFiles(
      tx,
      actor,
      records.map(record => [record.values]),
    );
    return records.map((record, index) =>
      unavailable[index]?.length ? { ...record, unavailableFileIds: unavailable[index] } : record,
    );
  }

  async function addedFiles(tx: TableTransaction, actor: Actor, before: TableValues | null, next: TableValues) {
    const existing = new Map(
      Object.entries(before ?? {}).map(([fieldId, value]) => [fieldId, new Set(fileIds(value))]),
    );
    const added = [
      ...new Set(
        Object.entries(next).flatMap(([fieldId, value]) =>
          fileIds(value).filter(id => !existing.get(fieldId)?.has(id)),
        ),
      ),
    ].sort();
    if (!added.length) return;
    const readable = await hooks.readableFiles(tx, actor, added);
    if (added.some(id => !readable.has(id))) throw new AccessDenied();
  }

  async function permit(tx: TableTransaction, actor: Actor, tableId: string, permission: TablePermission) {
    await requireTablePermission(tx, actor, tableId, permission);
  }

  async function read(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; revision: string; recordId: string },
  ) {
    const request = baseSchema.parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      await store.lockCatalogs(tx, [request.tableId]);
      const generation = await store.activeGeneration(tx, request.tableId);
      if (generation.revision !== request.revision) throw new store.GenerationError('stale-generation');
      const record = await store.readRecord(tx, generation, request.recordId);
      if (!record) return null;
      const [view = record] = await marked(tx, actor, [record]);
      return view;
    });
  }

  async function list(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; revision: string; after?: string; ids?: string[]; limit?: number },
  ) {
    const request = z
      .object({
        tableId: tableIdSchema,
        revision: revisionSchema,
        after: recordIdSchema.optional(),
        ids: z.array(recordIdSchema).min(1).max(100).optional(),
        limit: z.int().min(1).max(1000).default(100),
      })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      await store.lockCatalogs(tx, [request.tableId]);
      const generation = await store.activeGeneration(tx, request.tableId);
      if (generation.revision !== request.revision) throw new store.GenerationError('stale-generation');
      const records = await store.readRecords(tx, generation, {
        after: request.after ?? null,
        limit: request.limit,
        ...(request.ids ? { ids: request.ids } : {}),
      });
      return marked(tx, actor, records);
    });
  }

  async function mutate(workspaceId: string, principal: string | Actor, input: unknown) {
    const mutation = mutationSchema.parse(input);
    return authorized(workspaceId, principal, (tx, actor) => applyMutation(tx, actor, mutation));
  }

  async function applyMutation(tx: TableTransaction, actor: Actor, mutation: RecordMutation, reservedToken?: string) {
    await requireNoMcpDerived(tx, [], actor);
    await permit(tx, actor, mutation.tableId, 'table.row.read');
    if (mutation.kind !== 'restore') await permit(tx, actor, mutation.tableId, `table.row.${mutation.kind}`);
    if (actor.kind === 'agent' && !hooks.admitMutation) throw new AccessDenied();
    await hooks.admitMutation?.(tx, actor, mutation);
    const initial = await store.activeGeneration(tx, mutation.tableId);
    if (initial.revision !== mutation.revision) throw new store.GenerationError('stale-generation');
    const before = await store.readRecord(tx, initial, mutation.recordId);
    const currentIdentity = await store.identity(tx, mutation.tableId, mutation.recordId);
    const canCreate = (current: Awaited<ReturnType<typeof store.identity>>) =>
      reservedToken === undefined ? current === null : current?.token === reservedToken && !current.live;
    if (mutation.kind === 'create' ? !canCreate(currentIdentity) : currentIdentity?.token !== mutation.expectedToken)
      throw new store.GenerationError('stale-record');
    if (mutation.kind !== 'create' && mutation.kind !== 'restore' && !before)
      throw new store.GenerationError('not-found');
    if (mutation.kind === 'restore')
      await permit(tx, actor, mutation.tableId, before ? 'table.row.update' : 'table.row.create');
    const next =
      mutation.kind === 'delete'
        ? null
        : validateRecord(
            initial.definition,
            mutation.kind === 'restore'
              ? await store.restorableHistory(tx, mutation.tableId, mutation.recordId, mutation, before?.values ?? null)
              : { ...(mutation.kind === 'update' ? before?.values : {}), ...mutation.values },
          );
    if (next) await addedFiles(tx, actor, before?.values ?? null, next);
    const endpoints = store.endpoints(mutation.tableId, mutation.recordId, before?.values ?? null, next);
    for (const table of [...new Set(endpoints.map(endpoint => endpoint.tableId))].sort()) {
      if (table !== mutation.tableId) await permit(tx, actor, table, 'table.row.read');
    }

    await store.lockCatalogs(
      tx,
      endpoints.map(endpoint => endpoint.tableId),
      !before || next === null,
    );
    const generation = await store.activeGeneration(tx, mutation.tableId);
    if (generation.id !== initial.id) throw new store.GenerationError('stale-generation');
    await store.lockUniqueValues(tx, generation, [before?.values ?? null, next]);
    await store.lockIdentities(tx, endpoints);
    const lockedIdentity = await store.identity(tx, mutation.tableId, mutation.recordId);
    if (mutation.kind === 'create' ? !canCreate(lockedIdentity) : lockedIdentity?.token !== mutation.expectedToken)
      throw new store.GenerationError('stale-record');
    if (next)
      for (const endpoint of store.endpoints(mutation.tableId, mutation.recordId, next).slice(1)) {
        if (endpoint.tableId === mutation.tableId && endpoint.recordId === mutation.recordId) continue;
        const target = await store.identity(tx, endpoint.tableId, endpoint.recordId);
        if (!target?.live) throw new store.GenerationError('linked-record');
      }
    return store.persistMutation(tx, {
      generation,
      recordId: mutation.recordId,
      before: before?.values ?? null,
      values: next,
      actor,
      operation: mutation.kind,
      ...(mutation.kind === 'restore'
        ? { restoration: { historyId: mutation.historyId, version: mutation.version } }
        : {}),
      ...(mutation.kind === 'update' ? { writtenFieldIds: Object.keys(mutation.values) } : {}),
    });
  }

  async function mutateMember(workspaceId: string, principal: string | Actor, input: unknown) {
    const mutation = workspaceMemberMutationSchema.parse(input);
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx, mutation.kind === 'member-repair' ? 'write' : 'read');
      const actor = await resolveActor(tx, principal);
      if (actor.kind !== 'human') throw new AccessDenied();
      await requireNoMcpDerived(tx, [], actor);
      if (mutation.kind === 'member-photo') return store.updateWorkspaceMemberPhoto(tx, actor, mutation);
      await permit(tx, actor, mutation.tableId, 'table.row.read');
      await permit(tx, actor, mutation.tableId, 'table.row.create');
      const registration = await store.workspaceMembersTable(tx);
      if (registration?.coreDefinition.id !== mutation.tableId)
        throw new WorkspaceMemberError('member-table-protected');
      const repairable = (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_workspace_member_accounts')} a
        JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id
        JOIN ${table(tx, 'tf_table_identities')} i ON i.table_id=a.table_id AND i.row_id=a.member_id
        WHERE a.table_id=$1 AND a.member_id=$2 AND a.profile_revision=0 AND m.removed_at IS NOT NULL
          AND NOT i.live AND i.token=$3`,
          [mutation.tableId, mutation.recordId, mutation.expectedToken],
        )
      ).rowCount;
      if (!repairable) throw new WorkspaceMemberError('member-link-conflict');
      return applyMutation(
        tx,
        actor,
        {
          kind: 'create',
          tableId: mutation.tableId,
          revision: mutation.revision,
          recordId: mutation.recordId,
          values: mutation.values,
        },
        mutation.expectedToken,
      );
    });
  }

  async function createBatch(workspaceId: string, principal: string | Actor, input: unknown) {
    const batch = createBatchSchema.parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      // Named agents must continue through their per-action approval capability.
      if (actor.kind !== 'human') throw new AccessDenied();
      const bound: TableRuntime = { transaction: async (_workspace, _range, operation) => operation(tx) };
      const service = createTableService(bound, hooks, compatibility);
      const records = [];
      for (const row of batch.rows) {
        const record = await service.mutate(workspaceId, actor, {
          kind: 'create',
          tableId: batch.tableId,
          revision: batch.revision,
          ...row,
        });
        records.push(record);
      }
      return records;
    });
  }

  async function listPage(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; revision: string; query: unknown },
  ) {
    const request = z
      .object({ tableId: tableIdSchema, revision: revisionSchema, query: recordQuerySchema })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      await store.lockCatalogs(tx, [request.tableId]);
      const generation = await store.activeGeneration(tx, request.tableId);
      if (generation.revision !== request.revision) throw new store.GenerationError('stale-generation');
      const { query } = request,
        parameters: unknown[] = [];
      const columnOf = (id: string) => `"f_${id.replaceAll('-', '')}"`;
      const predicates = query.filters.map(filter => {
        const field = generation.definition.fields.find(field => field.id === filter.fieldId);
        if (!field) throw new TableValidationError('Unknown filter field');
        const column = columnOf(field.id);
        if (filter.op === 'is-null' || filter.op === 'not-null')
          return `${column} IS ${filter.op === 'not-null' ? 'NOT ' : ''}NULL`;
        if (!('value' in filter) || !scalarKinds.includes(field.kind) || filter.value === null)
          throw new TableValidationError('Use scalar values or explicit null filters');
        if (field.kind === 'boolean' && filter.op !== 'eq' && filter.op !== 'ne')
          throw new TableValidationError('Boolean ordering is unsupported');
        if (field.kind === 'single-select' && filter.op !== 'eq' && filter.op !== 'ne')
          throw new TableValidationError('Single-choice ordering is unsupported');
        const value =
          field.kind === 'single-select'
            ? validateValue(field, { kind: field.kind, optionId: filter.value })
            : validateValue(field, { kind: field.kind, value: filter.value });
        if (!value || (!('value' in value) && !('optionId' in value)))
          throw new TableValidationError('Expected scalar filter');
        parameters.push('optionId' in value ? value.optionId : value.value);
        const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
        return `${column} ${operators[filter.op]} $${parameters.length}`;
      });
      if (query.search) {
        const textColumns = generation.definition.fields
          .filter(field => field.kind === 'text')
          .map(field => columnOf(field.id));
        if (textColumns.length) parameters.push(likePattern(query.search));
        predicates.push(
          textColumns.length
            ? `(${textColumns.map(column => `${column} ILIKE $${parameters.length}`).join(' OR ')})`
            : 'FALSE',
        );
      }
      const sortField = query.sort && generation.definition.fields.find(field => field.id === query.sort?.fieldId);
      if (query.sort && !sortField) throw new TableValidationError('Unknown sort field');
      if (sortField && !scalarKinds.includes(sortField.kind)) throw new TableValidationError('Unsortable field');
      const where = predicates.length ? predicates.join(' AND ') : 'TRUE';
      const total = query.after
        ? null
        : await countUpTo(tx, `${table(tx, generation.physical_table)} WHERE ${where}`, parameters);
      let after = 'TRUE',
        order = 'id',
        key = 'NULL';
      if (query.sort && sortField) {
        const column = columnOf(sortField.id),
          direction = query.sort.direction;
        order = `${column} ${direction.toUpperCase()} NULLS LAST, id`;
        key = `${column}::text`;
        if (query.after) {
          const [, , value, anchor] = decodeCursor(query.after, query.sort);
          parameters.push(anchor);
          if (value === null) after = `(${column} IS NULL AND id>$${parameters.length})`;
          else {
            parameters.push(value);
            after = `(${column} ${direction === 'asc' ? '>' : '<'} $${parameters.length} OR (${column}=$${parameters.length} AND id>$${parameters.length - 1}) OR ${column} IS NULL)`;
          }
        }
      } else if (query.after) {
        const anchor = recordIdSchema.safeParse(query.after);
        if (!anchor.success) throw new TableValidationError('Cursor does not match the sort');
        parameters.push(anchor.data);
        after = `id>$${parameters.length}`;
      }
      parameters.push(query.limit + 1);
      const rows = z
        .array(z.object({ id: recordIdSchema, key: z.string().nullable() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id,${key} AS key FROM ${table(tx, generation.physical_table)} WHERE ${where} AND ${after} ORDER BY ${order} LIMIT $${parameters.length}`,
              parameters,
            )
          ).rows,
        );
      const page = rows.slice(0, query.limit),
        last = page.at(-1);
      const byId = new Map(
        (page.length
          ? await store.readRecords(tx, generation, { ids: page.map(row => row.id), limit: page.length })
          : []
        ).map(record => [record.id, record]),
      );
      const records = page.flatMap(row => byId.get(row.id) ?? []);
      const nextCursor =
        rows.length > query.limit && last
          ? query.sort
            ? Buffer.from(JSON.stringify([query.sort.fieldId, query.sort.direction, last.key, last.id])).toString(
                'base64url',
              )
            : last.id
          : null;
      return { records: await marked(tx, actor, records), total, nextCursor };
    });
  }

  async function history(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; recordId: string; after?: string; limit?: number },
  ) {
    const request = z
      .object({
        tableId: tableIdSchema,
        recordId: recordIdSchema,
        after: z.uuid().optional(),
        limit: z.int().min(1).max(100).default(50),
      })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      const rows = await tx.client.query(
        `SELECT id,token,actor,operation,field_ids,outcome,created_at,recoverable_until,CASE WHEN recoverable_until>clock_timestamp() THEN values ELSE NULL END AS values,CASE WHEN recoverable_until>clock_timestamp() THEN before_values ELSE NULL END AS before_values FROM ${table(tx, 'tf_table_row_history')} WHERE table_id=$1 AND row_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [request.tableId, request.recordId, request.after ?? null, request.limit],
      );
      const entries = z
        .array(
          z.object({
            id: z.uuid(),
            token: z.uuid(),
            actor: z.unknown(),
            operation: z.enum(['create', 'update', 'delete', 'restore', 'transform']),
            field_ids: z.array(fieldIdSchema),
            outcome: z.literal('applied'),
            created_at: z.date(),
            recoverable_until: z.date(),
            values: valuesSchema.nullable(),
            before_values: valuesSchema.nullable(),
          }),
        )
        .parse(rows.rows);
      const unavailable = await unavailableFiles(
        tx,
        actor,
        entries.map(entry => [entry.values ?? {}, entry.before_values ?? {}]),
      );
      return entries.map((entry, index): typeof entry & { unavailable_file_ids?: string[] } =>
        unavailable[index]?.length ? { ...entry, unavailable_file_ids: unavailable[index] } : entry,
      );
    });
  }

  async function deletedRecords(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; after?: string; limit?: number },
  ) {
    const request = z
      .object({ tableId: tableIdSchema, after: recordIdSchema.optional(), limit: z.int().min(1).max(100).default(50) })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      const rows = z
        .array(
          z.object({ id: recordIdSchema, token: z.uuid(), deletedAt: z.date(), recoverableUntil: z.date().nullable() }),
        )
        .parse(
          (
            await tx.client.query(
              `
        SELECT i.row_id AS id,i.token,i.updated_at AS "deletedAt",
          (SELECT max(h.recoverable_until) FROM ${table(tx, 'tf_table_row_history')} h
           WHERE h.table_id=i.table_id AND h.row_id=i.row_id
             AND h.recoverable_until>clock_timestamp() AND (h.values IS NOT NULL OR h.before_values IS NOT NULL)) AS "recoverableUntil"
        FROM ${table(tx, 'tf_table_identities')} i
        WHERE i.table_id=$1 AND NOT i.live AND ($2::uuid IS NULL OR i.row_id>$2)
        ORDER BY i.row_id LIMIT $3`,
              [request.tableId, request.after ?? null, request.limit + 1],
            )
          ).rows,
        );
      const records = rows.slice(0, request.limit);
      return { records, nextCursor: rows.length > request.limit ? (records.at(-1)?.id ?? null) : null };
    });
  }

  async function reverse(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; recordId: string; fieldId: string; after?: string; limit?: number },
  ) {
    const request = z
      .object({
        tableId: tableIdSchema,
        recordId: recordIdSchema,
        fieldId: fieldIdSchema,
        after: recordIdSchema.optional(),
        limit: z.int().min(1).max(1000).default(100),
      })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      const getDefinition = async () =>
        z
          .object({ source_table: tableIdSchema, source_field: fieldIdSchema, cardinality: z.enum(['one', 'many']) })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'tf_table_reverse_fields')} WHERE target_table=$1 AND field_id=$2`,
                [request.tableId, request.fieldId],
              )
            ).rows[0],
          );
      const initial = await getDefinition();
      if (!initial) throw new store.GenerationError('not-found');
      await permit(tx, actor, initial.source_table, 'table.row.read');
      await store.lockCatalogs(tx, [request.tableId, initial.source_table]);
      const definition = await getDefinition();
      if (
        !definition ||
        definition.source_table !== initial.source_table ||
        definition.source_field !== initial.source_field
      )
        throw new store.GenerationError('stale-generation');
      const ids = z
        .array(z.object({ source_row: recordIdSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT source_row FROM ${table(tx, 'tf_table_links')} WHERE target_table=$1 AND target_row=$2 AND source_table=$3 AND field_id=$4 AND ($5::uuid IS NULL OR source_row>$5) ORDER BY source_row LIMIT $6`,
              [
                request.tableId,
                request.recordId,
                definition.source_table,
                definition.source_field,
                request.after ?? null,
                request.limit + 1,
              ],
            )
          ).rows,
        )
        .map(row => row.source_row);
      const recordIds = ids.slice(0, request.limit);
      return {
        kind: 'relationship' as const,
        tableId: definition.source_table,
        cardinality: definition.cardinality,
        recordIds,
        nextCursor: ids.length > request.limit ? (recordIds.at(-1) ?? null) : null,
      };
    });
  }

  async function reverseFields(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; after?: string; limit?: number },
  ) {
    const request = z
      .object({ tableId: tableIdSchema, after: fieldIdSchema.optional(), limit: z.int().min(1).max(100).default(50) })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      await permit(tx, actor, request.tableId, 'table.row.read');
      const rows = z
        .array(
          z.object({
            field_id: fieldIdSchema,
            source_table: tableIdSchema,
            label: z.string(),
            cardinality: z.enum(['one', 'many']),
          }),
        )
        .parse(
          (
            await tx.client.query(
              `SELECT field_id,source_table,label,cardinality FROM ${table(tx, 'tf_table_reverse_fields')} WHERE target_table=$1 AND ($2::uuid IS NULL OR field_id>$2) ORDER BY field_id LIMIT $3`,
              [request.tableId, request.after ?? null, request.limit + 1],
            )
          ).rows,
        );
      const visible = [];
      for (const row of rows)
        if (await canAccessTable(tx, actor, row.source_table, 'table.row.read'))
          visible.push({
            fieldId: row.field_id,
            tableId: row.source_table,
            label: row.label,
            cardinality: row.cardinality,
          });
      const fields = visible.slice(0, request.limit);
      return {
        fields,
        nextCursor: rows.length > request.limit ? (rows.at(request.limit - 1)?.field_id ?? null) : null,
      };
    });
  }

  /** Sorted lists load at most this many tables, sort them in memory, and page by numeric offset cursors. */
  const sortedListLimit = 500;
  const tableSorts = ['name', 'records', 'changed'] as const;

  async function definitions(
    workspaceId: string,
    principal: string | Actor,
    input: {
      after?: string;
      search?: string;
      archived?: boolean;
      limit?: number;
      sort?: (typeof tableSorts)[number];
      direction?: 'asc' | 'desc';
    } = {},
  ) {
    const query = z
      .object({
        after: z.string().max(40).optional(),
        search: z.string().trim().min(1).max(255).optional(),
        archived: z.boolean().default(false),
        limit: z.int().min(1).max(100).default(50),
        sort: z.enum(tableSorts).optional(),
        direction: z.enum(['asc', 'desc']).default('asc'),
      })
      .parse(input);
    const pattern = query.search ? likePattern(query.search) : null;
    return authorized(workspaceId, principal, async (tx, actor) => {
      const memberTableId = (await store.workspaceMembersTable(tx))?.coreDefinition.id;
      const select = `SELECT g.*,c.owning_team_id FROM ${table(tx, 'tf_table_generations')} g JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=g.table_id WHERE g.state='active' AND (c.archived_at IS NOT NULL)=$1 AND ($2::text IS NULL OR g.definition->>'label' ILIKE $2)`;
      const entry = (row: Record<string, unknown>) => ({
        ...store.currentGeneration(row),
        appliedAt: z
          .date()
          .nullable()
          .parse(row.activated_at ?? null),
      });
      const publish = async (row: ReturnType<typeof entry>, recordCount?: string) => ({
        id: row.table_id,
        revision: row.revision,
        definition: row.definition,
        appliedAt: row.appliedAt,
        recordCount: recordCount ?? (await countUpTo(tx, table(tx, row.physical_table), [])),
        ...(row.table_id === memberTableId ? { systemKind: 'workspace-members' as const } : {}),
      });
      if (!query.sort) {
        const after = tableIdSchema.optional().parse(query.after);
        const rows = (
          await tx.client.query(`${select} AND ($3::uuid IS NULL OR g.table_id>$3) ORDER BY g.table_id LIMIT $4`, [
            query.archived,
            pattern,
            after ?? null,
            query.limit,
          ])
        ).rows.map(entry);
        const tables = [];
        for (const row of rows)
          if (await canAccessTable(tx, actor, row.table_id, 'table.row.read')) tables.push(await publish(row));
        return { tables, nextCursor: rows.length === query.limit ? (rows.at(-1)?.table_id ?? null) : null };
      }
      const offset = z.coerce.number().int().min(0).default(0).parse(query.after);
      const visible: ReturnType<typeof entry>[] = [];
      for (const row of (
        await tx.client.query(`${select} ORDER BY g.table_id LIMIT ${sortedListLimit}`, [query.archived, pattern])
      ).rows.map(entry))
        if (await canAccessTable(tx, actor, row.table_id, 'table.row.read')) visible.push(row);
      const counts = new Map<string, string>();
      if (query.sort === 'records')
        for (const row of visible) counts.set(row.table_id, await countUpTo(tx, table(tx, row.physical_table), []));
      const key = (row: (typeof visible)[number]) =>
        query.sort === 'records'
          ? Number.parseInt(counts.get(row.table_id) ?? '0', 10)
          : query.sort === 'changed'
            ? (row.appliedAt?.getTime() ?? Number.NEGATIVE_INFINITY)
            : 0;
      const byName = (left: (typeof visible)[number], right: (typeof visible)[number]) =>
        left.definition.label.localeCompare(right.definition.label, 'en', { sensitivity: 'base' }) ||
        left.table_id.localeCompare(right.table_id);
      const sign = query.direction === 'asc' ? 1 : -1;
      visible.sort((left, right) =>
        query.sort === 'name' ? sign * byName(left, right) : sign * (key(left) - key(right)) || byName(left, right),
      );
      const page = visible.slice(offset, offset + query.limit);
      const tables = [];
      for (const row of page) tables.push(await publish(row, counts.get(row.table_id)));
      return { tables, nextCursor: visible.length > offset + query.limit ? String(offset + query.limit) : null };
    });
  }
  async function activeFor(tx: TableTransaction, actor: Actor, tableId: string, revision?: string) {
    await permit(tx, actor, tableId, 'table.row.read');
    await store.lockCatalogs(tx, [tableId]);
    const generation = await store.activeGeneration(tx, tableId);
    if (revision !== undefined && generation.revision !== revision) throw new store.GenerationError('stale-generation');
    return generation;
  }

  type Lookup = { ids: string[] } | { exact: string } | { search?: string };
  // Name lookup is bounded to one relationship's target table, its name field, and the reader's access to that table.
  async function lookupTargets(
    tx: TableTransaction,
    actor: Actor,
    source: store.Generation,
    fieldId: string,
    lookup: Lookup,
    limit: number,
  ) {
    const field = source.definition.fields.find(item => item.id === fieldId);
    if (field?.kind !== 'relationship')
      throw new TableQueryError([{ code: 'unknown-field', message: 'Choose a link field from this table.' }]);
    const target = await activeFor(tx, actor, field.targetTableId);
    const named = nameField(target.definition),
      parameters: unknown[] = [];
    const physical = (id: string) => `"f_${id.replaceAll('-', '')}"`;
    const column = named ? physical(named.id) : null;
    const systemKind =
      (await store.workspaceMembersTable(tx))?.coreDefinition.id === target.table_id ? 'workspace-members' : undefined;
    // People are often named by part of their email, so a member search also matches both email fields.
    const searched = !column
      ? []
      : systemKind
        ? [column, physical(workspaceMemberFields.contactEmail), physical(workspaceMemberFields.accountEmail)]
        : [column];
    let where: string;
    if ('ids' in lookup) {
      parameters.push(lookup.ids);
      where = 'id = ANY($1::uuid[])';
    } else if ('exact' in lookup) {
      if (!column) return [];
      parameters.push(lookup.exact);
      where = `lower(${column}) = lower($1)`;
    } else if (lookup.search) {
      if (!column) return [];
      parameters.push(likePattern(lookup.search));
      where = `(${searched.map(item => `${item} ILIKE $1`).join(' OR ')})`;
    } else where = 'TRUE';
    parameters.push(limit);
    const ids = z
      .array(z.object({ id: recordIdSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT id FROM ${table(tx, target.physical_table)} WHERE ${where} ORDER BY ${column ? `${column} NULLS LAST,` : ''}id LIMIT $${parameters.length}`,
            parameters,
          )
        ).rows,
      )
      .map(row => row.id);
    const records = ids.length ? await store.readRecords(tx, target, { ids, limit: ids.length }) : [];
    const byId = new Map(records.map(record => [record.id, record]));
    return ids.flatMap(id => {
      const record = byId.get(id);
      return record ? [{ id, label: recordLabel(target.definition, record.values, systemKind) }] : [];
    });
  }

  // Unresolved linked-row names are looked up deterministically; ambiguity returns authorized choices instead of guessing.
  async function normalized(tx: TableTransaction, actor: Actor, generation: store.Generation, request: unknown) {
    let references: ReferenceNames = {};
    let result: ReturnType<typeof normalizeQueryRequest>;
    try {
      result = normalizeQueryRequest(generation.definition, request);
    } catch (error) {
      if (!(error instanceof TableQueryError) || error.issues.some(issue => issue.code !== 'unresolved-reference'))
        throw error;
      const issues: QueryIssue[] = [];
      for (const issue of error.issues) {
        if (!issue.fieldId || issue.value === undefined) {
          issues.push(issue);
          continue;
        }
        const exact = await lookupTargets(tx, actor, generation, issue.fieldId, { exact: issue.value }, 6);
        if (exact.length === 1) {
          references = {
            ...references,
            [issue.fieldId]: { ...references[issue.fieldId], [issue.value.toLowerCase()]: exact[0]!.id },
          };
          continue;
        }
        // A partial name is never resolved silently; its matches become choices.
        const matches = exact.length
          ? exact
          : await lookupTargets(tx, actor, generation, issue.fieldId, { search: issue.value }, 6);
        issues.push({
          ...issue,
          message:
            exact.length > 1
              ? `More than one linked row is called "${issue.value}". Choose one.`
              : matches.length
                ? `No linked row is called exactly "${issue.value}". Choose one of these.`
                : `No linked row you can open is called "${issue.value}".`,
          choices: matches,
        });
      }
      if (issues.length) throw new TableQueryError(issues);
      result = normalizeQueryRequest(generation.definition, request, references);
    }
    // Filtering by linked rows also requires reading their table, even when the IDs came from a saved query.
    const targets = new Set(
      referencedRecordIds(generation.definition, result.query.where)
        .map(item => generation.definition.fields.find(field => field.id === item.fieldId))
        .flatMap(field => (field?.kind === 'relationship' ? [field.targetTableId] : [])),
    );
    for (const target of [...targets].sort()) await permit(tx, actor, target, 'table.row.read');
    return result;
  }

  async function referenceLabels(tx: TableTransaction, actor: Actor, generation: store.Generation, query: TableQuery) {
    const byField = new Map<string, string[]>();
    for (const item of referencedRecordIds(generation.definition, query.where))
      byField.set(item.fieldId, [...(byField.get(item.fieldId) ?? []), item.recordId]);
    const labels: Record<string, string> = {};
    for (const [fieldId, ids] of byField)
      for (const match of await lookupTargets(tx, actor, generation, fieldId, { ids: [...new Set(ids)] }, 100))
        labels[match.id] = match.label;
    return labels;
  }

  async function capabilities(workspaceId: string, principal: string | Actor, input: { tableId: string }) {
    const request = z.object({ tableId: tableIdSchema }).parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      const generation = await activeFor(tx, actor, request.tableId);
      const registration = await store.workspaceMembersTable(tx);
      const memberTableId =
        registration && (await queryHumanContext(tx, actor)) ? registration.coreDefinition.id : undefined;
      return {
        tableId: request.tableId,
        revision: generation.revision,
        ...queryCapabilities(generation.definition, memberTableId),
      };
    });
  }

  async function validateQuery(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; revision: string; request: unknown },
  ) {
    const request = z.object({ tableId: tableIdSchema, revision: revisionSchema, request: z.unknown() }).parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      const generation = await activeFor(tx, actor, request.tableId, request.revision);
      const result = await normalized(tx, actor, generation, request.request);
      await bindCurrentMemberQuery(tx, actor, generation, result.query);
      return { ...result, references: await referenceLabels(tx, actor, generation, result.query) };
    });
  }

  /** Runs a v2 row or summary query. Every call re-authorizes and re-validates; nothing from validation is trusted. */
  async function query(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; revision: string; request: unknown },
  ) {
    const request = z.object({ tableId: tableIdSchema, revision: revisionSchema, request: z.unknown() }).parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      const generation = await activeFor(tx, actor, request.tableId, request.revision);
      const { query, rsql } = await normalized(tx, actor, generation, request.request);
      const references = await referenceLabels(tx, actor, generation, query);
      const bound = await bindCurrentMemberQuery(tx, actor, generation, query);
      if (bound.query.mode === 'summary')
        return {
          mode: 'summary' as const,
          query,
          rsql,
          references,
          ...(await runSummaryQuery(tx, generation, bound.query, bound.identityScope)),
        };
      const page = await runRowsQuery(tx, generation, bound.query, bound.identityScope);
      return {
        mode: 'rows' as const,
        query,
        rsql,
        references,
        ...page,
        records: await marked(tx, actor, page.records),
      };
    });
  }

  async function references(
    workspaceId: string,
    principal: string | Actor,
    input: { tableId: string; fieldId: string; search?: string; ids?: string[]; limit?: number },
  ) {
    const request = z
      .object({
        tableId: tableIdSchema,
        fieldId: fieldIdSchema,
        search: z.string().trim().min(1).max(255).optional(),
        ids: z.array(recordIdSchema).min(1).max(100).optional(),
        limit: z.int().min(1).max(50).default(20),
      })
      .parse(input);
    return authorized(workspaceId, principal, async (tx, actor) => {
      const generation = await activeFor(tx, actor, request.tableId);
      const lookup: Lookup = request.ids ? { ids: request.ids } : request.search ? { search: request.search } : {};
      return {
        choices: await lookupTargets(
          tx,
          actor,
          generation,
          request.fieldId,
          lookup,
          request.ids ? request.ids.length : request.limit,
        ),
      };
    });
  }

  return {
    read,
    list,
    listPage,
    mutate,
    mutateMember,
    createBatch,
    history,
    deletedRecords,
    reverse,
    reverseFields,
    definitions,
    capabilities,
    validateQuery,
    query,
    references,
  };
}
