import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { definitionSchema, tableIdSchema, type TableDefinition } from './definition.ts';
import { tableName, tableNameSchema, tableNamesSchema } from './names.ts';
import { TableProposalError } from './proposal-contracts.ts';
import { table } from './service-store.ts';

const identitySchema = z.object({
  table_id: tableIdSchema,
  name: tableNameSchema,
  title: definitionSchema.shape.label,
});

export async function tableIdentityStorageReady(tx: AuthorizationTransaction) {
  return Boolean(
    (await tx.client.query('SELECT to_regclass($1) AS relation', [table(tx, 'tf_table_names')])).rows[0]?.relation,
  );
}

export async function requireFixedTableTitle(
  tx: AuthorizationTransaction,
  definition: TableDefinition,
  before: TableDefinition | null = null,
) {
  if (!(await tableIdentityStorageReady(tx))) return;
  if (before && before.label !== definition.label) throw new TableProposalError('table-title-immutable');
  const row = identitySchema
    .optional()
    .parse(
      (
        await tx.client.query(`SELECT table_id,name,title FROM ${table(tx, 'tf_table_names')} WHERE table_id=$1`, [
          definition.id,
        ])
      ).rows[0],
    );
  if (row && row.title !== definition.label) throw new TableProposalError('table-title-immutable');
}

export async function reserveTableIdentities(
  tx: AuthorizationTransaction,
  inputs: readonly Pick<TableDefinition, 'id' | 'label'>[],
) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,761032))', [tx.schema]);
  const rows = z
    .array(identitySchema)
    .parse(
      (await tx.client.query(`SELECT table_id,name,title FROM ${table(tx, 'tf_table_names')} ORDER BY table_id`)).rows,
    );
  const identities = new Map(rows.map(row => [row.table_id, row]));
  const used = new Set(rows.map(row => row.name));
  const added: z.infer<typeof identitySchema>[] = [];
  for (const input of [...inputs].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = tableIdSchema.parse(input.id),
      title = definitionSchema.shape.label.parse(input.label);
    const existing = identities.get(id);
    if (existing) {
      if (existing.title !== title) throw new TableProposalError('table-title-immutable');
      continue;
    }
    let ordinal = 1,
      name = tableName(title);
    while (used.has(name)) name = tableName(title, ++ordinal);
    const identity = { table_id: id, name, title };
    used.add(name);
    identities.set(id, identity);
    added.push(identity);
  }
  if (added.length)
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_table_names')}(table_id,name,title) SELECT * FROM unnest($1::uuid[],$2::text[],$3::text[])`,
      [added.map(row => row.table_id), added.map(row => row.name), added.map(row => row.title)],
    );
  return identities;
}

export async function reserveDefinitionNames(tx: AuthorizationTransaction, definition: TableDefinition) {
  if (!(await tableIdentityStorageReady(tx))) return undefined;
  const ids = [
    definition.id,
    ...definition.fields.flatMap(field => (field.kind === 'relationship' ? [field.targetTableId] : [])),
  ];
  const related = z
    .array(z.object({ id: tableIdSchema, label: definitionSchema.shape.label }))
    .parse(
      (
        await tx.client.query(
          `SELECT id,display_name AS label FROM ${table(tx, 'tf_table_catalog')} WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [ids],
        )
      ).rows,
    );
  if (related.some(row => row.id === definition.id && row.label !== definition.label))
    throw new TableProposalError('table-title-immutable');
  const identities = await reserveTableIdentities(tx, [...related, definition]);
  return tableNamesSchema.parse(
    Object.fromEntries(
      [...new Set(ids)].sort().map(id => {
        const identity = identities.get(id);
        if (!identity) throw new TableProposalError('table-name-unavailable');
        return [id, identity.name];
      }),
    ),
  );
}
