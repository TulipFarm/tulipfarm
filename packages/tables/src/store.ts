import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { escapeIdentifier, escapeLiteral } from 'pg';
import { z } from 'zod';
import {
  lockAuthorization,
  requireTablePermission,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  definitionSchema,
  fieldIdSchema,
  recordIdSchema,
  tableIdSchema,
  revisionSchema,
  validateRecord,
  valueSchema,
  valuesSchema,
  type TableField,
  type TableValue,
  type TableValues,
} from './definition.ts';
import type { ProposalData } from './proposal-data.ts';
import { recordTableRecommendationChange } from './recommendations.ts';
import {
  addedMemberReferences,
  memberProfileSchema,
  requireWorkspaceMembersDefinition,
  workspaceMemberAccess,
  workspaceMemberFields,
  workspaceMemberRestoredValues,
  workspaceMembersRegistrationSchema,
  WorkspaceMemberError,
  type MemberProfile,
} from './workspace-members.ts';

export type GenerationTransaction = AuthorizationTransaction;
export const generationSchema = z.object({
  id: z.uuid(),
  table_id: tableIdSchema,
  revision: revisionSchema,
  definition: definitionSchema,
  physical_table: z.string().regex(/^[gr]_[a-f0-9]{32}$/),
  state: z.enum(['building', 'active', 'retired']),
});
export type Generation = z.infer<typeof generationSchema>;
export type LogicalRecord = { id: string; token: string; values: TableValues };
type GenerationErrorCode =
  | 'not-active'
  | 'not-found'
  | 'stale-record'
  | 'stale-generation'
  | 'duplicate-key'
  | 'linked-record'
  | 'invalid-generation'
  | 'reverse-conflict'
  | 'recovery-expired';
export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  constructor(code: GenerationErrorCode) {
    super(code);
    this.code = code;
  }
}
const table = (tx: GenerationTransaction, name: string) => qualified(tx.schema, name);
const column = (id: string) => escapeIdentifier(`f_${fieldIdSchema.parse(id).replaceAll('-', '')}`);
export { column as fieldColumn };
const idsSchema = z.array(z.uuid());

let lastHistoryOrder = 0n;
/**
 * A UUIDv7 whose millisecond time and 12-bit sequence never decrease within this process. One transaction, such as an
 * import page, gives all its history entries the same created_at, so the ID is what keeps them in write order.
 */
export function historyId() {
  const now = BigInt(Date.now()) << 12n;
  const order = (lastHistoryOrder = now > lastHistoryOrder ? now : lastHistoryOrder + 1n);
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Number(order >> 12n), 0, 6);
  bytes[6] = 0x70 | Number((order >> 8n) & 0x0fn);
  bytes[7] = Number(order & 0xffn);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function lockCatalogs(tx: GenerationTransaction, ids: string[], exclusive = false) {
  for (const id of [...new Set(ids.map(id => tableIdSchema.parse(id)))].sort()) {
    await tx.client.query(
      'SELECT pg_advisory_xact_lock' + (exclusive ? '' : '_shared') + '(hashtextextended($1, 7701))',
      [`${tx.schema}/${id}`],
    );
  }
}

export async function lockIdentities(tx: GenerationTransaction, identities: { tableId: string; recordId: string }[]) {
  const keys = identities.map(item => `${tableIdSchema.parse(item.tableId)}/${recordIdSchema.parse(item.recordId)}`);
  for (const key of [...new Set(keys)].sort())
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7702))', [`${tx.schema}/${key}`]);
}

export function currentGeneration(row: unknown): Generation {
  const generation = generationSchema.parse(row);
  const { owning_team_id } = z.object({ owning_team_id: definitionSchema.shape.owningTeamId }).parse(row);
  return { ...generation, definition: { ...generation.definition, owningTeamId: owning_team_id } };
}

export async function activeGeneration(tx: GenerationTransaction, tableId: string): Promise<Generation> {
  const row = (
    await tx.client.query(
      `SELECT g.*,c.owning_team_id FROM ${table(tx, 'tf_table_generations')} g JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=g.table_id WHERE g.table_id=$1 AND g.state='active' AND c.archived_at IS NULL`,
      [tableIdSchema.parse(tableId)],
    )
  ).rows[0];
  if (!row) throw new GenerationError('not-active');
  return currentGeneration(row);
}

export async function workspaceMembersTable(tx: GenerationTransaction) {
  const installed = (
    await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, 'tf_system_tables')])
  ).rows[0]?.installed;
  if (!installed) return null;
  const row = (
    await tx.client.query(
      `SELECT kind,core_definition AS "coreDefinition" FROM ${table(tx, 'tf_system_tables')} WHERE kind='workspace-members'`,
    )
  ).rows[0];
  if (!row) throw new WorkspaceMemberError('member-unavailable');
  return workspaceMembersRegistrationSchema.parse(row);
}

export async function requireMemberTableDefinition(tx: GenerationTransaction, definition: Generation['definition']) {
  const registration = await workspaceMembersTable(tx);
  if (registration?.coreDefinition.id !== definition.id) return;
  requireWorkspaceMembersDefinition(registration, definition);
  if (
    definition.fields.some(
      field => field.required && !registration.coreDefinition.fields.some(core => core.id === field.id),
    ) &&
    (
      await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_workspace_member_accounts')} a
      JOIN ${table(tx, 'tf_table_identities')} i ON i.table_id=a.table_id AND i.row_id=a.member_id
      JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.removed_at IS NULL
      WHERE NOT i.live LIMIT 1`)
    ).rowCount
  )
    throw new WorkspaceMemberError('member-profile-pending');
}

async function memberAccountLinked(tx: GenerationTransaction, memberId: string) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_workspace_member_accounts')} a
    JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
    WHERE a.member_id=$1`,
        [memberId],
      )
    ).rowCount,
  );
}

type Restoration = { historyId: string; version: 'before' | 'after' };

