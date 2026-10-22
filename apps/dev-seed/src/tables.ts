import { Client } from 'pg';
import { z } from 'zod';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceNames } from '@tulipfarm/workspace-storage/runtime';
import { commonCompatibility } from '@tulipfarm/workspaces/storage';
import { activateGeneration, createGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import type { SeedContext } from './context.ts';
import { recordEntity, type ManifestUser, type ManifestWorkspace } from './manifest.ts';
import { cities, companies, firstNames, lastNames, stableId, stableRevision, type Random } from './random.ts';
import { workspaceUrl } from './workspace.ts';

type Field =
  | { id: string; label: string; required: boolean; kind: 'text'; maxLength: number }
  | { id: string; label: string; required: boolean; kind: 'numeric'; precision: number; scale: number }
  | { id: string; label: string; required: boolean; kind: 'boolean' | 'date' }
  | { id: string; label: string; required: boolean; kind: 'timestamp'; timezone: 'UTC' }
  | {
      id: string;
      label: string;
      required: boolean;
      kind: 'single-select' | 'multi-select';
      options: { id: string; label: string; retired: boolean }[];
    }
  | {
      id: string;
      label: string;
      required: boolean;
      kind: 'relationship';
      targetTableId: string;
      cardinality: 'one';
      inverseCardinality: 'many';
      reverse: null;
      onDelete: 'restrict';
    };
type Value =
  | { kind: 'text'; value: string }
  | { kind: 'numeric'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'timestamp'; value: string }
  | { kind: 'single-select'; optionId: string }
  | { kind: 'multi-select'; optionIds: string[] }
  | { kind: 'relationship'; tableId: string; recordIds: string[] };
/** Tables a template links to, by their seeded ids in the same workspace. */
type Links = { contacts: string };
type Template = {
  label: string;
  linksContacts?: true;
  fields: (tableId: string, links: Links) => Field[];
  row: (fields: Field[], random: Random, index: number, links: Links) => Record<string, Value>;
};
const linkedContacts = 10;

const text = (tableId: string, label: string, required = false): Field => ({
  id: stableId(tableId, label),
  label,
  required,
  kind: 'text',
  maxLength: 10000,
});
const options = (tableId: string, label: string, labels: string[]) =>
  labels.map(option => ({ id: stableId(tableId, label, option), label: option, retired: false }));
const choose = (field: Field, random: Random): Value => {
  if (field.kind !== 'single-select') throw new Error('Expected single-select');
  return { kind: 'single-select', optionId: random.pick(field.options).id };
};
const day = (random: Random) =>
  new Date(Date.UTC(2026, random.int(0, 11), random.int(1, 28))).toISOString().slice(0, 10);
const money = (random: Random, max: number) => `${random.int(10, max)}.${String(random.int(0, 99)).padStart(2, '0')}`;
const person = (random: Random) => `${random.pick(firstNames)} ${random.pick(lastNames)}`;
const links = (workspaceId: string): Links => ({ contacts: stableId('table', workspaceId, 'Contacts') });

export const tableTemplates: Record<string, Template> = {
  contacts: {
    label: 'Contacts',
    fields: id => [
      text(id, 'Name', true),
      text(id, 'Email'),
      text(id, 'Company'),
      {
        id: stableId(id, 'Stage'),
        label: 'Stage',
        required: false,
        kind: 'single-select',
        options: options(id, 'Stage', ['Lead', 'Qualified', 'Customer', 'Churned']),
      },
      {
        id: stableId(id, 'Lifetime value'),
        label: 'Lifetime value',
        required: false,
        kind: 'numeric',
        precision: 12,
        scale: 2,
      },
      { id: stableId(id, 'Active'), label: 'Active', required: false, kind: 'boolean' },
      { id: stableId(id, 'Last contacted'), label: 'Last contacted', required: false, kind: 'date' },
      {
        id: stableId(id, 'Tags'),
        label: 'Tags',
        required: false,
        kind: 'multi-select',
        options: options(id, 'Tags', ['VIP', 'Wholesale', 'Newsletter', 'Referral']),
      },
    ],
    row: (fields, random) => {
      const [name, email, company, stage, value, active, contacted, tags] = fields as [
        Field,
        Field,
        Field,
        Field,
        Field,
        Field,
        Field,
        Field,
      ];
      const full = person(random);
      const tagOptions =
        tags.kind === 'multi-select' ? tags.options.filter(() => random.chance(0.3)).map(option => option.id) : [];
      return {
        [name.id]: { kind: 'text', value: full },
        [email.id]: { kind: 'text', value: `${full.toLowerCase().replace(' ', '.')}@example.com` },
        [company.id]: { kind: 'text', value: random.pick(companies) },
        [stage.id]: choose(stage, random),
        [value.id]: { kind: 'numeric', value: money(random, 50000) },
        [active.id]: { kind: 'boolean', value: random.chance(0.7) },
        [contacted.id]: { kind: 'date', value: day(random) },
        ...(tagOptions.length ? { [tags.id]: { kind: 'multi-select', optionIds: tagOptions } } : {}),
      };
    },
  },
  orders: {
    label: 'Orders',
    fields: id => [
      text(id, 'Order number', true),
      text(id, 'Customer'),
      { id: stableId(id, 'Amount'), label: 'Amount', required: false, kind: 'numeric', precision: 12, scale: 2 },
      {
        id: stableId(id, 'Status'),
        label: 'Status',
        required: false,
        kind: 'single-select',
        options: options(id, 'Status', ['Pending', 'Shipped', 'Delivered', 'Cancelled']),
      },
      { id: stableId(id, 'Placed at'), label: 'Placed at', required: false, kind: 'timestamp', timezone: 'UTC' },
      text(id, 'Ship to'),
    ],
    row: (fields, random, index) => {
      const [number, customer, amount, status, placed, city] = fields as [Field, Field, Field, Field, Field, Field];
      return {
        [number.id]: { kind: 'text', value: `SO-${String(1000 + index).padStart(5, '0')}` },
        [customer.id]: { kind: 'text', value: random.pick(companies) },
        [amount.id]: { kind: 'numeric', value: money(random, 5000) },
        [status.id]: choose(status, random),
        [placed.id]: {
          kind: 'timestamp',
          value: `${day(random)}T${String(random.int(8, 18)).padStart(2, '0')}:${String(random.int(0, 59)).padStart(2, '0')}:00.000Z`,
        },
        [city.id]: { kind: 'text', value: random.pick(cities) },
      };
    },
  },
  inventory: {
    label: 'Inventory',
    fields: id => [
      text(id, 'SKU', true),
      text(id, 'Item'),
      { id: stableId(id, 'Quantity'), label: 'Quantity', required: false, kind: 'numeric', precision: 10, scale: 0 },
      { id: stableId(id, 'Reorder'), label: 'Reorder', required: false, kind: 'boolean' },
      {
        id: stableId(id, 'Category'),
        label: 'Category',
        required: false,
        kind: 'single-select',
        options: options(id, 'Category', ['Bulbs', 'Tools', 'Soil', 'Packaging']),
      },
    ],
    row: (fields, random, index) => {
      const [sku, item, quantity, reorder, category] = fields as [Field, Field, Field, Field, Field];
      const count = random.int(0, 400);
      return {
        [sku.id]: { kind: 'text', value: `TF-${String(index + 1).padStart(4, '0')}` },
        [item.id]: {
          kind: 'text',
          value: `${random.pick(['Red', 'Yellow', 'Striped', 'Double', 'Parrot'])} ${random.pick(['tulip', 'trowel', 'planter', 'crate', 'mulch'])}`,
        },
        [quantity.id]: { kind: 'numeric', value: String(count) },
        [reorder.id]: { kind: 'boolean', value: count < 40 },
        [category.id]: choose(category, random),
      };
    },
  },
  tickets: {
    label: 'Tickets',
    linksContacts: true,
    fields: (id, linked) => [
      text(id, 'Title', true),
      {
        id: stableId(id, 'Status'),
        label: 'Status',
        required: false,
        kind: 'single-select',
        options: options(id, 'Status', ['Open', 'In progress', 'Waiting', 'Resolved']),
      },
      {
        id: stableId(id, 'Priority'),
        label: 'Priority',
        required: false,
        kind: 'single-select',
        options: options(id, 'Priority', ['Low', 'Normal', 'High', 'Urgent']),
      },
      {
        id: stableId(id, 'Customer'),
        label: 'Customer',
        required: false,
        kind: 'relationship',
        targetTableId: linked.contacts,
        cardinality: 'one',
        inverseCardinality: 'many',
        reverse: null,
        onDelete: 'restrict',
      },
      {
        id: stableId(id, 'Tags'),
        label: 'Tags',
        required: false,
        kind: 'multi-select',
        options: options(id, 'Tags', ['Billing', 'Login', 'Bug', 'Feature request', 'Outage']),
      },
      { id: stableId(id, 'Points'), label: 'Points', required: false, kind: 'numeric', precision: 4, scale: 0 },
      { id: stableId(id, 'Due date'), label: 'Due date', required: false, kind: 'date' },
      { id: stableId(id, 'Escalated'), label: 'Escalated', required: false, kind: 'boolean' },
    ],
    row: (fields, random, _index, linked) => {
      const [title, status, priority, customer, tags, points, due, escalated] = fields as [
        Field,
        Field,
        Field,
        Field,
        Field,
        Field,
        Field,
        Field,
      ];
      const tagOptions =
        tags.kind === 'multi-select' ? tags.options.filter(() => random.chance(0.3)).map(option => option.id) : [];
      return {
        [title.id]: {
          kind: 'text',
          value: `${random.pick(['Cannot', 'Unable to', 'Error when trying to', 'Slow to'])} ${random.pick(['log in', 'export invoices', 'reset password', 'sync orders', 'upload files', 'change plan'])}`,
        },
        [status.id]: choose(status, random),
        [priority.id]: choose(priority, random),
        ...(random.chance(0.85)
          ? {
              [customer.id]: {
                kind: 'relationship',
                tableId: linked.contacts,
                recordIds: [stableId('row', linked.contacts, random.int(0, linkedContacts - 1))],
              },
            }
          : {}),
        ...(tagOptions.length ? { [tags.id]: { kind: 'multi-select', optionIds: tagOptions } } : {}),
        [points.id]: { kind: 'numeric', value: String(random.pick([1, 2, 3, 5, 8, 13])) },
        ...(random.chance(0.8) ? { [due.id]: { kind: 'date', value: day(random) } } : {}),
        [escalated.id]: { kind: 'boolean', value: random.chance(0.2) },
      };
    },
  },
};

const catalogRow = z.object({
  id: z.uuid(),
  applied_revision: z.string().nullable(),
  applied_definition: z.object({ fields: z.array(z.unknown()) }).nullable(),
});

async function readCatalog(context: SeedContext, workspaceId: string, tableId: string) {
  return context.runtime.transaction(workspaceId, commonCompatibility, async ({ client, schema }) =>
    catalogRow
      .optional()
      .parse(
        (
          await client.query(
            `SELECT id, applied_revision, applied_definition FROM "${schema}".tf_table_catalog WHERE id = $1`,
            [tableId],
          )
        ).rows[0],
      ),
  );
}

// Mirrors packages/tables/test/fixture.mjs: an activated generation is what an approved table proposal leaves behind.
export async function ensureTable(
  context: SeedContext,
  workspace: ManifestWorkspace,
  owner: ManifestUser,
  input: { template: string; teamId: string; label?: string; rows: number },
) {
  const template = tableTemplates[input.template];
  if (!template)
    throw new Error(`Unknown table template ${input.template}; choose ${Object.keys(tableTemplates).join(', ')}`);
  const label = input.label ?? template.label;
  const tableId = stableId('table', workspace.id, label);
  // Linked tickets point at the first Contacts rows, so those rows must exist before tickets are written.
  if (template.linksContacts)
    await ensureTable(context, workspace, owner, {
      template: 'contacts',
      teamId: input.teamId,
      rows: Math.max(linkedContacts, 20),
    });
  const fields = template.fields(tableId, links(workspace.id));
  const revision = stableRevision('table', tableId, 1);
  const prior = await readCatalog(context, workspace.id, tableId);
  if (!prior?.applied_revision) {
    const names = workspaceNames(workspace.id);
    const definition = { formatVersion: 2, id: tableId, owningTeamId: input.teamId, label, fields, uniqueKeys: [] };
    const credential = await context.migrationCredential(workspace.id);
    const client = new Client({ connectionString: credential.connectionString });
    await client.connect();
    try {
      await inTransaction(client, async tx => {
        await tx.query(`SET LOCAL ROLE "${names.customOwner}"`);
        const created = await createGeneration({ client: tx, schema: names.schema }, { definition, revision });
        await activateGeneration(
          { client: tx, schema: names.schema },
          { generationId: created.id, expectedActiveGenerationId: null },
        );
        await tx.query(
          `UPDATE "${names.schema}".tf_table_catalog SET applied_revision=$2, target_revision=$2, applied_definition=$3, physical_table=$4 WHERE id=$1`,
          [tableId, revision, definition, created.physical_table],
        );
      });
    } finally {
      await client.end();
    }
    context.log(`Created table ${label} in ${workspace.slug}`);
  }
  recordEntity(workspace, 'tables', { id: tableId, label, url: workspaceUrl(workspace.slug, `tables/${tableId}`) });
  const added = prior?.applied_revision
    ? 0
    : await addRows(context, workspace, owner, { tableId, rows: input.rows, template: input.template, offset: 0 });
  return { tableId, revision, fields, added };
}

export async function addRows(
  context: SeedContext,
  workspace: ManifestWorkspace,
  owner: ManifestUser,
  input: { tableId: string; template: string; rows: number; offset?: number },
) {
  const template = tableTemplates[input.template];
  if (!template) throw new Error(`Unknown table template ${input.template}`);
  const catalog = await readCatalog(context, workspace.id, input.tableId);
  if (!catalog?.applied_revision) throw new Error(`Table ${input.tableId} is not active in ${workspace.slug}`);
  const linked = links(workspace.id);
  const fields = template.fields(input.tableId, linked);
  const service = createTableService(
    context.runtime,
    { readableFiles: async () => new Set<string>() },
    commonCompatibility,
  );
  const offset = input.offset ?? context.random.int(10000, 99999);
  for (let index = 0; index < input.rows; index++) {
    await service.mutate(workspace.id, owner.id, {
      kind: 'create',
      tableId: input.tableId,
      revision: catalog.applied_revision,
      recordId: stableId('row', input.tableId, offset + index),
      values: template.row(fields, context.random, offset + index, linked),
    });
    if (index && index % 250 === 0) context.log(`  ${index}/${input.rows} rows`);
  }
  return input.rows;
}
