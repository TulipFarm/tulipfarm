import { randomUUID } from 'node:crypto';

/**
 * Models often wrap a tables.propose payload in a near miss of the strict contract: one plan without the plans
 * list, plans as an object or a JSON string, a long label, a null revises, a plan kind written as a verb, no
 * transforms on a schema plan, or made-up identifiers such as "status" for a new field. Each has one meaning, so
 * the payload is rewritten into the contract before it is validated. Valid payloads pass through unchanged.
 */

type Loose = Record<string, unknown>;
const object = (value: unknown): Loose | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const planKinds = new Set(['schema', 'records', 'import', 'archive', 'restore']);
const kindAliases: Record<string, string> = {
  table: 'schema',
  'create-table': 'schema',
  'new-table': 'schema',
  'update-table': 'schema',
  'alter-table': 'schema',
  alter: 'schema',
  'schema-change': 'schema',
  'add-field': 'schema',
  'add-fields': 'schema',
  record: 'records',
  rows: 'records',
  row: 'records',
  'add-rows': 'records',
  'insert-rows': 'records',
  'archive-table': 'archive',
  'restore-table': 'restore',
  'import-file': 'import',
  'file-import': 'import',
};

function parsed(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const words = (kind: string) =>
  kind
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

/**
 * The plan kind a model meant. An exact kind or alias wins; otherwise a kind naming an import, archive or restore,
 * then the plan's shape (a target with fields, record changes, a file reference), then any word naming rows or a
 * table's structure. A plan with none of these keeps its kind and is rejected.
 */
function planKind(plan: Loose) {
  const given = typeof plan.kind === 'string' ? words(plan.kind) : [];
  const kind = given.join('-');
  if (planKinds.has(kind)) return kind;
  if (kindAliases[kind]) return kindAliases[kind];
  if (given.includes('import')) return 'import';
  if (given.some(word => word === 'unarchive' || word === 'restore')) return 'restore';
  const rows = given.some(word => /^(rows?|records?)$/.test(word));
  if (
    !rows &&
    (given.includes('archive') || (given.some(word => /^(delete|remove|drop)$/.test(word)) && given.includes('table')))
  )
    return 'archive';
  if (object(parsed(plan.target)) && 'fields' in object(parsed(plan.target))!) return 'schema';
  if (['changes', 'records', 'rows'].some(key => plan[key] !== undefined)) return 'records';
  if (['reference', 'mappings', 'mapping', 'attachmentId', 'file'].some(key => plan[key] !== undefined))
    return 'import';
  if (given.some(word => /^(records?|rows?|insert|upsert|data|values?)$/.test(word))) return 'records';
  if (given.some(word => /^(schema|tables?|fields?|columns?|structure)$/.test(word))) return 'schema';
  return plan.kind;
}

function transforms(value: unknown) {
  const given = object(parsed(value));
  if (Array.isArray(parsed(value))) return { outputs: parsed(value) };
  if (!given) return { outputs: [] };
  const outputs = parsed(given.outputs);
  if (Array.isArray(outputs)) return { ...given, outputs };
  const map = object(outputs);
  return {
    ...given,
    outputs: map ? Object.entries(map).map(([fieldId, expression]) => ({ fieldId, expression })) : [],
  };
}

function plan(item: unknown): unknown {
  const value = object(parsed(item));
  if (!value) return item;
  const next: Loose = { ...value, kind: planKind(value) };
  if (next.dependsOn === undefined || next.dependsOn === null) next.dependsOn = [];
  if (next.kind === 'schema') {
    next.target = parsed(next.target);
    next.transforms = transforms(next.transforms);
    const target = object(next.target);
    if (next.tableId === undefined && typeof target?.id === 'string') next.tableId = target.id;
    if (target && target.id === undefined && typeof next.tableId === 'string')
      next.target = { ...target, id: next.tableId };
  }
  return next;
}

/** Keys whose string values are identities: `id`, `tableId`, `fieldIds`, `dependsOn` and similar. */
const identityKey = (key: string) => key === 'id' || key === 'dependsOn' || /Ids?$/.test(key);

export type ExistingTable = {
  id: string;
  revision: string;
  definition: {
    fields: {
      id: string;
      label: string;
      kind?: string;
      options?: { id: string; label: string; retired?: boolean }[];
    }[];
    uniqueKeys?: { id: string; fieldIds: string[] }[];
  };
};
export type FindTable = (hint: { id?: string; name?: string }) => Promise<ExistingTable | undefined>;
const sameLabel = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * New tables, fields, options and keys need UUIDs, and models often write names instead. A made-up identity in a
 * schema plan's target takes the identity of the existing field or option with the same label, or else one fresh
 * UUID, used everywhere that identity is referenced.
 */
async function freshIdentities(plans: unknown[], existing: FindTable) {
  const replaced = new Map<string, string>();
  const claim = (value: unknown, known?: string) => {
    if (typeof value === 'string' && value.trim() && !uuid.test(value) && !replaced.has(value))
      replaced.set(value, known ?? randomUUID());
  };
  for (const item of plans) {
    const plan = object(item);
    const target = object(plan?.target);
    if (plan?.kind !== 'schema' || !target) continue;
    const fields = (Array.isArray(target.fields) ? target.fields : []).map(object);
    const madeUp = fields.some(
      field =>
        (typeof field?.id === 'string' && !uuid.test(field.id)) ||
        (Array.isArray(field?.options) &&
          field.options.some(
            option => typeof object(option)?.id === 'string' && !uuid.test(object(option)!.id as string),
          )),
    );
    const current =
      madeUp && typeof plan.tableId === 'string' && uuid.test(plan.tableId) && plan.expectedRevision !== null
        ? await existing({ id: plan.tableId }).catch(() => undefined)
        : undefined;
    claim(plan.tableId);
    claim(target.id);
    for (const field of fields) {
      const match = current?.definition.fields.find(item => sameLabel(item.label, field?.label));
      claim(field?.id, match?.id);
      for (const option of Array.isArray(field?.options) ? (field.options as unknown[]) : [])
        claim(object(option)?.id, match?.options?.find(item => sameLabel(item.label, object(option)?.label))?.id);
    }
    for (const key of Array.isArray(target.uniqueKeys) ? target.uniqueKeys : []) claim(object(key)?.id);
  }
  if (!replaced.size) return plans;
  const rewrite = (value: unknown, identity: boolean, keys = false): unknown => {
    if (typeof value === 'string') return identity ? (replaced.get(value) ?? value) : value;
    if (Array.isArray(value)) return value.map(item => rewrite(item, identity));
    const entries = object(value);
    if (!entries) return value;
    return Object.fromEntries(
      Object.entries(entries).map(([key, item]) => [
        keys ? (replaced.get(key) ?? key) : key,
        rewrite(item, identityKey(key), key === 'values'),
      ]),
    );
  };
  return plans.map(item => rewrite(item, false));
}

const revisionPattern = /^[0-9a-f]{40}$/;
const changeKinds: Record<string, 'create' | 'update' | 'delete' | 'upsert'> = {
  create: 'create',
  insert: 'create',
  add: 'create',
  new: 'create',
  append: 'create',
  update: 'update',
  modify: 'update',
  edit: 'update',
  patch: 'update',
  set: 'update',
  change: 'update',
  upsert: 'upsert',
  delete: 'delete',
  remove: 'delete',
  destroy: 'delete',
};
const slug = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

type ExistingField = ExistingTable['definition']['fields'][number];

/** A plain value written for a field, such as "Open" for a select or 12 for a number, as the field's typed value. */
function typedValue(field: ExistingField | undefined, value: unknown): unknown {
  if (value === null || value === undefined || !field?.kind) return value ?? null;
  if (object(value) && typeof object(value)!.kind === 'string') return value;
  const option = (label: unknown) => {
    const active = (field.options ?? []).filter(item => !item.retired);
    return typeof label === 'string'
      ? (active.find(item => item.id === label) ?? active.find(item => sameLabel(item.label, label)))?.id
      : undefined;
  };
  switch (field.kind) {
    case 'text':
      return typeof value === 'object' ? value : { kind: 'text', value: String(value) };
    case 'numeric':
      return typeof value === 'number' || (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value))
        ? { kind: 'numeric', value: String(value).trim() }
        : value;
    case 'boolean':
      if (typeof value === 'boolean') return { kind: 'boolean', value };
      if (typeof value === 'string' && /^(true|yes)$/i.test(value.trim())) return { kind: 'boolean', value: true };
      if (typeof value === 'string' && /^(false|no)$/i.test(value.trim())) return { kind: 'boolean', value: false };
      return value;
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim())
        ? { kind: 'date', value: value.trim().slice(0, 10) }
        : value;
    case 'timestamp': {
      const time = typeof value === 'string' ? new Date(value) : undefined;
      return time && !Number.isNaN(time.getTime()) ? { kind: 'timestamp', value: time.toISOString() } : value;
    }
    case 'single-select': {
      const optionId = option(value);
      return optionId ? { kind: 'single-select', optionId } : value;
    }
    case 'multi-select': {
      const labels = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : [];
      const optionIds = labels.map(label => option(typeof label === 'string' ? label.trim() : label));
      return labels.length && optionIds.every(Boolean)
        ? { kind: 'multi-select', optionIds: [...new Set(optionIds)] }
        : value;
    }
    default:
      return value;
  }
}