export async function requireMemberMutation(
  tx: GenerationTransaction,
  input: {
    tableId: string;
    recordId: string;
    before: TableValues | null;
    values: TableValues | null;
    restoration?: Restoration;
  },
) {
  const registration = await workspaceMembersTable(tx);
  if (!registration) return;
  const memberTableId = registration.coreDefinition.id;
  if (input.tableId === memberTableId) {
    const linked = await memberAccountLinked(tx, input.recordId);
    if (input.values === null) {
      const invited = (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_invitations')}
        WHERE workspace_member_id=$1 AND revoked_at IS NULL AND consumed_membership_id IS NULL
          AND expires_at>clock_timestamp() LIMIT 1`,
          [input.recordId],
        )
      ).rowCount;
      if (linked || invited) throw new WorkspaceMemberError('member-field-protected');
    } else {
      const fixed = [workspaceMemberFields.photo, workspaceMemberFields.accountEmail, workspaceMemberFields.access];
      if (linked) fixed.push(workspaceMemberFields.name);
      for (const id of fixed) {
        let expected =
          input.before?.[id] ??
          (id === workspaceMemberFields.access
            ? { kind: 'single-select', optionId: workspaceMemberAccess.none }
            : null);
        if (id === workspaceMemberFields.photo && !linked && input.restoration) {
          expected =
            (
              await recoverableHistory(
                tx,
                input.tableId,
                input.recordId,
                input.restoration.historyId,
                input.restoration.version,
              )
            )[id] ?? null;
        }
        if (JSON.stringify(input.values[id] ?? null) !== JSON.stringify(expected))
          throw new WorkspaceMemberError('member-field-protected');
      }
      const name = input.values[workspaceMemberFields.name];
      if (!linked && (name?.kind !== 'text' || !name.value.trim()))
        throw new WorkspaceMemberError('member-field-protected');
      const contactEmail = input.values[workspaceMemberFields.contactEmail];
      if (contactEmail?.kind === 'text') z.email().max(320).parse(contactEmail.value);
    }
  }
  const additions = addedMemberReferences(memberTableId, input.before, input.values);
  if (!additions.length) return;
  const generation = await activeGeneration(tx, memberTableId);
  const active = new Set(
    (
      await tx.client.query<{ id: string }>(
        `SELECT id FROM ${table(tx, generation.physical_table)}
    WHERE id=ANY($1::uuid[]) AND ${column(workspaceMemberFields.active)}=true`,
        [additions.map(item => item.memberId)],
      )
    ).rows.map(row => row.id),
  );
  if (additions.some(item => !active.has(item.memberId))) throw new WorkspaceMemberError('member-inactive');
}

function sqlType(field: TableField): string {
  switch (field.kind) {
    case 'text':
      return `varchar(${field.maxLength}) COLLATE "C"`;
    case 'numeric':
      return `numeric(${field.precision},${field.scale})`;
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
      return 'timestamptz(3)';
    case 'single-select':
      return 'uuid';
    case 'multi-select':
      return 'uuid[]';
    case 'relationship':
    case 'file':
      return field.cardinality === 'one' ? 'uuid' : 'uuid[]';
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function fieldSql(field: TableField) {
  const name = column(field.id);
  const checks: string[] = [];
  if (field.kind === 'single-select' || field.kind === 'multi-select') {
    const options = `ARRAY[${field.options
      .filter(option => !option.retired)
      .map(option => `${escapeLiteral(option.id)}::uuid`)
      .join(',')}]::uuid[]`;
    checks.push(field.kind === 'single-select' ? `${name}=ANY(${options})` : `${name}<@${options}`);
  }
  if (
    field.kind === 'multi-select' ||
    ((field.kind === 'relationship' || field.kind === 'file') && field.cardinality === 'many')
  ) {
    checks.push(`cardinality(${name})<=256`, `array_position(${name}, NULL) IS NULL`);
    if (field.required) checks.push(`cardinality(${name})>0`);
  }
  if (field.kind === 'date') checks.push(`${name} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'`);
  if (field.kind === 'timestamp')
    checks.push(`${name} BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'`);
  return `${name} ${sqlType(field)}${field.required ? ' NOT NULL' : ''}${checks.map(check => ` CHECK (${check})`).join('')}`;
}

// Maintenance credentials only. Approval and schema authority belong to the caller.
export async function createGeneration(
  tx: GenerationTransaction,
  input: { id?: string; definition: unknown; revision: string },
): Promise<Generation> {
  const definition = definitionSchema.parse(input.definition);
  const revision = revisionSchema.parse(input.revision);
  const id = z.uuid().parse(input.id ?? randomUUID());
  await lockCatalogs(tx, [definition.id], true);
  await requireMemberTableDefinition(tx, definition);
  const existing = (
    await tx.client.query(`SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND revision=$2`, [
      definition.id,
      revision,
    ])
  ).rows[0];
  if (existing) {
    const result = generationSchema.parse(existing);
    if (JSON.stringify(result.definition) !== JSON.stringify(definition))
      throw new GenerationError('invalid-generation');
    return result;
  }
  const physical = `g_${id.replaceAll('-', '')}`;
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
    [definition.id, definition.owningTeamId, physical, definition.label, revision],
  );
  const owner = (
    await tx.client.query(`SELECT owning_team_id FROM ${table(tx, 'tf_table_catalog')} WHERE id=$1`, [definition.id])
  ).rows[0]?.owning_team_id;
  if (owner !== definition.owningTeamId) throw new GenerationError('invalid-generation');
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_generations')} (id,table_id,revision,definition,physical_table) VALUES ($1,$2,$3,$4,$5)`,
    [id, definition.id, revision, JSON.stringify(definition), physical],
  );
  await tx.client.query(
    `CREATE TABLE ${table(tx, physical)} (id uuid PRIMARY KEY, token uuid NOT NULL${definition.fields.map(field => `, ${fieldSql(field)}`).join('')})`,
  );
  await tx.client.query(`REVOKE ALL ON ${table(tx, physical)} FROM ${escapeIdentifier(`${tx.schema}_runtime`)}`);
  return generationSchema.parse({
    id,
    table_id: definition.id,
    revision,
    definition,
    physical_table: physical,
    state: 'building',
  });
}

function storageValue(value: TableValue, field: TableField) {
  if (value === null) return null;
  if ('value' in value) return value.value;
  if (value.kind === 'single-select') return value.optionId;
  if (value.kind === 'multi-select') return [...value.optionIds].sort();
  const ids = value.kind === 'relationship' ? value.recordIds : value.fileIds;
  return 'cardinality' in field && field.cardinality === 'one' ? ids[0] : [...ids].sort();
}

function projection(tx: GenerationTransaction, generation: Generation) {
  return [
    'id',
    'token',
    ...generation.definition.fields.map(field => {
      const name = column(field.id);
      const expression =
        field.kind === 'numeric' || field.kind === 'date'
          ? `${name}::text`
          : field.kind === 'timestamp'
            ? `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
            : name;
      return `${expression} AS ${escapeIdentifier(field.id)}`;
    }),
  ].join(',');
}

function logicalRecord(generation: Generation, input: unknown): LogicalRecord {
  const row = z.record(z.string(), z.unknown()).parse(input);
  const values: TableValues = {};
  for (const field of generation.definition.fields) {
    const value = row[field.id];
    if (value === null) values[field.id] = null;
    else if (field.kind === 'single-select')
      values[field.id] = valueSchema.parse({ kind: field.kind, optionId: value });
    else if (field.kind === 'multi-select')
      values[field.id] = valueSchema.parse({ kind: field.kind, optionIds: value });
    else if (field.kind === 'relationship')
      values[field.id] = valueSchema.parse({
        kind: field.kind,
        tableId: field.targetTableId,
        recordIds: field.cardinality === 'one' ? [value] : value,
      });
    else if (field.kind === 'file')
      values[field.id] = valueSchema.parse({
        kind: field.kind,
        fileIds: field.cardinality === 'one' ? [value] : value,
      });
    else values[field.id] = valueSchema.parse({ kind: field.kind, value });
  }
  return { id: recordIdSchema.parse(row.id), token: z.uuid().parse(row.token), values };
}

export async function readRecord(
  tx: GenerationTransaction,
  generation: Generation,
  recordId: string,
): Promise<LogicalRecord | null> {
  const row = (
    await tx.client.query(
      `SELECT ${projection(tx, generation)} FROM ${table(tx, generation.physical_table)} WHERE id=$1`,
      [recordIdSchema.parse(recordId)],
    )
  ).rows[0];
  return row ? logicalRecord(generation, row) : null;
}

export async function readRecords(
  tx: GenerationTransaction,
  generation: Generation,
  input: { after?: string | null; ids?: string[]; limit?: number } = {},
): Promise<LogicalRecord[]> {
  const limit = z
    .int()
    .min(1)
    .max(1000)
    .parse(input.limit ?? 100);
  const after = input.after ? recordIdSchema.parse(input.after) : null;
  const ids = input.ids ? idsSchema.parse(input.ids) : null;
  const rows = await tx.client.query(
    `SELECT ${projection(tx, generation)} FROM ${table(tx, generation.physical_table)} WHERE ($1::uuid IS NULL OR id>$1) AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY id LIMIT $3`,
    [after, ids, limit],
  );
  return rows.rows.map(row => logicalRecord(generation, row));
}

const normalizedNumericValue = (value: string) =>
  value
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
    .replace(/^-0$/, '0');

function equalValues(before: TableValue | null | undefined, values: TableValue | null | undefined) {
  if (before?.kind === 'numeric' && values?.kind === 'numeric')
    return normalizedNumericValue(before.value) === normalizedNumericValue(values.value);
  return JSON.stringify(before ?? null) === JSON.stringify(values ?? null);
}

function uniqueValues(generation: Generation, values: TableValues) {
  return generation.definition.uniqueKeys.flatMap(key => {
    const parts = key.fieldIds.map(id => values[id]);
    if (parts.some(part => part === null || part === undefined)) return [];
    const value = parts.map(part => {
      if (part?.kind === 'numeric') return normalizedNumericValue(part.value);
      if (part && 'value' in part) return part.value;
      if (part?.kind === 'single-select') return part.optionId;
      if (part?.kind === 'relationship') return part.recordIds[0];
      throw new GenerationError('invalid-generation');
    });
    const serialized = JSON.stringify(value);
    return [{ keyId: key.id, value: serialized, digest: createHash('sha256').update(serialized).digest('hex') }];
  });
}

export async function lockUniqueValues(
  tx: GenerationTransaction,
  generation: Generation,
  values: (TableValues | null)[],
) {
  const keys = values.flatMap(value =>
    value ? uniqueValues(generation, value).map(key => `${generation.id}/${key.keyId}/${key.digest}`) : [],
  );
  for (const key of [...new Set(keys)].sort())
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7703))', [`${tx.schema}/${key}`]);
}

async function replaceUniqueValues(
  tx: GenerationTransaction,
  generation: Generation,
  recordId: string,
  values: TableValues | null,
) {
  const relation = table(tx, 'tf_table_unique_values');
  const previous = z
    .array(z.object({ key_id: z.uuid(), digest: z.string() }))
    .parse(
      (
        await tx.client.query(`DELETE FROM ${relation} WHERE generation_id=$1 AND row_id=$2 RETURNING key_id,digest`, [
          generation.id,
          recordId,
        ])
      ).rows,
    );
  const keys = values ? uniqueValues(generation, values) : [];
  for (const key of keys) {
    if (generation.state !== 'building') {
      const duplicate = await tx.client.query(
        `SELECT 1 FROM ${relation} WHERE generation_id=$1 AND key_id=$2 AND digest=$3 AND value=$4::jsonb AND row_id<>$5 LIMIT 1`,
        [generation.id, key.keyId, key.digest, key.value, recordId],
      );
      if (duplicate.rowCount) throw new GenerationError('duplicate-key');
    }
    await tx.client.query(`INSERT INTO ${relation}(generation_id,key_id,row_id,digest,value) VALUES($1,$2,$3,$4,$5)`, [
      generation.id,
      key.keyId,
      recordId,
      key.digest,
      key.value,
    ]);
  }
  if (generation.state === 'building')
    for (const key of [...previous, ...keys.map(key => ({ key_id: key.keyId, digest: key.digest }))]) {
      const conflict =
        (
          await tx.client.query(
            `SELECT 1 FROM ${relation} WHERE generation_id=$1 AND key_id=$2 AND digest=$3 LIMIT 2`,
            [generation.id, key.key_id, key.digest],
          )
        ).rows.length > 1;
      if (conflict)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_table_generation_conflicts')}(generation_id,key_id,digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [generation.id, key.key_id, key.digest],
        );
      else
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_table_generation_conflicts')} WHERE generation_id=$1 AND key_id=$2 AND digest=$3`,
          [generation.id, key.key_id, key.digest],
        );
    }
}

export async function requireUniqueGeneration(tx: GenerationTransaction, generation: Generation) {
  if (
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_table_generation_conflicts')} WHERE generation_id=$1 LIMIT 1`,
        [generation.id],
      )
    ).rowCount
  )
    throw new GenerationError('duplicate-key');
}

