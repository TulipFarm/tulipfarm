import { z } from 'zod';
import {
  AccessDenied,
  humanTableGrantPredicate,
  requireTablePermission,
  requireTableCreation,
  type HumanActor,
} from '@tulipfarm/access';
import {
  fieldIdSchema,
  TableValidationError,
  valueSchema,
  valuesSchema,
  validateRecord,
  validateValue,
  type TableDefinition,
  type TableField,
  type TableValue,
  type TableValues,
} from './definition.ts';
import { canonicalJson } from './canonical.ts';
import { evaluateTransforms } from './transforms.ts';
import { table, type TableTransaction } from './service-store.ts';
import {
  audienceSchema,
  effectSchema,
  importSnapshotSchema,
  TableImportPlanError,
  TableProposalError,
  TableProposalValidationError,
  type ImportProblem,
  type ProposalPlan,
  type TableEffect,
} from './proposal-contracts.ts';
import { requireMemberTableDefinition, workspaceMembersTable } from './store.ts';
import { WorkspaceMemberError } from './workspace-members.ts';

export type FileAccess = (tx: TableTransaction, actor: HumanActor, fileIds: string[]) => Promise<void>;
/** Returns the subset of `fileIds` the actor can open now. */
export type ReadableFiles = (
  tx: TableTransaction,
  actor: HumanActor,
  fileIds: readonly string[],
) => Promise<ReadonlySet<string>>;
export const fileCheckBatch = 256;

const fieldFileIds = (value: TableValue | null | undefined) => (value?.kind === 'file' ? value.fileIds : []);

/** File ids that `after` adds to a field relative to `before`. Kept and removed references are not returned. */
export function addedFileIds(before: TableValues | null, after: TableValues | null) {
  const existing = new Map(Object.entries(before ?? {}).map(([fieldId, value]) => [fieldId, fieldFileIds(value)]));
  return [
    ...new Set(
      Object.entries(after ?? {}).flatMap(([fieldId, value]) =>
        fieldFileIds(value).filter(id => !existing.get(fieldId)?.includes(id)),
      ),
    ),
  ].sort();
}

// File checkers accept at most fileCheckBatch IDs per call, so every reference is checked one bounded batch at a time.
export async function requireFileBatches(
  tx: TableTransaction,
  actor: HumanActor,
  fileIds: Iterable<string>,
  requireFiles: FileAccess | undefined,
) {
  const ids = [...new Set(fileIds)].sort();
  if (!ids.length) return;
  if (!requireFiles) throw new AccessDenied();
  for (let offset = 0; offset < ids.length; offset += fileCheckBatch)
    await requireFiles(tx, actor, ids.slice(offset, offset + fileCheckBatch));
}

export const proposalRecordSchema = z.object({
  id: z.uuid(),
  values: valuesSchema,
  incarnation: z.uuid(),
  fieldVersions: z.record(z.string(), z.uuid()),
});
export type ProposalRecord = z.infer<typeof proposalRecordSchema>;
export const proposalFreshnessSchema = z.object({
  id: z.uuid(),
  incarnation: z.uuid().nullable(),
  fields: z.record(z.string(), z.uuid().nullable()),
});
export function proposalFreshness(
  plan: ProposalPlan,
  before: TableDefinition | null,
  changes: readonly TableEffect[],
  observed: ProposalRecord[],
  matches: ImportMatch[] = [],
) {
  const scope = new Map(changes.map(effect => [effect.recordId, new Set(Object.keys(effect.before ?? {}))]));
  if (plan.kind === 'import')
    for (const fields of scope.values()) for (const mapping of plan.mappings) fields.add(mapping.fieldId);
  if (plan.kind === 'import')
    for (const match of matches) scope.set(match.recordId, new Set(plan.mappings.map(mapping => mapping.fieldId)));
  if (plan.kind === 'records')
    for (const change of plan.changes) {
      const fields = scope.get(change.recordId) ?? new Set<string>();
      if (change.kind === 'update') for (const id of Object.keys(change.values)) fields.add(id);
      scope.set(change.recordId, fields);
    }
  if (plan.kind === 'schema') {
    const fields = new Set<string>(plan.transforms.outputs.map(output => output.fieldId));
    for (const field of before?.fields ?? [])
      if (!plan.target.fields.some(target => target.id === field.id)) fields.add(field.id);
    const pending: unknown[] = [plan.transforms];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value !== 'object' || value === null) continue;
      if ('op' in value && value.op === 'field' && 'fieldId' in value && typeof value.fieldId === 'string')
        fields.add(value.fieldId);
      pending.push(...Object.values(value));
    }
    if (fields.size) for (const row of observed) scope.set(row.id, new Set([...(scope.get(row.id) ?? []), ...fields]));
  }
  const byId = new Map(observed.map(row => [row.id, row]));
  return [...scope]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, fields]) => {
      const row = byId.get(id);
      return {
        id,
        incarnation: row?.incarnation ?? null,
        fields: Object.fromEntries(
          [...fields].sort().map(field => [field, row?.fieldVersions[field] ?? row?.incarnation ?? null]),
        ),
      };
    });
}
export type ProposalData = {
  lock(tx: TableTransaction, tableIds: string[], mode?: 'scan' | 'finalize'): Promise<'capture' | void>;
  definition(tx: TableTransaction, tableId: string): Promise<{ revision: string; definition: TableDefinition } | null>;
  records(tx: TableTransaction, tableId: string, after: string | null, ids?: string[]): Promise<ProposalRecord[]>;
};