function recordValues(value: unknown, table: ExistingTable | undefined) {
  const given = object(parsed(value));
  if (!given) return value;
  const fields = table?.definition.fields ?? [];
  return Object.fromEntries(
    Object.entries(given).map(([key, item]) => {
      const field =
        fields.find(candidate => candidate.id === key) ??
        fields.find(candidate => sameLabel(candidate.label, key)) ??
        fields.find(candidate => slug(candidate.label) === slug(key));
      return [field?.id ?? key, typedValue(field, item)];
    }),
  );
}

/** One record change in the contract's shape: a known kind, a recordId (fresh for a new row) and typed values. */
function recordChange(item: unknown, fallback: string | undefined, table: ExistingTable | undefined): unknown {
  const change = object(parsed(item));
  if (!change) return item;
  const recordId = [change.recordId, change.id, change.rowId, change.recordID, change.record_id].find(
    value => typeof value === 'string',
  ) as string | undefined;
  const known = recordId !== undefined && uuid.test(recordId);
  const control = ['kind', 'action', 'recordId', 'id', 'rowId', 'recordID', 'record_id'];
  // A change written as the row itself, such as {"Name": "Acme"}, carries its values at the top level.
  const flat = Object.fromEntries(Object.entries(change).filter(([key]) => !control.includes(key)));
  const rawValues =
    [change.values, change.fields, change.data, change.cells, change.row, change.record].find(
      value => value !== undefined,
    ) ?? (Object.keys(flat).length ? flat : undefined);
  let kind =
    typeof change.kind === 'string'
      ? changeKinds[words(change.kind)[0] ?? '']
      : typeof change.action === 'string'
        ? changeKinds[words(change.action)[0] ?? '']
        : (fallback as keyof typeof changeKinds | undefined);
  if (!kind && typeof change.kind !== 'string')
    kind = rawValues === undefined ? undefined : known ? 'update' : 'create';
  if (kind === 'upsert') kind = known ? 'update' : 'create';
  if (!kind) return item;
  if (kind === 'delete') return { kind, recordId };
  return {
    kind,
    recordId: kind === 'create' && !known ? randomUUID() : recordId,
    values: recordValues(rawValues ?? {}, table),
  };
}