export async function matchUniqueRecord(
  tx: GenerationTransaction,
  generation: Generation,
  fieldIds: string[],
  values: TableValues,
) {
  const definition = generation.definition.uniqueKeys.find(
    key => [...key.fieldIds].sort().join() === [...fieldIds].sort().join(),
  );
  const key = uniqueValues(generation, values).find(key => key.keyId === definition?.id);
  if (!key) throw new GenerationError('invalid-generation');
  const matches = z
    .array(z.object({ row_id: z.uuid() }))
    .parse(
      (
        await tx.client.query(
          `SELECT row_id FROM ${table(tx, 'tf_table_unique_values')} WHERE generation_id=$1 AND key_id=$2 AND digest=$3 AND value=$4::jsonb LIMIT 2`,
          [generation.id, key.keyId, key.digest, key.value],
        )
      ).rows,
    );
  if (matches.length > 1) throw new GenerationError('duplicate-key');
  return matches[0]?.row_id ?? null;
}

async function writePhysicalRecordUnchecked(
  tx: GenerationTransaction,
  generation: Generation,
  record: LogicalRecord | { id: string; values: null },
) {
  await replaceUniqueValues(tx, generation, record.id, record.values);
  if (record.values === null) {
    await tx.client.query(`DELETE FROM ${table(tx, generation.physical_table)} WHERE id=$1`, [record.id]);
    return;
  }
  const fields = generation.definition.fields;
  const columns = ['id', 'token', ...fields.map(field => column(field.id))];
  const parameters = [
    record.id,
    record.token,
    ...fields.map(field => storageValue(record.values[field.id] ?? null, field)),
  ];
  await tx.client.query(
    `INSERT INTO ${table(tx, generation.physical_table)} (${columns.join(',')}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns
      .slice(1)
      .map(name => `${name}=EXCLUDED.${name}`)
      .join(',')}`,
    parameters,
  );
}

