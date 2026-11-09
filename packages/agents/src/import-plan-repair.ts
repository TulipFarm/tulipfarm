/**
 * Models often send an import plan in a loose shape: a table name instead of its ID, field labels instead of field
 * IDs, a mapping mode instead of explicit mappings, or the file reference under another key. Each of these has one
 * unambiguous meaning once the table and the prepared file are known, so the plan is rewritten into the strict
 * contract instead of sending the model back to guess IDs.
 */

export type RepairField = { id: string; label: string };
export type RepairTable = {
  id: string;
  revision: string;
  definition: { label: string; fields: RepairField[]; uniqueKeys: { id: string; fieldIds: string[] }[] };
};
export type RepairReference =
  | { kind: 'file'; attachmentId: string; contentDigest: string }
  | { kind: 'integration'; resultId: string; contentDigest: string };
export type ImportPlanRepair = {
  /** The readable table with this ID or, case-insensitively, this label. */
  table: (hint: { id?: string; name?: string }) => Promise<RepairTable | undefined>;
  /** The column names of a file or result prepared in this chat. */
  columns: (reference: RepairReference) => Promise<string[] | undefined>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
const revision = /^[0-9a-f]{40}$/;

type Loose = Record<string, unknown>;
const object = (value: unknown): Loose | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : undefined;
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const first = (...values: unknown[]) => values.map(text).find(value => value !== undefined);
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

function isImportPlan(plan: Loose) {
  if (plan.kind !== undefined) return plan.kind === 'import';
  return ['reference', 'source', 'file', 'mappings', 'mapping', 'matchFieldIds', 'attachmentId'].some(
    key => key in plan,
  );
}

function tableHints(plan: Loose) {
  const table = object(plan.table) ?? object(plan.target);
  const hints: { id?: string; name?: string }[] = [];
  for (const value of [plan.tableId, table?.id, table?.tableId, plan.table, plan.target].map(text))
    if (value) hints.push(uuid.test(value) ? { id: value } : { name: value });
  for (const value of [plan.tableName, plan.tableLabel, table?.name, table?.label].map(text))
    if (value) hints.push({ name: value });
  return hints;
}

function reference(plan: Loose): RepairReference | undefined {
  for (const candidate of [plan.reference, plan.source, plan.file, plan.attachment, plan.snapshot, plan]) {
    const value = object(candidate);
    if (!value) continue;
    const contentDigest = first(value.contentDigest, value.digest, value.sha256);
    const resultId = first(value.resultId);
    const attachmentId = first(value.attachmentId, value === plan ? undefined : value.id);
    if (!contentDigest || !sha.test(contentDigest)) continue;
    if (resultId && uuid.test(resultId)) return { kind: 'integration', resultId, contentDigest };
    if (attachmentId && uuid.test(attachmentId)) return { kind: 'file', attachmentId, contentDigest };
  }
  return undefined;
}

function fieldResolver(table: RepairTable) {
  const fields = table.definition.fields;
  return (value: unknown): string | undefined => {
    const name = text(value);
    if (!name) return undefined;
    const exact = fields.find(field => field.id === name);
    if (exact) return exact.id;
    // Some models prefix a label with the table ID, such as "<tableId>-Order ID".
    const bare = name.startsWith(`${table.id}`) ? name.slice(table.id.length).replace(/^[^\p{L}\p{N}]+/u, '') : name;
    return fields.find(field => slug(field.label) === slug(bare))?.id;
  };
}

/** Flattens the loose ways a match key is written: an ID, a label, a list, or an object naming fields or a key. */
function matchValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(matchValues);
  const entry = object(value);
  if (!entry) return value === undefined ? [] : [value];
  return [entry.fieldIds, entry.fieldId, entry.fields, entry.field, entry.keyId, entry.id, entry.label, entry.name]
    .filter(item => item !== undefined)
    .flatMap(matchValues);
}

function matchFieldIds(plan: Loose, table: RepairTable) {
  const field = fieldResolver(table);
  const mapping = object(plan.mapping);
  const ids: string[] = [];
  for (const value of matchValues([
    plan.matchFieldIds,
    plan.matchFields,
    plan.matchField,
    plan.matchOn,
    plan.match,
    plan.matchKey,
    plan.uniqueKey,
    plan.key,
    mapping?.matchKey,
    mapping?.matchFieldIds,
    mapping?.match,
  ])) {
    const key = table.definition.uniqueKeys.find(item => item.id === value);
    for (const id of key ? key.fieldIds : [field(value)]) if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length) return ids;
  return table.definition.uniqueKeys.length === 1 ? [...table.definition.uniqueKeys[0]!.fieldIds] : [];
}