export async function requireProposalCaptureCurrent(tx: TableTransaction, proposalId: string, tableId: string) {
  if (
    !(
      await tx.client.query(`SELECT ${table(tx, 'tf_table_proposal_capture_current')}($1,$2) AS current`, [
        proposalId,
        tableId,
      ])
    ).rows[0]?.current
  )
    throw new TableProposalError('proposal-stale');
}

export async function destinationAudience(tx: TableTransaction, tableId: string) {
  const teams = z
    .array(z.object({ team_id: z.uuid() }))
    .parse(
      (
        await tx.client.query(
          `SELECT team_id FROM ${table(tx, 'tf_grants')} WHERE asset_id=$1 AND permission='table.row.read' ORDER BY team_id`,
          [tableId],
        )
      ).rows,
    )
    .map(row => row.team_id);
  const predicate = await humanTableGrantPredicate(tx, {
    membershipId: 'm.id',
    assetId: '$1',
    permissions: "ARRAY['table.row.read']::text[]",
  });
  const members = z
    .array(z.object({ membership_id: z.uuid() }))
    .parse(
      (
        await tx.client.query(
          `SELECT m.id AS membership_id FROM ${table(tx, 'tf_memberships')} m WHERE m.removed_at IS NULL AND (m.role='admin' OR ${predicate}) ORDER BY membership_id`,
          [tableId],
        )
      ).rows,
    )
    .map(row => row.membership_id);
  return audienceSchema.parse({ policy: 'table-permissions', administrators: true, teams, members });
}

export async function planAuthority(
  tx: TableTransaction,
  actor: HumanActor,
  plan: ProposalPlan,
  before: TableDefinition | null,
  effects: readonly TableEffect[],
) {
  if (plan.kind === 'schema' && !before) await requireTableCreation(tx, actor, plan.target.owningTeamId);
  else {
    await requireTablePermission(tx, actor, plan.tableId, 'table.row.read');
    if (plan.kind === 'schema') await requireTablePermission(tx, actor, plan.tableId, 'table.schema.manage');
    const owner = z
      .uuid()
      .parse(
        (
          await tx.client.query(`SELECT owning_team_id FROM ${table(tx, 'tf_table_catalog')} WHERE id=$1 FOR SHARE`, [
            plan.tableId,
          ])
        ).rows[0]?.owning_team_id,
      );
    if (before && before.owningTeamId !== owner) throw new TableProposalError('proposal-stale');
  }
  if (plan.kind === 'schema') {
    await requireMemberTableDefinition(tx, plan.target);
    if (before && before.owningTeamId !== plan.target.owningTeamId) throw new TableProposalError('proposal-conflict');
    for (const field of [...(before?.fields ?? []), ...plan.target.fields]) {
      if (field.kind !== 'relationship') continue;
      await requireTablePermission(tx, actor, field.targetTableId, 'table.row.read');
      if (field.reverse) await requireTablePermission(tx, actor, field.targetTableId, 'table.schema.manage');
    }
  }
  if (plan.kind === 'archive' || plan.kind === 'restore') {
    await requireTablePermission(tx, actor, plan.tableId, 'table.schema.manage');
    if ((await workspaceMembersTable(tx))?.coreDefinition.id === plan.tableId)
      throw new WorkspaceMemberError('member-table-protected');
  }
  if (plan.kind === 'records')
    for (const kind of new Set(plan.changes.map(change => change.kind))) {
      await requireTablePermission(tx, actor, plan.tableId, `table.row.${kind}`);
    }
  for (const kind of new Set(effects.map(effect => effect.kind))) {
    await requireTablePermission(tx, actor, plan.tableId, `table.row.${kind}`);
  }
  if (
    plan.kind === 'schema' &&
    before &&
    before.fields.some(field => !plan.target.fields.some(target => target.id === field.id)) &&
    effects.length
  ) {
    await requireTablePermission(tx, actor, plan.tableId, 'table.row.delete');
  }
}