export async function writePhysicalRecord(
  tx: GenerationTransaction,
  generation: Generation,
  record: LogicalRecord | { id: string; values: null },
) {
  const active = (
    await tx.client.query(
      `SELECT g.*,c.owning_team_id FROM ${table(tx, 'tf_table_generations')} g
    JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=g.table_id WHERE g.table_id=$1 AND g.state='active'`,
      [generation.table_id],
    )
  ).rows[0];
  const before = active ? await readRecord(tx, currentGeneration(active), record.id) : null;
  const related = endpoints(generation.table_id, record.id, before?.values ?? null, record.values);
  await lockCatalogs(
    tx,
    related.map(item => item.tableId),
  );
  await lockIdentities(tx, related);
  await requireMemberMutation(tx, {
    tableId: generation.table_id,
    recordId: record.id,
    before: before?.values ?? null,
    values: record.values,
  });
  await writePhysicalRecordUnchecked(tx, generation, record);
}

export function endpoints(tableId: string, recordId: string, ...snapshots: (TableValues | null)[]) {
  return [
    { tableId, recordId },
    ...snapshots.flatMap(values =>
      Object.values(values ?? {}).flatMap(value =>
        value?.kind === 'relationship' ? value.recordIds.map(recordId => ({ tableId: value.tableId, recordId })) : [],
      ),
    ),
  ];
}

export async function replaceLinks(
  tx: GenerationTransaction,
  generation: Generation,
  recordId: string,
  values: TableValues | null,
) {
  const relation = table(tx, 'tf_table_generation_links');
  await tx.client.query(`DELETE FROM ${relation} WHERE generation_id=$1 AND source_row=$2`, [generation.id, recordId]);
  for (const field of generation.definition.fields) {
    const value = values?.[field.id];
    if (field.kind !== 'relationship' || value?.kind !== 'relationship') continue;
    for (const target of value.recordIds) {
      await tx.client.query(
        `INSERT INTO ${relation}(source_table,source_row,field_id,target_table,target_row,inverse_one,generation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          generation.table_id,
          recordId,
          field.id,
          field.targetTableId,
          target,
          field.inverseCardinality === 'one',
          generation.id,
        ],
      );
    }
  }
}

export async function identity(tx: GenerationTransaction, tableId: string, recordId: string) {
  return z
    .object({ token: z.uuid(), live: z.boolean() })
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT token,live FROM ${table(tx, 'tf_table_identities')} WHERE table_id=$1 AND row_id=$2`,
          [tableId, recordId],
        )
      ).rows[0] ?? null,
    );
}