async function mappings(plan: Loose, table: RepairTable, columns: () => Promise<string[] | undefined>) {
  const field = fieldResolver(table);
  const pairs: { sourceColumn: string; fieldId: string }[] = [];
  const add = (column: unknown, target: unknown) => {
    const sourceColumn = text(column),
      fieldId = field(target) ?? field(column);
    if (sourceColumn && fieldId && !pairs.some(pair => pair.fieldId === fieldId || pair.sourceColumn === sourceColumn))
      pairs.push({ sourceColumn: sourceColumn.slice(0, 120), fieldId });
  };
  for (const candidate of [plan.mappings, plan.mapping, plan.columnMappings, plan.fieldMappings, plan.columns]) {
    if (Array.isArray(candidate))
      for (const item of candidate) {
        const entry = object(item);
        if (entry)
          add(
            first(entry.sourceColumn, entry.source, entry.column, entry.from, entry.header, entry.csvColumn),
            first(entry.fieldId, entry.field, entry.to, entry.target, entry.fieldLabel, entry.label),
          );
        else add(item, item);
      }
    const entries = object(candidate);
    if (entries && !Array.isArray(candidate)) {
      const nested = object(entries.columns) ?? object(entries.fields) ?? object(entries.map);
      for (const [column, target] of Object.entries(nested ?? entries))
        if (typeof target === 'string' && !['mode', 'kind', 'by', 'strategy', 'type'].includes(column))
          add(column, target);
    }
    if (pairs.length) return pairs;
  }
  // No explicit mapping, or only a mode such as “by name”: map each file column to the field with that name.
  for (const column of (await columns()) ?? []) add(column, column);
  return pairs;
}

export type RepairOutcome = {
  input: unknown;
  repaired: boolean;
  template?: Loose;
  fields?: Loose[];
  fileColumns?: string[];
};

/** Rewrites loose import plans in a tables.propose payload into the strict contract when their meaning is clear. */
export async function repairImportPlans(raw: unknown, repair: ImportPlanRepair): Promise<RepairOutcome> {
  const top = object(raw);
  if (!top) return { input: raw, repaired: false };
  const plans = Array.isArray(top.plans) ? top.plans : object(top.plan) ? [top.plan] : isImportPlan(top) ? [top] : [];
  if (!plans.some(plan => object(plan) && isImportPlan(object(plan)!))) return { input: raw, repaired: false };
  let label = text(top.label);
  let template: Loose | undefined, fields: Loose[] | undefined, fileColumns: string[] | undefined;
  const repaired = [];
  for (const item of plans) {
    const plan = object(item);
    if (!plan || !isImportPlan(plan)) {
      repaired.push(item);
      continue;
    }
    label ??= text(plan.label);
    let table: RepairTable | undefined;
    for (const hint of tableHints(plan)) if ((table = await repair.table(hint))) break;
    const source = reference(plan);
    if (!table) {
      repaired.push(item);
      continue;
    }
    let cached: Promise<string[] | undefined> | undefined;
    const columns = () =>
      (cached ??= source ? repair.columns(source).catch(() => undefined) : Promise.resolve(undefined));
    const given = first(
      plan.expectedRevision,
      plan.revision,
      plan.appliedRevision,
      object(plan.table)?.appliedRevision,
    );
    const next = {
      tableId: table.id,
      dependsOn: Array.isArray(plan.dependsOn) ? plan.dependsOn : [],
      kind: 'import',
      expectedRevision: given && revision.test(given) ? given : table.revision,
      reference: source ?? plan.reference,
      matchFieldIds: matchFieldIds(plan, table),
      mappings: await mappings(plan, table, columns),
    };
    repaired.push(next);
    template ??= {
      ...next,
      mappings: next.mappings.length ? next.mappings : [{ sourceColumn: '<file column>', fieldId: '<field id>' }],
      ...(next.matchFieldIds.length ? {} : { matchFieldIds: ['<field id of the unique key to match on>'] }),
      ...(source
        ? {}
        : { reference: { kind: 'file', attachmentId: '<attachmentId>', contentDigest: '<contentDigest>' } }),
    };
    fields ??= table.definition.fields.map(field => ({ id: field.id, label: field.label }));
    fileColumns ??= await columns();
  }
  return {
    input: {
      plans: repaired,
      ...(top.revises === undefined ? {} : { revises: top.revises }),
      ...(label ? { label: label.slice(0, 40) } : {}),
    },
    repaired: true,
    ...(template && fields ? { template, fields } : {}),
    ...(fileColumns ? { fileColumns } : {}),
  };
}