/** Record changes given as one change, a JSON string, a map by kind, or rows under another name. */
function recordChanges(plan: Loose, table: ExistingTable | undefined) {
  const given = parsed(plan.changes ?? plan.records ?? plan.rows);
  const list: { item: unknown; kind?: string | undefined }[] = [];
  if (Array.isArray(given)) list.push(...given.map(item => ({ item })));
  else if (object(given)) {
    const map = object(given)!;
    const byKind = Object.keys(map).filter(key => changeKinds[key] && Array.isArray(parsed(map[key])));
    if (byKind.length)
      for (const key of byKind)
        for (const item of parsed(map[key]) as unknown[]) list.push({ item, kind: changeKinds[key] });
    else list.push({ item: map });
  } else return given;
  const fallback = plan.changes === undefined ? 'create' : undefined;
  return list.map(({ item, kind }) => recordChange(item, kind ?? fallback, table));
}

const planKeys: Record<string, string[]> = {
  schema: ['tableId', 'dependsOn', 'kind', 'expectedRevision', 'target', 'transforms'],
  records: ['tableId', 'dependsOn', 'kind', 'expectedRevision', 'changes'],
  archive: ['tableId', 'dependsOn', 'kind', 'expectedRevision'],
  restore: ['tableId', 'dependsOn', 'kind', 'expectedRevision'],
};