export async function prepareRecordDeletion(tx: GenerationTransaction, tableId: string, recordId: string) {
  if (
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_table_generation_links')} l JOIN ${table(tx, 'tf_table_generations')} g ON g.id=l.generation_id WHERE l.target_table=$1 AND l.target_row=$2 AND (g.state='active' OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_executions')} e WHERE e.target_generation=g.id AND e.phase IN ('copying','reconciling') AND COALESCE((SELECT c.operation FROM ${table(tx, 'tf_table_proposal_controls')} c WHERE c.proposal_id=e.proposal_id ORDER BY c.sequence DESC LIMIT 1),'resume')<>'cancel')) AND NOT(l.source_table=$1 AND l.source_row=$2) LIMIT 1`,
        [tableId, recordId],
      )
    ).rowCount
  )
    throw new GenerationError('linked-record');
  // Snapshots retain relationship values; inactive indexes must not keep live-identity FKs.
  await tx.client.query(
    `DELETE FROM ${table(tx, 'tf_table_generation_links')} WHERE source_table=$1 AND source_row=$2`,
    [tableId, recordId],
  );
  await tx.client.query(
    `DELETE FROM ${table(tx, 'tf_table_generation_links')} WHERE target_table=$1 AND target_row=$2`,
    [tableId, recordId],
  );
}

type MutationInput = {
  generation: Generation;
  recordId: string;
  values: TableValues | null;
  before: TableValues | null;
  actor: unknown;
  operation: 'create' | 'update' | 'delete' | 'restore';
  writtenFieldIds?: string[];
  imported?: boolean;
  restoration?: Restoration;
};

export async function persistMutation(tx: GenerationTransaction, input: MutationInput) {
  await requireMemberMutation(tx, {
    tableId: input.generation.table_id,
    recordId: input.recordId,
    before: input.before,
    values: input.values,
    ...(input.operation === 'restore' && input.restoration ? { restoration: input.restoration } : {}),
  });
  return persistMutationUnchecked(tx, input);
}

async function persistMutationUnchecked(tx: GenerationTransaction, input: MutationInput) {
  const { generation, recordId, values } = input;
  const cardinalityChanged = (input.before === null) !== (values === null);
  const wasEmpty =
    cardinalityChanged &&
    !input.imported &&
    !(await tx.client.query(`SELECT 1 FROM ${table(tx, generation.physical_table)} LIMIT 1`)).rowCount;
  if (values === null) await prepareRecordDeletion(tx, generation.table_id, recordId);
  const token = randomUUID();
  const written =
    input.operation === 'update' && input.writtenFieldIds
      ? input.writtenFieldIds
      : generation.definition.fields.map(field => field.id);
  const versions = Object.fromEntries(written.map(id => [fieldIdSchema.parse(id), token]));
  // Fold the active generation's staged versions into the first subsequent write.
  // Later writes use the identity row because its token no longer matches base_token.
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_identities')} AS i(table_id,row_id,token,live,incarnation,field_versions) VALUES($1,$2,$3,$4,$3,$5) ON CONFLICT(table_id,row_id) DO UPDATE SET token=EXCLUDED.token,live=EXCLUDED.live,incarnation=CASE WHEN i.live AND EXCLUDED.live THEN i.incarnation ELSE EXCLUDED.incarnation END,field_versions=COALESCE((SELECT v.field_versions FROM ${table(tx, 'tf_table_generation_versions')} v WHERE v.generation_id=$6 AND v.row_id=i.row_id AND v.base_token=i.token),i.field_versions) || EXCLUDED.field_versions,updated_at=clock_timestamp()`,
    [generation.table_id, recordId, token, values !== null, versions, generation.id],
  );
  await writePhysicalRecordUnchecked(
    tx,
    generation,
    values === null ? { id: recordId, values: null } : { id: recordId, token, values },
  );
  if (values !== null) await replaceLinks(tx, generation, recordId, values);
  const fields = [...new Set([...Object.keys(input.before ?? {}), ...Object.keys(values ?? {})])].filter(
    id =>
      input.before === null ||
      values === null ||
      !equalValues(input.before[fieldIdSchema.parse(id)], values[fieldIdSchema.parse(id)]),
  );
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_row_history_data')}(id,table_id,row_id,generation_id,token,actor,operation,field_ids,values,before_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      historyId(),
      generation.table_id,
      recordId,
      generation.id,
      token,
      JSON.stringify(input.actor),
      input.operation,
      fields,
      JSON.stringify(values ?? input.before),
      input.before === null ? null : JSON.stringify(input.before),
    ],
  );
  if (
    cardinalityChanged &&
    !input.imported &&
    (wasEmpty || !(await tx.client.query(`SELECT 1 FROM ${table(tx, generation.physical_table)} LIMIT 1`)).rowCount)
  ) {
    await recordTableRecommendationChange(tx, generation.table_id, 'rows');
  }
  return { id: recordId, token, values };
}

async function storeMemberImage(
  tx: GenerationTransaction & { workspaceId: string },
  tableId: string,
  memberId: string,
  image: string | null,
): Promise<TableValue> {
  if (image === null) return null;
  const digest = createHash('sha256').update(image).digest('hex');
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_workspace_member_images')}(member_id,table_id,digest,image)
    VALUES($1,$2,$3,$4) ON CONFLICT(member_id,digest) DO NOTHING`,
    [memberId, tableId, digest, image],
  );
  return {
    kind: 'text',
    value: `/v1/workspaces/${z.uuid().parse(tx.workspaceId)}/workspace-members/${memberId}/photos/${digest}`,
  };
}

export async function updateWorkspaceMemberPhoto(
  tx: GenerationTransaction & { workspaceId: string },
  actor: HumanActor,
  input: {
    tableId: string;
    recordId: string;
    revision: string;
    expectedToken: string;
    image: string | null;
  },
) {
  await lockAuthorization(tx);
  await requireTablePermission(tx, actor, input.tableId, 'table.row.read');
  await requireTablePermission(tx, actor, input.tableId, 'table.row.update');
  const registration = await workspaceMembersTable(tx);
  if (registration?.coreDefinition.id !== input.tableId) throw new WorkspaceMemberError('member-table-protected');
  if (input.image !== null) {
    const image = memberProfileSchema.shape.image.unwrap().parse(input.image);
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) throw new WorkspaceMemberError('member-field-protected');
    const bytes = Buffer.from(match[2]!, 'base64');
    const signature =
      match[1] === 'png'
        ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : match[1] === 'jpeg'
          ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signature || bytes.length > 32768 || bytes.toString('base64') !== match[2])
      throw new WorkspaceMemberError('member-field-protected');
  }
  await lockCatalogs(tx, [input.tableId]);
  const generation = await activeGeneration(tx, input.tableId);
  if (generation.revision !== input.revision) throw new GenerationError('stale-generation');
  await lockIdentities(tx, [{ tableId: input.tableId, recordId: input.recordId }]);
  const before = await readRecord(tx, generation, input.recordId);
  if (!before) throw new GenerationError('not-found');
  if (before.token !== input.expectedToken) throw new GenerationError('stale-record');
  if (
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_workspace_member_accounts')} a
    JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
    WHERE a.member_id=$1`,
        [input.recordId],
      )
    ).rowCount
  )
    throw new WorkspaceMemberError('member-field-protected');
  for (const target of new Set(endpoints(input.tableId, input.recordId, before.values).map(item => item.tableId))) {
    await requireTablePermission(tx, actor, target, 'table.row.read');
  }
  const values = {
    ...before.values,
    [workspaceMemberFields.photo]: await storeMemberImage(tx, input.tableId, input.recordId, input.image),
  };
  return persistMutationUnchecked(tx, {
    generation,
    recordId: input.recordId,
    before: before.values,
    values,
    actor,
    operation: 'update',
    writtenFieldIds: [workspaceMemberFields.photo],
  });
}

