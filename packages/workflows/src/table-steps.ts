import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  type AuthorizationTransaction,
  type HumanActor,
  type TablePermission,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { TableValidationError, type TableField } from '@tulipfarm/tables/definition';
import { createTableService } from '@tulipfarm/tables/service';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { activeGeneration, GenerationError, identity, type Generation } from '@tulipfarm/tables/store';
import {
  idSchema,
  isTableStep,
  outputPathIssues,
  payloadSchema,
  resolveValue,
  rowReferenceSchema,
  type Definition,
  type OutputTable,
  type TableStep,
} from './contracts.ts';
import { WorkflowConflict } from './commands.ts';
import type { WorkflowTransaction } from './authorization.ts';

type Payload = z.infer<typeof payloadSchema>;
type StepTransaction = WorkflowTransaction & { workspaceId: string };
type Transaction = AuthorizationTransaction;
export type TableStepFailureCode =
  | 'table-input-invalid'
  | 'table-field-unavailable'
  | 'table-unavailable'
  | 'table-row-stale'
  | 'table-row-duplicate'
  | 'table-row-linked'
  | 'table-output-too-large';
export type TableStepResult =
  | { kind: 'completed'; output: Payload }
  | { kind: 'failed'; error: TableStepFailureCode }
  | { kind: 'blocked'; error: 'table-authority-revoked' };

class TableStepFailure extends Error {
  readonly code: TableStepFailureCode;
  constructor(code: TableStepFailureCode) {
    super(code);
    this.code = code;
  }
}

const table = (tx: Transaction, name: string) => qualified(tx.schema, name);
const filterableKinds = new Set<TableField['kind']>([
  'text',
  'numeric',
  'boolean',
  'date',
  'timestamp',
  'single-select',
]);
// File values stay out of runs: a run's audience may lack the file grants a table reader needs to open them.
const writable = (field: TableField) => field.kind !== 'file';
const stepPermissions = (step: TableStep): TablePermission[] =>
  step.kind === 'find-rows'
    ? ['table.row.read']
    : step.kind === 'create-row'
      ? ['table.row.read', 'table.row.create']
      : ['table.row.read', 'table.row.update'];

function tableSteps(definition: Definition) {
  return definition.steps.filter(isTableStep);
}

async function memberActor(tx: Transaction, membershipId: string): Promise<HumanActor | null> {
  const member = (
    await tx.client.query(`SELECT user_id FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`, [
      idSchema.parse(membershipId),
    ])
  ).rows[0];
  return member ? { kind: 'human', userId: z.string().parse(member.user_id), membershipId } : null;
}

async function permitted(tx: Transaction, membershipId: string, definition: Definition, write: boolean) {
  if (!tableSteps(definition).length) return true;
  const actor = await memberActor(tx, membershipId);
  if (!actor) return false;
  for (const step of tableSteps(definition)) {
    for (const permission of write ? stepPermissions(step) : ['table.row.read' as const]) {
      try {
        if (!(await canAccessTable(tx, actor, step.tableId, permission))) return false;
      } catch (error) {
        if (error instanceof AccessDenied) return false;
        throw error;
      }
    }
  }
  return true;
}

/** Table step outputs carry row values, so every member who starts or sees a run must be able to read each table its steps use. */
export async function requireTableStepReader(tx: Transaction, membershipId: string, definition: Definition) {
  if (!(await permitted(tx, membershipId, definition, false))) throw new AccessDenied();
}

/** Naming a sponsor who cannot write the rows, or an audience member who cannot read them, is a fixable choice. */
export async function requireTableStepAuthority(
  tx: Transaction,
  definition: Definition,
  sponsor: string,
  audience: string[],
) {
  if (!(await permitted(tx, sponsor, definition, true))) throw new WorkflowConflict('table-step-access-denied');
  for (const membershipId of audience)
    if (!(await permitted(tx, membershipId, definition, false))) throw new WorkflowConflict('table-step-access-denied');
}