/**
 * Fills what an existing table settles in a records, archive or restore plan: the table named instead of its ID,
 * its current revision when none is given, record changes in the contract's shape, and keys the plan has no use
 * for. Import plans are repaired separately once the file's columns are known.
 */
async function existingTablePlans(plans: unknown[], find: FindTable) {
  const out = [];
  for (const item of plans) {
    const plan = object(item);
    const keys = typeof plan?.kind === 'string' ? planKeys[plan.kind] : undefined;
    if (!plan || !keys || plan.kind === 'schema') {
      out.push(item);
      continue;
    }
    const id = typeof plan.tableId === 'string' && uuid.test(plan.tableId) ? plan.tableId : undefined;
    const name = [plan.tableId, plan.tableName, plan.table, object(plan.table)?.name, object(plan.table)?.label].find(
      value => typeof value === 'string' && !uuid.test(value),
    ) as string | undefined;
    const table = await (id ? find({ id }) : name ? find({ name }) : Promise.resolve(undefined)).catch(() => undefined);
    const next: Loose = { ...plan };
    if (table) next.tableId = table.id;
    if (table && !(typeof next.expectedRevision === 'string' && revisionPattern.test(next.expectedRevision)))
      next.expectedRevision = table.revision;
    if (plan.kind === 'records') next.changes = recordChanges(plan, table);
    out.push(Object.fromEntries(Object.entries(next).filter(([key]) => keys.includes(key))));
  }
  return out;
}

/** Rewrites a loose tables.propose payload into the strict contract where its meaning is clear. */
export async function repairProposalShape(raw: unknown, existing: FindTable = async () => undefined): Promise<unknown> {
  const top = object(parsed(raw));
  if (!top) return raw;
  const out: Loose = { ...top };
  let plans = parsed(out.plans ?? out.plan);
  delete out.plan;
  if (plans === undefined && ['kind', 'target', 'changes'].some(key => key in top)) {
    const { label: _label, revises: _revises, ...single } = top;
    for (const key of Object.keys(single)) delete out[key];
    plans = [single];
  }
  if (object(plans)) plans = [plans];
  if (Array.isArray(plans))
    out.plans = await existingTablePlans(await freshIdentities(plans.map(plan), existing), existing);
  else if (plans !== undefined) out.plans = plans;
  if (typeof out.label === 'string') {
    const label = out.label.trim().slice(0, 40).trim();
    if (label) out.label = label;
    else delete out.label;
  } else if (out.label !== undefined) delete out.label;
  if (out.revises === null || out.revises === '') delete out.revises;
  return out;
}