export async function projectWorkspaceMemberProfile(
  tx: GenerationTransaction & { workspaceId: string },
  input: {
    memberId: string;
    membershipId: string;
    profile: MemberProfile;
  },
): Promise<'applied' | 'unchanged' | 'stale' | 'detached'> {
  const profile = memberProfileSchema.parse(input.profile);
  const memberId = recordIdSchema.parse(input.memberId);
  const membershipId = z.uuid().parse(input.membershipId);
  await lockAuthorization(tx);
  const registration = await workspaceMembersTable(tx);
  if (!registration) throw new WorkspaceMemberError('member-unavailable');
  const tableId = registration.coreDefinition.id;
  await lockCatalogs(tx, [tableId]);
  const link = z
    .object({ profile_revision: z.string(), requested_revision: z.string(), profile_status: z.string() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT a.profile_revision::text,a.requested_revision::text,a.profile_status FROM ${table(tx, 'tf_workspace_member_accounts')} a
      JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
      WHERE a.member_id=$1 AND a.membership_id=$2 AND a.user_id=$3 FOR UPDATE OF a`,
          [memberId, membershipId, profile.id],
        )
      ).rows[0],
    );
  if (!link) return 'detached';
  if (
    BigInt(link.profile_revision) > BigInt(profile.revision) ||
    BigInt(link.requested_revision) > BigInt(profile.revision)
  )
    return 'stale';
  if (link.profile_revision === profile.revision && link.profile_status === 'current') {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_workspace_member_accounts')}
      SET next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE member_id=$1`,
      [memberId],
    );
    return 'unchanged';
  }
  await lockIdentities(tx, [{ tableId, recordId: memberId }]);
  const generation = await activeGeneration(tx, tableId);
  const before = await readRecord(tx, generation, memberId);
  const image = await storeMemberImage(tx, tableId, memberId, profile.image);
  const values = validateRecord(generation.definition, {
    [workspaceMemberFields.contactEmail]: { kind: 'text', value: profile.email },
    [workspaceMemberFields.active]: { kind: 'boolean', value: true },
    ...before?.values,
    [workspaceMemberFields.name]: { kind: 'text', value: profile.name },
    [workspaceMemberFields.photo]: image,
    [workspaceMemberFields.accountEmail]: { kind: 'text', value: profile.email },
    [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.active },
  });
  const written = Object.keys(values).filter(
    id => !equalValues(before?.values[fieldIdSchema.parse(id)], values[fieldIdSchema.parse(id)]),
  );
  if (written.length)
    await persistMutationUnchecked(tx, {
      generation,
      recordId: memberId,
      before: before?.values ?? null,
      values,
      actor: { kind: 'system', operation: 'workspace-member-profile', membershipId, revision: profile.revision },
      operation: before ? 'update' : 'create',
      writtenFieldIds: written,
    });
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_workspace_member_accounts')}
    SET profile_revision=$2,profile_status='current',profile_error=NULL,projected_at=clock_timestamp(),
      next_attempt_at=clock_timestamp()+interval '5 minutes'
    WHERE member_id=$1`,
    [memberId, profile.revision],
  );
  return written.length ? 'applied' : 'unchanged';
}

export async function refreshWorkspaceMemberAccess(
  tx: GenerationTransaction,
  memberIdInput: string,
): Promise<'applied' | 'unchanged' | 'not-materialized'> {
  const memberId = recordIdSchema.parse(memberIdInput);
  await lockAuthorization(tx);
  const registration = await workspaceMembersTable(tx);
  if (!registration) throw new WorkspaceMemberError('member-unavailable');
  const tableId = registration.coreDefinition.id;
  await lockCatalogs(tx, [tableId]);
  await lockIdentities(tx, [{ tableId, recordId: memberId }]);
  const generation = await activeGeneration(tx, tableId);
  const before = await readRecord(tx, generation, memberId);
  if (!before) return 'not-materialized';
  const active = Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_workspace_member_accounts')} a
    JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
    WHERE a.member_id=$1`,
        [memberId],
      )
    ).rowCount,
  );
  const invited =
    !active &&
    Boolean(
      (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_invitations')}
    WHERE workspace_member_id=$1 AND revoked_at IS NULL AND consumed_membership_id IS NULL
      AND expires_at>clock_timestamp() LIMIT 1`,
          [memberId],
        )
      ).rowCount,
    );
  const values = validateRecord(generation.definition, {
    ...before.values,
    [workspaceMemberFields.accountEmail]: active ? before.values[workspaceMemberFields.accountEmail] : null,
    [workspaceMemberFields.access]: {
      kind: 'single-select',
      optionId: active
        ? workspaceMemberAccess.active
        : invited
          ? workspaceMemberAccess.invited
          : workspaceMemberAccess.none,
    },
  });
  const written = [workspaceMemberFields.accountEmail, workspaceMemberFields.access].filter(
    id => !equalValues(before.values[id], values[id]),
  );
  if (!written.length) return 'unchanged';
  await persistMutationUnchecked(tx, {
    generation,
    recordId: memberId,
    before: before.values,
    values,
    actor: { kind: 'system', operation: 'workspace-member-access' },
    operation: 'update',
    writtenFieldIds: written,
  });
  return 'applied';
}

// The online executor supplies already transformed values and the source identity token.
export async function writeGenerationRecord(
  tx: GenerationTransaction,
  input: { generationId: string; recordId: string; token: string; values: unknown },
) {
  const generation = generationSchema.parse(
    (
      await tx.client.query(`SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE id=$1`, [
        z.uuid().parse(input.generationId),
      ])
    ).rows[0],
  );
  await lockCatalogs(tx, [generation.table_id]);
  const state = (
    await tx.client.query(`SELECT state FROM ${table(tx, 'tf_table_generations')} WHERE id=$1`, [generation.id])
  ).rows[0]?.state;
  if (state !== 'building') throw new GenerationError('invalid-generation');
  const recordId = recordIdSchema.parse(input.recordId);
  const values = input.values === null ? null : validateRecord(generation.definition, input.values);
  const before = await readRecord(tx, generation, recordId);
  await lockUniqueValues(tx, generation, [before?.values ?? null, values]);
  await lockIdentities(tx, [{ tableId: generation.table_id, recordId }]);
  const current = await identity(tx, generation.table_id, recordId);
  if (!current || current.token !== input.token || current.live !== (values !== null))
    throw new GenerationError('stale-record');
  await writePhysicalRecord(
    tx,
    generation,
    values === null ? { id: recordId, values: null } : { id: recordId, token: z.uuid().parse(input.token), values },
  );
  await replaceLinks(tx, generation, recordId, values);
}

export async function stageTransformHistory(
  tx: GenerationTransaction,
  input: {
    generation: Generation;
    recordId: string;
    token: string;
    before: TableValues;
    values: TableValues;
    actor: unknown;
  },
) {
  const fields = [...new Set([...Object.keys(input.before), ...Object.keys(input.values)])].filter(
    id =>
      JSON.stringify(input.before[fieldIdSchema.parse(id)]) !== JSON.stringify(input.values[fieldIdSchema.parse(id)]),
  );
  if (!fields.length) {
    await tx.client.query(
      `DELETE FROM ${table(tx, 'tf_table_row_history_data')} WHERE generation_id=$1 AND row_id=$2 AND operation='transform'`,
      [input.generation.id, input.recordId],
    );
    return;
  }
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_row_history_data')}(id,table_id,row_id,generation_id,token,actor,operation,field_ids,values,before_values) VALUES($1,$2,$3,$4,$5,$6,'transform',$7,$8,$9) ON CONFLICT(generation_id,row_id) WHERE operation='transform' DO UPDATE SET token=EXCLUDED.token,field_ids=EXCLUDED.field_ids,values=EXCLUDED.values,before_values=EXCLUDED.before_values`,
    [
      randomUUID(),
      input.generation.table_id,
      input.recordId,
      input.generation.id,
      input.token,
      JSON.stringify(input.actor),
      fields,
      JSON.stringify(input.values),
      JSON.stringify(input.before),
    ],
  );
}

