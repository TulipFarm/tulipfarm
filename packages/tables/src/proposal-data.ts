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
  valuesSchema,
  validateRecord,
  type TableDefinition,
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
  TableProposalError,
  TableProposalValidationError,
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
  const workflows = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision WHERE w.enabled AND r.definition::text LIKE '%' || $1 || '%' LIMIT 1`,
    [id],
  );
  if (workflows.rowCount) return 'workflow-active';
  const schedules = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_agent_schedules')} WHERE revoked_at IS NULL AND paused_at IS NULL AND (scope::text LIKE '%' || $1 || '%' OR call::text LIKE '%' || $1 || '%') LIMIT 1`,
    [id],
  );
  return schedules.rowCount ? 'agent-schedule-active' : null;
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
  const result = evaluateTransforms({ transforms: plan.transforms, values: row.values, target: plan.target });
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
export function importEffects(
  plan: Extract<ProposalPlan, { kind: 'import' }>,
  definition: TableDefinition,
  records: { id: string; values: TableValues }[],
  rows: z.infer<typeof importSnapshotSchema>['rows'],
  identity: (index: number) => string,
  matches: ImportMatch[] = [],
) {
  const ids = [...plan.matchFieldIds].sort().map(id => fieldIdSchema.parse(id));
  const key = (values: TableValues) => {
    const parts = ids.map(id => values[id]);
    if (parts.some(part => part === null || part === undefined)) throw new TableProposalError('invalid-import');
    return canonicalJson(
      parts.map(part =>
        part?.kind === 'numeric'
          ? {
              ...part,
              value: part.value
                .replace(/(\.\d*?)0+$/, '$1')
                .replace(/\.$/, '')
                .replace(/^-0$/, '0'),
            }
          : part,
      ),
    );
  };
  const existing = new Map<string, (typeof records)[number]>();
  for (const row of records) {
    if (ids.some(id => row.values[id] === null)) continue;
    const match = key(row.values);
    if (existing.has(match)) throw new TableProposalError('invalid-import');
    existing.set(match, row);
  }
  const seen = new Set<string>(),
    effects: TableEffect[] = [];
  for (const [index, row] of rows.entries()) {
    const mapped = valuesSchema.parse(
      Object.fromEntries(
        plan.mappings.map(mapping => {
          if (!Object.hasOwn(row, mapping.sourceColumn)) throw new TableProposalError('invalid-import');
          return [mapping.fieldId, row[mapping.sourceColumn]];
        }),
      ),
    );
    const match = key(mapped);
    if (seen.has(match)) throw new TableProposalError('invalid-import');
    seen.add(match);
    const current = existing.get(match);
    const unique = definition.uniqueKeys.find(key => canonicalJson([...key.fieldIds].sort()) === canonicalJson(ids));
    if (!unique) throw new TableProposalError('invalid-import');
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
    const after = validateRecord(definition, { ...current?.values, ...mapped });
    const effect = changedEffect(recordId, current?.values ?? null, after, ids);
    if (effect) effects.push(effect);
  }
  return effects;
}
