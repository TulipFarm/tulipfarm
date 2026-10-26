import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  agentRunOwner,
  canAccessTable,
  lockAuthorization,
  queryHumanContext,
  requireTablePermission,
  resolveActor,
  type Actor,
  type HumanActor,
} from '@tulipfarm/access';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { recordQuerySchema, validateRecord, valuesSchema } from '@tulipfarm/tables/definition';
import { createTableService } from '@tulipfarm/tables/service';
import {
  activeGeneration,
  GenerationError,
  identity,
  lockCatalogs,
  requireMemberMutation,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import { consumeTaskMutation } from '@tulipfarm/tables/task-admission';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { queryCapabilities, TableQueryError } from '@tulipfarm/tables/query';
import {
  agentRecordSchema,
  agentRecordListSchema,
  agentTableStatusSchema,
  agentTableInspectSchema,
  agentQueryRecordListSchema,
  agentQuerySummarySchema,
  agentReferenceChoicesSchema,
  agentQueryErrorSchema,
  agentStaleRevisionSchema,
} from './record-contracts.ts';
import { readableTableFiles } from './table-sources.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createRecordBatchSchema } from './contracts.ts';
import { visiblePage } from './visible-page.ts';

type Transaction = AgentTransaction & { workspaceId: string; commonVersion: number };
type RecordView = z.infer<typeof agentRecordSchema>;

const fileIds = (values: RecordView['values'], fieldId: string) => {
  const value = values[fieldId];
  return value && typeof value === 'object' && value.kind === 'file' ? value.fileIds : [];
};

/** File ids the actor can open now. An agent reads as its run owner, so a run without an owner opens none. */
async function readableRecordFiles(tx: AgentTransaction, actor: Actor, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  if (actor.kind === 'human') return readableTableFiles(tx, actor, ids);
  try {
    return await readableTableFiles(tx, await agentRunOwner(tx, actor.runId), ids);
  } catch (error) {
    if (error instanceof AccessDenied) return new Set<string>();
    throw error;
  }
}

/** Requires owner access to each file id that `after` adds to a field relative to `before`. Kept references stay unchecked. */
export async function requireAgentRecordFiles(
  tx: AgentTransaction,
  actor: Actor,
  after: RecordView['values'],
  before: RecordView['values'] | null = null,
) {
  const ids = [
    ...new Set(
      Object.keys(after).flatMap(fieldId =>
        fileIds(after, fieldId).filter(id => !before || !fileIds(before, fieldId).includes(id)),
      ),
    ),
  ];
  if (!ids.length) return;
  const owner = actor.kind === 'human' ? actor : await agentRunOwner(tx, actor.runId);
  const readable = await readableTableFiles(tx, owner, ids);
  if (ids.some(id => !readable.has(id))) throw new AccessDenied();
}

/** Re-marks retained record results with the file ids `human` cannot open now, matching the human table API. */
export async function markAgentRecordResult(tx: AgentTransaction, human: HumanActor, result: unknown) {
  const referenced = (record: RecordView) =>
    [...new Set(Object.keys(record.values).flatMap(fieldId => fileIds(record.values, fieldId)))].sort();
  async function mark(records: RecordView[]) {
    const readable = await readableTableFiles(tx, human, records.flatMap(referenced));
    return records.map((record): RecordView => {
      const { unavailableFileIds: _, ...view } = record;
      const unavailable = referenced(view).filter(id => !readable.has(id));
      return unavailable.length ? { ...view, unavailableFileIds: unavailable } : view;
    });
  }
  const record = agentRecordSchema.safeParse(result);
  if (record.success) return (await mark([record.data]))[0];
  const page = agentRecordListSchema.safeParse(result);
  if (page.success) return { ...page.data, records: await mark(page.data.records) };
  const queried = agentQueryRecordListSchema.safeParse(result);
  if (queried.success) return { ...queried.data, records: await mark(queried.data.records) };
  return result;
}

export const staleRevision = agentStaleRevisionSchema.parse({
  error: 'stale-revision',
  instruction:
    'The table schema changed. Call schema.inspect, rebuild the query with its current field IDs and appliedRevision, then retry.',
});
const queryInstruction =
  "Fix the listed parts and retry. When choices are listed, pick one by id only if the user's intent is clear, otherwise ask the user. Never invent ids.";
/** Query mistakes and schema changes are answers the model can act on, not tool failures. Access denial still propagates. */
async function queryOutcome<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TableQueryError)
      return agentQueryErrorSchema.parse({
        error: 'invalid-query',
        issues: error.issues,
        instruction: queryInstruction,
      });
    if (error instanceof GenerationError && error.code === 'stale-generation') return staleRevision;
    throw error;
  }
}
type QueryForm = { query: { where?: unknown }; rsql?: string | undefined };
const queryRequest = ({ query, rsql }: QueryForm) => {
  if (rsql === undefined) return { query };
  const { where: _where, ...options } = query;
  return { rsql, options };
};