/** At save, the author must be able to read each table, and every field a step names must exist with a kind the step can use. */
export async function requireTableStepFields(tx: Transaction, membershipId: string, definition: Definition) {
  await requireTableStepReader(tx, membershipId, definition);
  const labels: { id: string; table: string; fields: Record<string, string> }[] = [];
  const tables: OutputTable[] = [];
  for (const step of tableSteps(definition)) {
    let generation: Generation;
    try {
      generation = await activeGeneration(tx, step.tableId);
    } catch (error) {
      if (error instanceof GenerationError) throw new WorkflowConflict('table-step-field-unavailable');
      throw error;
    }
    const field = (id: string) => generation.definition.fields.find(item => item.id === id);
    tables.push({ id: step.tableId, fields: generation.definition.fields });
    const usable =
      step.kind === 'find-rows'
        ? step.filters.every(filter => {
            const found = field(filter.fieldId);
            return found && filterableKinds.has(found.kind);
          })
        : Object.keys(step.fields).every(id => {
            const found = field(id);
            return found && writable(found);
          });
    if (!usable) throw new WorkflowConflict('table-step-field-unavailable');
    const ids = step.kind === 'find-rows' ? step.filters.map(filter => filter.fieldId) : Object.keys(step.fields);
    labels.push({
      id: step.id,
      table: generation.definition.label,
      fields: Object.fromEntries(ids.map(id => [id, field(id)?.label ?? ''])),
    });
  }
  const issues = outputPathIssues(definition, tables);
  if (issues.length) throw new z.ZodError(issues.map(issue => ({ ...issue, path: ['definition', ...issue.path] })));
  return labels;
}

function decimal(value: number) {
  const text = String(value);
  if (!Number.isFinite(value) || /e/i.test(text)) throw new TableStepFailure('table-input-invalid');
  return text;
}

function option(field: Extract<TableField, { kind: 'single-select' | 'multi-select' }>, value: unknown) {
  if (typeof value !== 'string') throw new TableStepFailure('table-input-invalid');
  const found = field.options.find(item => !item.retired && (item.id === value.toLowerCase() || item.label === value));
  if (!found) throw new TableStepFailure('table-input-invalid');
  return found.id;
}

/** A mapped value is either a typed table value, such as one copied from a found row, or a plain JSON value converted for the field's kind. */
function tableValue(field: TableField, value: Payload): unknown {
  if (value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'kind' in value) return value;
  switch (field.kind) {
    case 'text':
      return { kind: 'text', value: typeof value === 'number' ? String(value) : value };
    case 'numeric':
      return { kind: 'numeric', value: typeof value === 'number' ? decimal(value) : value };
    case 'boolean':
    case 'date':
    case 'timestamp':
      return { kind: field.kind, value };
    case 'single-select':
      return { kind: 'single-select', optionId: option(field, value) };
    case 'multi-select':
      return {
        kind: 'multi-select',
        optionIds: (Array.isArray(value) ? value : [value]).map(item => option(field, item)),
      };
    case 'relationship':
      return { kind: 'relationship', tableId: field.targetTableId, recordIds: Array.isArray(value) ? value : [value] };
    case 'file':
      throw new TableStepFailure('table-field-unavailable');
  }
}

function filterValue(value: Payload) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return decimal(value);
  throw new TableStepFailure('table-input-invalid');
}

function classify(error: unknown): Exclude<TableStepResult, { kind: 'completed' }> | null {
  if (error instanceof AccessDenied) return { kind: 'blocked', error: 'table-authority-revoked' };
  if (error instanceof TableStepFailure) return { kind: 'failed', error: error.code };
  if (error instanceof GenerationError) {
    const codes: Partial<Record<GenerationError['code'], TableStepFailureCode>> = {
      'stale-record': 'table-row-stale',
      'not-found': 'table-row-stale',
      'duplicate-key': 'table-row-duplicate',
      'linked-record': 'table-row-linked',
    };
    return { kind: 'failed', error: codes[error.code] ?? 'table-unavailable' };
  }
  if (error instanceof TableValidationError || error instanceof z.ZodError)
    return { kind: 'failed', error: 'table-input-invalid' };
  if (error instanceof TableError) return { kind: 'failed', error: 'table-unavailable' };
  // Data exceptions and constraint violations reject the mapped values; other database errors are outages the activity retries.
  if (typeof error === 'object' && error !== null && 'code' in error && /^2[23][0-9A-Z]{3}$/.test(String(error.code)))
    return { kind: 'failed', error: 'table-input-invalid' };
  return null;
}

/**
 * Runs one table step as the run's member: the sponsor for unattended runs, the requester otherwise.
 * The step's table writes share the caller's transaction with its receipt. The workspace authorization write lock that
 * every workflow transaction holds, plus the receipt primary key, keep a retried activity from writing twice.
 * A savepoint discards a partial write when the step fails.
 */