export async function activateReverseFields(tx: GenerationTransaction, generation: Generation) {
  const reverses = table(tx, 'tf_table_reverse_fields');
  await tx.client.query(`DELETE FROM ${reverses} WHERE source_table=$1`, [generation.table_id]);
  for (const field of generation.definition.fields) {
    if (
      (
        await tx.client.query(`SELECT 1 FROM ${reverses} WHERE target_table=$1 AND field_id=$2`, [
          generation.table_id,
          field.id,
        ])
      ).rowCount
    )
      throw new GenerationError('reverse-conflict');
    if (field.kind !== 'relationship') continue;
    const target =
      field.targetTableId === generation.table_id ? generation : await activeGeneration(tx, field.targetTableId);
    if (!field.reverse) continue;
    if (target.definition.fields.some(candidate => candidate.id === field.reverse?.fieldId))
      throw new GenerationError('reverse-conflict');
    await tx.client.query(
      `INSERT INTO ${reverses}(target_table,field_id,source_table,source_field,label,cardinality) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        field.targetTableId,
        field.reverse.fieldId,
        generation.table_id,
        field.id,
        field.reverse.label,
        field.inverseCardinality,
      ],
    );
  }
}

export async function activateGeneration(
  tx: GenerationTransaction,
  input: { generationId: string; expectedActiveGenerationId: string | null },
) {
  const generation = generationSchema.parse(
    (
      await tx.client.query(`SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE id=$1`, [
        z.uuid().parse(input.generationId),
      ])
    ).rows[0],
  );
  const prior = generationSchema
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
          [generation.table_id],
        )
      ).rows[0] ?? null,
    );
  const related = [
    generation.table_id,
    ...[...generation.definition.fields, ...(prior?.definition.fields ?? [])].flatMap(field =>
      field.kind === 'relationship' ? [field.targetTableId] : [],
    ),
  ];
  await lockCatalogs(tx, related, true);
  const active =
    (
      await tx.client.query(
        `SELECT id FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
        [generation.table_id],
      )
    ).rows[0]?.id ?? null;
  if (active === generation.id) return { ...generation, state: 'active' as const };
  if (active !== input.expectedActiveGenerationId || active !== (prior?.id ?? null) || generation.state !== 'building')
    throw new GenerationError('stale-generation');
  await requireUniqueGeneration(tx, generation);
  const mismatch = await tx.client.query(
    `SELECT 1 FROM ${table(tx, generation.physical_table)} g FULL JOIN (SELECT row_id,token FROM ${table(tx, 'tf_table_identities')} WHERE table_id=$1 AND live) i ON i.row_id=g.id WHERE g.id IS NULL OR i.row_id IS NULL OR g.token<>i.token LIMIT 1`,
    [generation.table_id],
  );
  if (mismatch.rowCount) throw new GenerationError('stale-record');
  const reverses = table(tx, 'tf_table_reverse_fields');
  await tx.client.query(`DELETE FROM ${reverses} WHERE source_table=$1`, [generation.table_id]);
  for (const field of generation.definition.fields) {
    if (
      (
        await tx.client.query(`SELECT 1 FROM ${reverses} WHERE target_table=$1 AND field_id=$2`, [
          generation.table_id,
          field.id,
        ])
      ).rowCount
    )
      throw new GenerationError('reverse-conflict');
    if (field.kind !== 'relationship' || !field.reverse) continue;
    const target =
      field.targetTableId === generation.table_id ? generation : await activeGeneration(tx, field.targetTableId);
    if (target.definition.fields.some(candidate => candidate.id === field.reverse?.fieldId))
      throw new GenerationError('reverse-conflict');
    await tx.client.query(
      `INSERT INTO ${reverses}(target_table,field_id,source_table,source_field,label,cardinality) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        field.targetTableId,
        field.reverse.fieldId,
        generation.table_id,
        field.id,
        field.reverse.label,
        field.inverseCardinality,
      ],
    );
  }
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_table_generation_links')} WHERE generation_id=$1`, [
    generation.id,
  ]);
  for (const field of generation.definition.fields) {
    if (field.kind !== 'relationship') continue;
    const expression = field.cardinality === 'one' ? `ARRAY[${column(field.id)}]` : column(field.id);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_table_generation_links')}(source_table,source_row,field_id,target_table,target_row,inverse_one,generation_id) SELECT $1,g.id,$2,$3,target,$4,$5 FROM ${table(tx, generation.physical_table)} g CROSS JOIN LATERAL unnest(${expression}) target WHERE target IS NOT NULL`,
      [generation.table_id, field.id, field.targetTableId, field.inverseCardinality === 'one', generation.id],
    );
  }
  if (prior) {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_table_generations')} SET state='retired',retired_at=clock_timestamp() WHERE id=$1`,
      [prior.id],
    );
    await tx.client.query(
      `REVOKE INSERT,UPDATE,DELETE ON ${table(tx, prior.physical_table)} FROM ${escapeIdentifier(`${tx.schema}_runtime`)}`,
    );
  }
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_table_generations')} SET state='active',activated_at=clock_timestamp() WHERE id=$1`,
    [generation.id],
  );
  await tx.client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(tx, generation.physical_table)} TO ${escapeIdentifier(`${tx.schema}_runtime`)}`,
  );
  await recordTableRecommendationChange(tx, generation.table_id, 'definition', prior !== null);
  return { ...generation, state: 'active' as const };
}

export async function recoverableHistory(
  tx: GenerationTransaction,
  tableId: string,
  recordId: string,
  historyId: string,
  version: 'before' | 'after' = 'after',
) {
  const column = version === 'before' ? 'before_values' : 'values';
  const row = (
    await tx.client.query(
      `SELECT ${column} AS values FROM ${table(tx, 'tf_table_row_history')} WHERE id=$1 AND table_id=$2 AND row_id=$3 AND recoverable_until>clock_timestamp() AND ${column} IS NOT NULL`,
      [z.uuid().parse(historyId), tableId, recordId],
    )
  ).rows[0];
  if (!row) throw new GenerationError('recovery-expired');
  return valuesSchema.parse(row.values);
}

export async function restorableHistory(
  tx: GenerationTransaction,
  tableId: string,
  recordId: string,
  restoration: Restoration,
  current: TableValues | null,
) {
  const historical = await recoverableHistory(tx, tableId, recordId, restoration.historyId, restoration.version);
  const registration = await workspaceMembersTable(tx);
  if (registration?.coreDefinition.id !== tableId) return historical;
  const linked = await memberAccountLinked(tx, recordId);
  if (linked && !current) throw new WorkspaceMemberError('member-profile-pending');
  return workspaceMemberRestoredValues(historical, current, linked);
}

export async function pruneHistoryValues(tx: GenerationTransaction, limit = 1000) {
  const result = await tx.client.query(
    `WITH expired AS (SELECT h.id FROM ${table(tx, 'tf_table_row_history_data')} h JOIN ${table(tx, 'tf_table_generations')} g ON g.id=h.generation_id WHERE (CASE WHEN h.operation='transform' THEN g.activated_at+interval '30 days' ELSE h.recoverable_until END)<=clock_timestamp() AND (h.values IS NOT NULL OR h.before_values IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_history_holds')} p WHERE p.history_id=h.id) ORDER BY h.id LIMIT $1 FOR UPDATE OF h SKIP LOCKED) UPDATE ${table(tx, 'tf_table_row_history_data')} h SET values=NULL,before_values=NULL FROM expired WHERE h.id=expired.id`,
    [z.int().min(1).max(1000).parse(limit)],
  );
  return result.rowCount ?? 0;
}