export async function archiveBlockers(tx: TableTransaction, tableId: string) {
  const id = fieldIdSchema.parse(tableId);
  const linked = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_table_generations')} g JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=g.table_id WHERE g.state='active' AND c.archived_at IS NULL AND g.table_id<>$1 AND g.definition::text LIKE '%' || $1 || '%' LIMIT 1`,
    [id],
  );
  if (linked.rowCount) return 'table-linked';
  const check = table(tx, 'tf_table_workflow_active');
  // The storage worker cannot read workflows; workspaces before migration 44 lack the function that checks for it.
  const checked = z
    .object({ active: z.boolean().nullable() })
    .parse(
      (
        await tx.client.query(
          `SELECT CASE WHEN to_regprocedure($2) IS NULL THEN NULL ELSE ${check}($1::uuid) END AS active`,
          [id, `${check}(uuid)`],
        )
      ).rows[0],
    ).active;
  if (checked !== null) return checked ? 'workflow-active' : null;
  const workflows = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision WHERE w.enabled AND r.definition::text LIKE '%' || $1 || '%' LIMIT 1`,
    [id],
  );
  return workflows.rowCount ? 'workflow-active' : null;
}

export function changedEffect(
  recordId: string,
  before: TableValues | null,
  after: TableValues | null,
  observed: string[] = [],
): TableEffect | null {
  if (before === null) return effectSchema.parse({ recordId, kind: 'create', before, after });
  if (after === null) return effectSchema.parse({ recordId, kind: 'delete', before, after });
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map(id => fieldIdSchema.parse(id))
    .filter(
      id =>
        canonicalJson(before[id] ?? null) !== canonicalJson(after[id] ?? null) ||
        Object.hasOwn(before, id) !== Object.hasOwn(after, id),
    );
  if (!changed.length) return null;
  const relevant = [...new Set([...changed, ...observed])].sort().map(id => fieldIdSchema.parse(id));
  return effectSchema.parse({
    recordId,
    kind: 'update',
    before: Object.fromEntries(relevant.filter(id => Object.hasOwn(before, id)).map(id => [id, before[id]])),
    after: Object.fromEntries(relevant.filter(id => Object.hasOwn(after, id)).map(id => [id, after[id]])),
  });
}

export function transformedEffect(
  plan: Extract<ProposalPlan, { kind: 'schema' }>,
  row: { id: string; values: TableValues },
) {
  if (plan.expectedRevision === null) throw new TableProposalError('proposal-stale');
  const result = evaluateTransforms({
    transforms: plan.transforms,
    values: row.values,
    target: plan.target,
    recordId: row.id,
  });
  if (!result.ok)
    throw new TableProposalValidationError(
      plan.tableId,
      plan.expectedRevision,
      [{ recordId: row.id, fieldId: result.error.fieldId ?? null, code: result.error.code }],
      1,
    );
  const fields = new Set<string>();
  const pending: unknown[] = [plan.transforms];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    if ('op' in value && value.op === 'field' && 'fieldId' in value && typeof value.fieldId === 'string')
      fields.add(value.fieldId);
    pending.push(...Object.values(value));
  }
  return changedEffect(row.id, row.values, result.values, [...fields]);
}

export function recordEffects(
  plan: Extract<ProposalPlan, { kind: 'records' }>,
  definition: TableDefinition,
  records: { id: string; values: TableValues }[],
) {
  const current = new Map(records.map(row => [row.id, row.values]));
  const effects: TableEffect[] = [];
  for (const change of plan.changes) {
    const before = current.get(change.recordId) ?? null;
    if (change.kind === 'create' ? before !== null : before === null) throw new TableProposalError('proposal-stale');
    const after =
      change.kind === 'delete'
        ? null
        : validateRecord(definition, { ...(change.kind === 'update' ? before : {}), ...change.values });
    const effect = changedEffect(change.recordId, before, after);
    if (effect) effects.push(effect);
  }
  return effects.sort((a, b) => a.recordId.localeCompare(b.recordId));
}

export type ImportMatch = {
  sourceIndex: number;
  recordId: string;
  matched: boolean;
  keyId: string;
  keyValue: unknown[];
  mapped: TableValues;
};
type ImportSourceValue = z.infer<typeof importSnapshotSchema>['rows'][number][string];
type Converted = { value: TableValue } | { problem: ImportProblem['code']; expected?: string[] };

const sourceText = (value: NonNullable<ImportSourceValue>) => {
  if (value.kind === 'boolean') return String(value.value);
  if ('value' in value) return String(value.value);
  return null;
};
const problemValue = (value: ImportSourceValue) => {
  const text = value ? sourceText(value) : null;
  return text === null ? null : text.length > 40 ? `${text.slice(0, 39)}…` : text;
};
const optionKey = (label: string) => label.trim().toLocaleLowerCase('en-US');

function matchOption(field: Extract<TableField, { kind: 'single-select' | 'multi-select' }>, text: string) {
  const active = field.options.filter(option => !option.retired);
  const wanted = text.trim();
  const exact = active.filter(option => option.label.trim() === wanted);
  if (exact.length === 1) return exact[0]!.id;
  const loose = active.filter(option => optionKey(option.label) === optionKey(wanted));
  return loose.length === 1 ? loose[0]!.id : null;
}

/**
 * Converts one prepared file value to the destination field's kind. A file value is text unless its
 * column had a conversion, so a column mapped to a select field matches option labels here.
 */
export function convertImportValue(field: TableField, value: ImportSourceValue): Converted {
  if (value === null) return { value: null };
  if (value.kind === field.kind) return { value };
  const text = sourceText(value);
  if (text === null || field.kind === 'relationship' || field.kind === 'file') return { problem: 'type-mismatch' };
  if (field.kind === 'text') return { value: { kind: 'text', value: text } };
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  const options = 'options' in field ? field.options.filter(option => !option.retired).map(o => o.label) : [];
  if (field.kind === 'single-select') {
    const optionId = matchOption(field, trimmed);
    return optionId ? { value: { kind: 'single-select', optionId } } : { problem: 'unmapped-value', expected: options };
  }
  if (field.kind === 'multi-select') {
    const whole = matchOption(field, trimmed);
    const parts = whole
      ? [whole]
      : trimmed
          .split(/[,;]/)
          .map(part => part.trim())
          .filter(Boolean)
          .map(part => matchOption(field, part));
    if (parts.some(part => part === null)) return { problem: 'unmapped-value', expected: options };
    return { value: { kind: 'multi-select', optionIds: [...new Set(parts as NonNullable<typeof whole>[])] } };
  }
  const candidate =
    field.kind === 'boolean'
      ? /^(true|false)$/i.test(trimmed)
        ? { kind: 'boolean', value: trimmed.toLowerCase() === 'true' }
        : null
      : { kind: field.kind, value: trimmed };
  const parsed = candidate && valueSchema.safeParse(candidate);
  return parsed?.success ? { value: parsed.data } : { problem: 'conversion-failed' };
}

export function importEffects(
  plan: Extract<ProposalPlan, { kind: 'import' }>,
  definition: TableDefinition,
  records: { id: string; values: TableValues }[],
  rows: z.infer<typeof importSnapshotSchema>['rows'],
  identity: (index: number) => string,
  matches: ImportMatch[] = [],
) {
  const ids = [...plan.matchFieldIds].sort().map(id => fieldIdSchema.parse(id));
  const fields = new Map(definition.fields.map(field => [String(field.id), field]));
  const label = (id: string) => fields.get(id)?.label ?? null;
  const unique = definition.uniqueKeys.find(key => canonicalJson([...key.fieldIds].sort()) === canonicalJson(ids));
  if (!unique)
    throw new TableImportPlanError([
      {
        row: null,
        column: null,
        fieldId: null,
        field: ids
          .map(id => label(id) ?? id)
          .join(', ')
          .slice(0, 200),
        code: 'key-not-unique',
        value: null,
        expected: definition.uniqueKeys.slice(0, 20).map(key =>
          key.fieldIds
            .map(id => label(id) ?? id)
            .join(' + ')
            .slice(0, 200),
        ),
      },
    ]);
  const setup: ImportProblem[] = [];
  const columns = rows[0] ? Object.keys(rows[0]) : null;
  for (const mapping of plan.mappings) {
    if (columns && !columns.includes(mapping.sourceColumn))
      setup.push({
        row: null,
        column: mapping.sourceColumn.slice(0, 120),
        fieldId: mapping.fieldId,
        field: label(mapping.fieldId),
        code: 'unknown-column',
        value: null,
        expected: columns.slice(0, 20).map(column => column.slice(0, 200)),
      });
    if (!fields.has(mapping.fieldId))
      setup.push({
        row: null,
        column: mapping.sourceColumn.slice(0, 120),
        fieldId: mapping.fieldId.slice(0, 100),
        field: null,
        code: 'unknown-field',
        value: null,
        expected: definition.fields.slice(0, 20).map(field => field.label),
      });
  }
  for (const id of ids)
    if (!plan.mappings.some(mapping => mapping.fieldId === id))
      setup.push({ row: null, column: null, fieldId: id, field: label(id), code: 'key-unmapped', value: null });
  if (setup.length) throw new TableImportPlanError(setup);
  const normalized = (values: TableValues) =>
    ids.map(id => {
      const part = values[id];
      return part?.kind === 'numeric'
        ? {
            ...part,
            value: part.value
              .replace(/(\.\d*?)0+$/, '$1')
              .replace(/\.$/, '')
              .replace(/^-0$/, '0'),
          }
        : part;
    });
  const key = (values: TableValues) => canonicalJson(normalized(values));
  const problems: ImportProblem[] = [];
  let total = 0;
  const report = (problem: ImportProblem) => {
    total++;
    if (problems.length < 100) problems.push(problem);
  };
  const existing = new Map<string, (typeof records)[number]>();
  for (const row of records) {
    if (ids.some(id => row.values[id] === null || row.values[id] === undefined)) continue;
    const match = key(row.values);
    if (existing.has(match))
      report({
        row: null,
        column: null,
        fieldId: null,
        field: ids
          .map(id => label(id) ?? id)
          .join(', ')
          .slice(0, 200),
        code: 'existing-duplicate-key',
        value: null,
      });
    existing.set(match, row);
  }
  const columnOf = (fieldId: string) =>
    plan.mappings.find(mapping => mapping.fieldId === fieldId)?.sourceColumn ?? null;
  const seen = new Map<string, number>(),
    effects: TableEffect[] = [];
  for (const [index, row] of rows.entries()) {
    const at = (fieldId: string | null, code: ImportProblem['code'], value: ImportSourceValue, expected?: string[]) =>
      report({
        row: index + 1,
        column: fieldId ? (columnOf(fieldId)?.slice(0, 120) ?? null) : null,
        fieldId: fieldId?.slice(0, 100) ?? null,
        field: fieldId ? label(fieldId) : null,
        code,
        value: problemValue(value),
        ...(expected?.length ? { expected: expected.slice(0, 20).map(item => item.slice(0, 200)) } : {}),
      });
    const before = total;
    const converted: Record<string, TableValue> = {};
    for (const mapping of plan.mappings) {
      const field = fields.get(mapping.fieldId)!;
      const source = row[mapping.sourceColumn] ?? null;
      const result = convertImportValue(field, source);
      if ('problem' in result) at(field.id, result.problem, source, result.expected);
      else {
        try {
          converted[field.id] = validateValue(field, result.value);
        } catch (error) {
          if (!(error instanceof TableValidationError)) throw error;
          at(field.id, result.value === null ? 'missing-field' : 'invalid-output', source);
        }
      }
    }
    if (total > before) continue;
    const mapped = valuesSchema.parse(converted);
    if (ids.some(id => mapped[id] === null || mapped[id] === undefined)) {
      for (const id of ids) if (mapped[id] === null || mapped[id] === undefined) at(id, 'missing-key', null);
      continue;
    }
    const match = key(mapped);
    const first = seen.get(match);
    if (first !== undefined) {
      at(ids[0]!, 'duplicate-key', row[columnOf(ids[0]!) ?? ''] ?? null, [`data row ${first}`]);
      continue;
    }
    seen.set(match, index + 1);
    const current = existing.get(match);
    let after: TableValues;
    try {
      after = validateRecord(definition, { ...current?.values, ...mapped });
    } catch (error) {
      if (!(error instanceof TableValidationError)) throw error;
      const fieldId = error.fieldId && fields.has(error.fieldId) ? error.fieldId : null;
      at(fieldId, 'missing-field', null);
      continue;
    }
    if (total) continue;
    const recordId = current?.id ?? identity(index);
    const keyValue = unique.fieldIds.map(id => {
      const part = mapped[id];
      if (part?.kind === 'numeric')
        return part.value
          .replace(/(\.\d*?)0+$/, '$1')
          .replace(/\.$/, '')
          .replace(/^-0$/, '0');
      if (part && 'value' in part) return part.value;
      if (part?.kind === 'single-select') return part.optionId;
      if (part?.kind === 'relationship') return part.recordIds[0];
      throw new TableProposalError('invalid-import');
    });
    matches.push({ sourceIndex: index, recordId, matched: Boolean(current), keyId: unique.id, keyValue, mapped });
    const effect = changedEffect(recordId, current?.values ?? null, after, ids);
    if (effect) effects.push(effect);
  }
  if (total) throw new TableImportPlanError(problems, total);
  return effects;
}