export async function runTableStep(
  tx: StepTransaction,
  step: TableStep,
  membershipId: string,
  input: Payload,
  outputs: Map<string, Payload>,
): Promise<TableStepResult> {
  const resolve = (value: Parameters<typeof resolveValue>[0]) => {
    try {
      return resolveValue(value, input, outputs);
    } catch {
      throw new TableStepFailure('table-input-invalid');
    }
  };
  await tx.client.query('SAVEPOINT workflow_table_step');
  try {
    const output = await perform(tx, step, membershipId, resolve);
    await tx.client.query('RELEASE SAVEPOINT workflow_table_step');
    return { kind: 'completed', output };
  } catch (error) {
    const result = classify(error);
    if (!result) throw error;
    await tx.client.query('ROLLBACK TO SAVEPOINT workflow_table_step');
    await tx.client.query('RELEASE SAVEPOINT workflow_table_step');
    return result;
  }
}

async function perform(
  tx: StepTransaction,
  step: TableStep,
  membershipId: string,
  resolve: (value: Parameters<typeof resolveValue>[0]) => Payload,
): Promise<Payload> {
  const actor = await memberActor(tx, membershipId);
  if (!actor) throw new AccessDenied();
  for (const permission of stepPermissions(step))
    if (!(await canAccessTable(tx, actor, step.tableId, permission))) throw new AccessDenied();
  if (
    (await tx.client.query(`SELECT maintenance FROM ${table(tx, 'tf_table_catalog')} WHERE id=$1`, [step.tableId]))
      .rows[0]?.maintenance
  )
    throw new TableStepFailure('table-unavailable');
  const generation = await activeGeneration(tx, step.tableId);
  const fields = generation.definition.fields;
  // The service wraps this transaction, so its checks and writes commit or roll back with the run's step receipt.
  const service = createTableService(
    {
      transaction: async (workspaceId, range, operation) => {
        if (workspaceId !== tx.workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
          throw new AccessDenied();
        return operation(tx);
      },
    },
    { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
    commonCompatibility,
  );
  const revision = generation.revision;
  if (step.kind === 'find-rows') {
    const filters = step.filters.map(filter => {
      const field = fields.find(item => item.id === filter.fieldId);
      if (!field || !filterableKinds.has(field.kind)) throw new TableStepFailure('table-field-unavailable');
      return 'value' in filter
        ? {
            fieldId: filter.fieldId,
            op: filter.op,
            value:
              field.kind === 'single-select'
                ? option(field, filterValue(resolve(filter.value)))
                : filterValue(resolve(filter.value)),
          }
        : filter;
    });
    const page = await service.listPage(tx.workspaceId, actor, {
      tableId: step.tableId,
      revision,
      query: { filters, limit: step.limit },
    });
    const hidden = new Set<string>(fields.filter(field => !writable(field)).map(field => field.id));
    const rows = [];
    for (const record of page.records) {
      const current = await identity(tx, step.tableId, record.id);
      if (!current?.live) throw new GenerationError('stale-record');
      rows.push({
        recordId: record.id,
        token: current.token,
        values: Object.fromEntries(Object.entries(record.values).filter(([id]) => !hidden.has(id))),
      });
    }
    const output = payloadSchema.safeParse({ tableId: step.tableId, rows, more: page.nextCursor !== null });
    if (!output.success) throw new TableStepFailure('table-output-too-large');
    return output.data;
  }
  const values = Object.fromEntries(
    Object.entries(step.fields).map(([fieldId, value]) => {
      const field = fields.find(item => item.id === fieldId);
      if (!field || !writable(field)) throw new TableStepFailure('table-field-unavailable');
      return [fieldId, tableValue(field, resolve(value))];
    }),
  );
  if (step.kind === 'create-row') {
    const recordId = randomUUID();
    const result = await service.mutate(tx.workspaceId, actor, {
      kind: 'create',
      tableId: step.tableId,
      revision,
      recordId,
      values,
    });
    return {
      operation: 'created',
      tableId: step.tableId,
      recordId,
      token: result.token,
      fieldIds: Object.keys(values).sort(),
    };
  }
  const row = rowReferenceSchema.safeParse(resolve(step.row));
  if (!row.success || (row.data.tableId !== undefined && row.data.tableId !== step.tableId))
    throw new TableStepFailure('table-input-invalid');
  const result = await service.mutate(tx.workspaceId, actor, {
    kind: 'update',
    tableId: step.tableId,
    revision,
    recordId: row.data.recordId,
    expectedToken: row.data.token,
    values,
  });
  return {
    operation: 'updated',
    tableId: step.tableId,
    recordId: row.data.recordId,
    token: result.token,
    fieldIds: Object.keys(values).sort(),
  };
}