const agentView = (record: {
  id: string;
  token: string;
  values: RecordView['values'];
  unavailableFileIds?: string[];
}) =>
  agentRecordSchema.parse({
    id: record.id,
    token: record.token,
    values: record.values,
    ...(record.unavailableFileIds ? { unavailableFileIds: record.unavailableFileIds } : {}),
  });

export function createAgentRecordTools(runtime: AgentStorage, taskCapability?: object) {
  async function run<T>(
    workspaceId: string,
    principal: string | Actor,
    tableId: string,
    operation: (tx: Transaction, actor: Actor) => Promise<T>,
    permission: 'read' | 'delete' | 'schema' = 'read',
  ) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveActor(tx, principal);
      if (actor.kind === 'agent')
        await tx.client.query(`SELECT id FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1 FOR UPDATE`, [actor.runId]);
      if (permission !== 'schema' || !(await canAccessTable(tx, actor, tableId, 'table.schema.manage')))
        await requireTablePermission(
          tx,
          actor,
          tableId,
          permission === 'delete' ? 'table.row.delete' : 'table.row.read',
        );
      await lockCatalogs(tx, [tableId]);
      const row = (
        await tx.client.query(
          `SELECT applied_definition->>'formatVersion' AS version FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1 FOR SHARE`,
          [tableId],
        )
      ).rows[0];
      if (row?.version !== '2') throw new TableError('table-not-found', 404);
      return operation({ ...tx, workspaceId }, actor);
    });
  }
  const local = (tx: Transaction): AgentStorage => ({
    transaction: async (workspaceId, range, operation) => {
      if (workspaceId !== tx.workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
        throw new AccessDenied();
      return operation(tx);
    },
  });
  const tableService = (tx: Transaction, admission?: { recordId: string; call: unknown }) =>
    createTableService(
      local(tx),
      {
        readableFiles: readableRecordFiles,
        admitMutation: async (transaction, actor) => {
          if (actor.kind !== 'agent') return;
          if (
            !(
              await transaction.client.query(
                `SELECT 1 FROM ${relation(transaction, 'tf_agent_task_runs')} WHERE run_id=$1`,
                [actor.runId],
              )
            ).rowCount
          )
            return;
          if (!admission) throw new AccessDenied();
          consumeTaskMutation(
            transaction,
            { workspaceId: tx.workspaceId, runId: actor.runId, ...admission },
            taskCapability,
          );
        },
      },
      commonCompatibility,
    );
  async function status(workspaceId: string, actor: string | Actor, tableId: string) {
    return run(
      workspaceId,
      actor,
      tableId,
      async tx => {
        const generation = await activeGeneration(tx, tableId);
        const row = (
          await tx.client.query(
            `SELECT target_revision,maintenance FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1`,
            [tableId],
          )
        ).rows[0];
        const systemKind =
          (await workspaceMembersTable(tx))?.coreDefinition.id === tableId ? 'workspace-members' : undefined;
        return agentTableStatusSchema.parse({
          id: tableId,
          owningTeamId: generation.definition.owningTeamId,
          name: generation.definition.label,
          savedRevision: row?.target_revision,
          appliedRevision: generation.revision,
          appliedDefinition: generation.definition,
          maintenance: row?.maintenance,
          migration: null,
          ...(systemKind ? { systemKind } : {}),
        });
      },
      'schema',
    );
  }
  async function inspect(workspaceId: string, actor: string | Actor, tableId: string) {
    return run(
      workspaceId,
      actor,
      tableId,
      async (tx, principal) => {
        const table = await createAgentRecordTools(local(tx)).status(workspaceId, principal, tableId);
        const registration = await workspaceMembersTable(tx);
        const memberTableId =
          registration && (await queryHumanContext(tx, principal)) ? registration.coreDefinition.id : undefined;
        const capabilities = queryCapabilities(table.appliedDefinition ?? { fields: [] }, memberTableId);
        const fields = capabilities.fields.map(
          ({ fieldId, selector, ops, sortable, groupable, metrics, targetTableId }) => ({
            fieldId,
            selector,
            ops: [...ops],
            sortable,
            groupable,
            metrics: [...metrics],
            ...(targetTableId ? { targetTableId } : {}),
          }),
        );
        return agentTableInspectSchema.parse({
          ...table,
          query: { fields, limits: capabilities.limits, rsqlOperators: capabilities.rsqlOperators },
        });
      },
      'schema',
    );
  }
  async function recordSnapshot(
    workspaceId: string,
    actor: Actor,
    tableId: string,
    revision: string,
    recordId: string,
  ) {
    return run(
      workspaceId,
      actor,
      tableId,
      async (tx, principal): Promise<{ token: string | null; record: RecordView | null }> => {
        const record = await tableService(tx).read(workspaceId, principal, { tableId, revision, recordId });
        return {
          token: (await identity(tx, tableId, recordId))?.token ?? null,
          record: record ? agentRecordSchema.parse({ id: record.id, values: record.values }) : null,
        };
      },
    );
  }
  async function mutate(
    workspaceId: string,
    actor: string | Actor,
    tableId: string,
    revision: string,
    recordId: string,
    kind: 'create' | 'update' | 'delete',
    values?: unknown,
    expectedToken?: string | null,
  ) {
    return run(
      workspaceId,
      actor,
      tableId,
      async (tx, principal) => {
        if (
          (await tx.client.query(`SELECT maintenance FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1`, [tableId]))
            .rows[0]?.maintenance
        )
          throw new TableError('table-maintenance', 503);
        const call = {
          tool: `rows.${kind}`,
          tableId,
          expectedAppliedRevision: revision,
          ...(kind === 'create' ? {} : { recordId, expectedToken }),
          ...(kind === 'delete' ? {} : { values }),
        };
        const taskBound =
          principal.kind === 'agent' &&
          Boolean(
            (
              await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_task_runs')} WHERE run_id=$1`, [
                principal.runId,
              ])
            ).rowCount,
          );
        if (taskBound && !taskCapability) throw new AccessDenied();
        if (kind !== 'create' && !expectedToken) throw new GenerationError('stale-record');
        const result = await tableService(tx, { recordId, call }).mutate(workspaceId, principal, {
          kind,
          tableId,
          revision,
          recordId,
          ...(kind === 'create' ? {} : { expectedToken }),
          ...(kind === 'delete' ? {} : { values }),
        });
        if (kind === 'delete') return true;
        const record = await tableService(tx).read(workspaceId, principal, { tableId, revision, recordId: result.id });
        if (!record) throw new GenerationError('not-found');
        return agentView(record);
      },
      kind === 'delete' ? 'delete' : 'read',
    );
  }
  async function preview(
    workspaceId: string,
    actor: Actor,
    tableId: string,
    revision: string,
    recordId: string,
    kind: 'create' | 'update',
    input: unknown,
  ) {
    return run(workspaceId, actor, tableId, async (tx, principal): Promise<RecordView> => {
      const bound = createAgentRecordTools(local(tx));
      const table = await bound.status(workspaceId, principal, tableId);
      if (!table.appliedDefinition || table.appliedRevision !== revision || table.maintenance)
        throw new TableError('applied-revision-conflict');
      const snapshot = await bound.recordSnapshot(workspaceId, principal, tableId, revision, recordId);
      const definition = table.appliedDefinition;
      if (definition.formatVersion !== 2) throw new TableError('applied-revision-conflict');
      const values = validateRecord(definition, {
        ...(kind === 'update' ? snapshot.record?.values : {}),
        ...valuesSchema.parse(input),
      });
      for (const field of definition.fields) {
        const value = values[field.id];
        if (field.kind === 'numeric' && value?.kind === 'numeric')
          value.value = z
            .string()
            .parse(
              (
                await tx.client.query(`SELECT $1::numeric(${field.precision},${field.scale})::text AS value`, [
                  value.value,
                ])
              ).rows[0]?.value,
            );
        if (value?.kind === 'multi-select') value.optionIds.sort();
        if (value?.kind === 'relationship') value.recordIds.sort();
        if (value?.kind === 'file') value.fileIds.sort();
      }
      await requireAgentRecordFiles(
        tx,
        principal,
        values,
        kind === 'update' ? (snapshot.record?.values ?? null) : null,
      );
      await requireMemberMutation(tx, {
        tableId,
        recordId,
        before: kind === 'update' ? (snapshot.record?.values ?? null) : null,
        values,
      });
      return agentRecordSchema.parse({ id: recordId, values });
    });
  }
  return {
    status,
    inspect,
    recordSnapshot,
    preview,
    async listMetadata(
      workspaceId: string,
      actor: HumanActor,
      input: { after?: string | undefined; limit?: number | undefined } = {},
    ) {
      const query = z.object({ after: z.uuid().optional(), limit: z.int().min(1).max(100).default(25) }).parse(input);
      return runtime.transaction(workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        await resolveActor(tx, actor);
        const metadata = agentTableStatusSchema.pick({
          id: true,
          name: true,
          savedRevision: true,
          appliedRevision: true,
          maintenance: true,
        });
        const page = await visiblePage(
          query,
          async (after, limit) =>
            z
              .array(metadata)
              .parse(
                (
                  await tx.client.query(
                    `SELECT id,display_name AS name,target_revision AS "savedRevision",applied_revision AS "appliedRevision",maintenance FROM ${relation(tx, 'tf_table_catalog')} WHERE archived_at IS NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
                    [after ?? null, limit],
                  )
                ).rows,
              ),
          async table => {
            if (!(await canAccessTable(tx, actor, table.id, 'table.schema.manage')))
              await requireTablePermission(tx, actor, table.id, 'table.row.read');
          },
        );
        return { tables: page.items, nextCursor: page.nextCursor };
      });
    },
    async list(
      workspaceId: string,
      actor: Actor,
      input: { after?: string | undefined; limit?: number | undefined } = {},
    ) {
      const query = z.object({ after: z.uuid().optional(), limit: z.int().min(1).max(100).default(25) }).parse(input);
      return runtime.transaction(workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        await resolveActor(tx, actor);
        // A person lists every active table and keeps those their grants open; an agent lists its run scope.
        const ids =
          actor.kind === 'human'
            ? z
                .array(z.object({ id: z.uuid() }))
                .parse(
                  (
                    await tx.client.query(
                      `SELECT id FROM ${relation(tx, 'tf_table_catalog')} WHERE archived_at IS NULL`,
                    )
                  ).rows,
                )
                .map(row => row.id)
            : z
                .array(z.object({ assetId: z.uuid() }))
                .parse(
                  (
                    await tx.client.query(`SELECT scope FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1`, [
                      actor.runId,
                    ])
                  ).rows[0]?.scope,
                )
                .map(item => item.assetId);
        const visible = [];
        for (const id of [...new Set(ids)].sort()) {
          if (
            !(
              await tx.client.query(
                `SELECT 1 FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1 AND archived_at IS NULL`,
                [id],
              )
            ).rowCount
          )
            continue;
          try {
            visible.push(await createAgentRecordTools(local({ ...tx, workspaceId })).status(workspaceId, actor, id));
          } catch (error) {
            // A table still being created has no applied definition yet; it must not hide every other table.
            if (!(error instanceof AccessDenied) && !(error instanceof TableError && error.code === 'table-not-found'))
              throw error;
          }
        }
        const page = visible.filter(item => !query.after || item.id > query.after);
        const tables = page.slice(0, query.limit);
        return {
          tables,
          total: visible.length,
          nextCursor: page.length > query.limit ? (tables.at(-1)?.id ?? null) : null,
        };
      });
    },
    async authoringContext(workspaceId: string, principal: string | Actor, tableId?: string) {
      return runtime.transaction(workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        const actor = await resolveActor(tx, principal);
        // Team names stay private to members. Table administrators receive other creatable teams as opaque ids.
        const visible =
          actor.kind === 'human'
            ? `EXISTS (SELECT 1 FROM ${relation(tx, 'tf_member_teams')} mt WHERE mt.team_id = t.id AND mt.membership_id = $1)`
            : `EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_teams')} at ON at.agent_id = r.agent_id WHERE r.id = $1 AND at.team_id = t.id)`;
        const teams = z
          .array(z.object({ id: z.uuid(), name: z.string(), visible: z.boolean() }))
          .parse(
            (
              await tx.client.query(
                `SELECT t.id, t.name, ${visible} AS visible FROM ${relation(tx, 'tf_teams')} t ORDER BY t.id`,
                [actor.kind === 'human' ? actor.membershipId : actor.runId],
              )
            ).rows,
          );
        const creatable: { id: string; name: string | null }[] = [];
        for (const team of teams)
          if (await canAccessTable(tx, actor, team.id, 'table.create'))
            creatable.push({ id: team.id, name: team.visible ? team.name : null });
        let appliedDefinition = null;
        const capabilities = {
          manageSchema: false,
          createRecord: false,
          readRecords: false,
          updateRecord: false,
          deleteRecord: false,
        };
        if (tableId) {
          capabilities.manageSchema = await canAccessTable(tx, actor, tableId, 'table.schema.manage');
          capabilities.readRecords = await canAccessTable(tx, actor, tableId, 'table.row.read');
          if (!capabilities.manageSchema && !capabilities.readRecords) throw new TableError('table-not-found', 404);
          appliedDefinition = (await activeGeneration(tx, tableId)).definition;
          capabilities.createRecord =
            capabilities.readRecords && (await canAccessTable(tx, actor, tableId, 'table.row.create'));
          capabilities.updateRecord =
            capabilities.readRecords && (await canAccessTable(tx, actor, tableId, 'table.row.update'));
          capabilities.deleteRecord = await canAccessTable(tx, actor, tableId, 'table.row.delete');
        }
        const head = z
          .object({ revision: z.string() })
          .parse((await tx.client.query(`SELECT revision FROM ${relation(tx, 'tf_soul_head')} WHERE id = 1`)).rows[0]);
        return {
          currentSoulRevision: head.revision,
          appliedDefinition,
          teams: creatable,
          creation: { allowed: creatable.length > 0, eligibleOwningTeams: creatable },
          capabilityTableId: tableId ?? null,
          capabilities,
        };
      });
    },
    lockRecords: async (workspaceId: string, actor: Actor, tableIds: string[]) => {
      for (const id of [...new Set(tableIds)].sort())
        await run(workspaceId, actor, id, async tx => {
          const generation = await activeGeneration(tx, id);
          await tx.client.query(`LOCK TABLE ${relation(tx, generation.physical_table)} IN SHARE ROW EXCLUSIVE MODE`);
        });
    },
    getRecord: (workspaceId: string, actor: string | Actor, tableId: string, revision: string, recordId: string) =>
      run(workspaceId, actor, tableId, async (tx, principal) => {
        const record = await tableService(tx).read(workspaceId, principal, { tableId, revision, recordId });
        return record ? agentView(record) : null;
      }),
    listRecords: (workspaceId: string, actor: string | Actor, tableId: string, revision: string, input: unknown) =>
      run(workspaceId, actor, tableId, async (tx, principal) => {
        const query = recordQuerySchema.parse(input);
        const page = await tableService(tx).listPage(workspaceId, principal, { tableId, revision, query });
        return { ...page, records: page.records.map(agentView) };
      }),
    /** Runs a version 2 rows query. Linked tables named in the filter are re-authorized by the table service. */
    queryRecords: (workspaceId: string, actor: string | Actor, tableId: string, revision: string, input: QueryForm) =>
      run(workspaceId, actor, tableId, (tx, principal) =>
        queryOutcome(async () => {
          const result = await tableService(tx).query(workspaceId, principal, {
            tableId,
            revision,
            request: queryRequest(input),
          });
          if (result.mode !== 'rows')
            throw new TableQueryError([
              { code: 'invalid-option', message: 'rows.list returns rows. Use rows.summarize for counts and totals.' },
            ]);
          const { after: _after, ...query } = result.query;
          return agentQueryRecordListSchema.parse({
            version: 2,
            mode: 'rows',
            query,
            rsql: result.rsql,
            references: result.references,
            records: result.records.map(agentView),
            total: result.total,
            nextCursor: result.nextCursor,
          });
        }),
      ),
    summarizeRecords: (
      workspaceId: string,
      actor: string | Actor,
      tableId: string,
      revision: string,
      input: QueryForm,
    ) =>
      run(workspaceId, actor, tableId, (tx, principal) =>
        queryOutcome(async () => {
          const result = await tableService(tx).query(workspaceId, principal, {
            tableId,
            revision,
            request: queryRequest(input),
          });
          if (result.mode !== 'summary')
            throw new TableQueryError([
              { code: 'invalid-option', message: 'rows.summarize returns groups. Use rows.list for rows.' },
            ]);
          const { after: _after, ...query } = result.query;
          return agentQuerySummarySchema.parse({
            version: 2,
            mode: 'summary',
            query,
            rsql: result.rsql,
            references: result.references,
            groups: result.groups,
            groupCount: result.groupCount,
            nextCursor: result.nextCursor,
          });
        }),
      ),
    /** Bounded name lookup in one relationship field's target table, which the reader must also be able to read. */
    resolveReference: (
      workspaceId: string,
      actor: string | Actor,
      tableId: string,
      revision: string,
      input: { fieldId: string; search: string; limit: number },
    ) =>
      run(workspaceId, actor, tableId, (tx, principal) =>
        queryOutcome(async () => {
          const generation = await activeGeneration(tx, tableId);
          if (generation.revision !== revision) throw new GenerationError('stale-generation');
          const field = generation.definition.fields.find(item => item.id === input.fieldId);
          if (field?.kind !== 'relationship')
            throw new TableQueryError([
              { code: 'unknown-field', message: 'Choose a relationship field from this table.' },
            ]);
          const { choices } = await tableService(tx).references(workspaceId, principal, {
            tableId,
            fieldId: input.fieldId,
            search: input.search,
            limit: input.limit + 1,
          });
          return agentReferenceChoicesSchema.parse({
            fieldId: field.id,
            targetTableId: field.targetTableId,
            choices: choices.slice(0, input.limit),
            more: choices.length > input.limit,
          });
        }),
      ),
    reverseRecords: (
      workspaceId: string,
      actor: string | Actor,
      tableId: string,
      recordId: string,
      fieldId: string,
      input: unknown,
    ) =>
      run(workspaceId, actor, tableId, async (tx, principal) => {
        const query = z
          .object({ after: z.uuid().optional(), limit: z.int().min(1).max(1000).default(100) })
          .parse(input);
        return tableService(tx).reverse(workspaceId, principal, {
          tableId,
          recordId,
          fieldId,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        });
      }),
    createRecord: (
      workspaceId: string,
      actor: string | Actor,
      tableId: string,
      revision: string,
      values: unknown,
      recordId: string = randomUUID(),
    ) => mutate(workspaceId, actor, tableId, revision, recordId, 'create', values),
    async createRecords(workspaceId: string, actor: Actor, input: unknown, callId: string) {
      if (actor.kind !== 'human') throw new AccessDenied();
      const batch = createRecordBatchSchema.parse(input);
      z.uuid().parse(callId);
      return run(workspaceId, actor, batch.tableId, async (tx, principal) => {
        if (
          (
            await tx.client.query(`SELECT maintenance FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1`, [
              batch.tableId,
            ])
          ).rows[0]?.maintenance
        )
          throw new TableError('table-maintenance', 503);
        const rows = batch.rows.map(({ values }, index) => {
          const hash = createHash('sha256').update(`rows.create.batch:${callId}:${index}`).digest('hex');
          const recordId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          return { recordId, values };
        });
        await tableService(tx).createBatch(workspaceId, principal, {
          tableId: batch.tableId,
          revision: batch.expectedAppliedRevision,
          rows,
        });
        const records = [];
        for (const { recordId } of rows) {
          const record = await tableService(tx).read(workspaceId, principal, {
            tableId: batch.tableId,
            revision: batch.expectedAppliedRevision,
            recordId,
          });
          if (!record) throw new GenerationError('not-found');
          records.push(agentView(record));
        }
        return agentRecordListSchema.parse({ records, total: String(records.length), nextCursor: null });
      });
    },
    updateRecord: (
      workspaceId: string,
      actor: string | Actor,
      tableId: string,
      revision: string,
      recordId: string,
      values: unknown,
      expectedToken?: string | null,
    ) => mutate(workspaceId, actor, tableId, revision, recordId, 'update', values, expectedToken),
    deleteRecord: (
      workspaceId: string,
      actor: string | Actor,
      tableId: string,
      revision: string,
      recordId: string,
      expectedToken?: string | null,
    ) => mutate(workspaceId, actor, tableId, revision, recordId, 'delete', undefined, expectedToken),
  };
}