export const generationProposalData: ProposalData = {
  async lock(tx, tableIds, mode) {
    if (mode !== 'scan') await lockCatalogs(tx, tableIds, true);
    return 'capture';
  },
  async definition(tx, tableId: string) {
    const row = (
      await tx.client.query(
        `SELECT g.*,c.owning_team_id FROM ${table(tx, 'tf_table_generations')} g JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=g.table_id WHERE g.table_id=$1 AND g.state='active'`,
        [tableIdSchema.parse(tableId)],
      )
    ).rows[0];
    if (!row) return null;
    const generation = currentGeneration(row);
    return { revision: generation.revision, definition: generation.definition };
  },
  async records(tx, tableId: string, after: string | null, ids?: string[]) {
    const generation = await activeGeneration(tx, tableId);
    const records = await readRecords(tx, generation, { after, ...(ids ? { ids } : {}), limit: 1000 });
    const versions = z
      .array(z.object({ row_id: z.uuid(), incarnation: z.uuid(), field_versions: z.record(z.string(), z.uuid()) }))
      .parse(
        (
          await tx.client.query(
            `SELECT i.row_id,i.incarnation,COALESCE(v.field_versions,i.field_versions) AS field_versions FROM ${table(tx, 'tf_table_identities')} i LEFT JOIN ${table(tx, 'tf_table_generation_versions')} v ON v.generation_id=$3 AND v.row_id=i.row_id AND v.base_token=i.token WHERE i.table_id=$1 AND i.row_id=ANY($2::uuid[]) AND i.live`,
            [tableId, records.map(row => row.id), generation.id],
          )
        ).rows,
      );
    const byId = new Map(versions.map(row => [row.row_id, row]));
    return records.map(row => {
      const version = byId.get(row.id);
      if (!version) throw new GenerationError('stale-record');
      return { ...row, incarnation: version.incarnation, fieldVersions: version.field_versions };
    });
  },
};
