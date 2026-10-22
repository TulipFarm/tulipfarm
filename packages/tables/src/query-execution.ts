import { createHash } from 'node:crypto';
import { z } from 'zod';
import { escapeLiteral } from 'pg';
import { queryHumanContext, requireTablePermission, type Actor } from '@tulipfarm/access';
import type { TableTransaction } from './service-store.ts';
import { table } from './service-store.ts';
import { recordIdSchema, TableValidationError, type TableField } from './definition.ts';
import {
  scalarQueryKinds,
  TableQueryError,
  type QueryNode,
  type TableQuery,
  type TableRowsQuery,
  type TableSummaryQuery,
} from './query.ts';
import { WorkspaceMemberError } from './workspace-members.ts';
import * as store from './store.ts';

/** Stops counting at this many and reports `"10000+"`, matching listPage. */
export const queryCountLimit = 10000;
/** Interactive bounds. Exceeding them is an error, never a partial or sampled result. */
export const queryStatementTimeout = '2s';
export const queryLockTimeout = '250ms';

const columnOf = (id: string) => `"f_${id.replaceAll('-', '')}"`;
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;
const casts: Partial<Record<TableField['kind'], string>> = {
  text: 'text',
  numeric: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
  'single-select': 'uuid',
};
const collection = (field: TableField) =>
  field.kind === 'multi-select' ||
  ((field.kind === 'relationship' || field.kind === 'file') && field.cardinality === 'many');

/** Text form of a value that PostgreSQL parses back to the same value, with timestamps in ISO UTC. */
function textOf(field: TableField, expression: string) {
  return field.kind === 'timestamp'
    ? `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `(${expression})::text`;
}

/** Single-choice fields order by the author's option order, not by label or ID. */
function orderExpression(field: TableField) {
  const column = columnOf(field.id);
  if (field.kind !== 'single-select')
    return { sql: column, cast: casts[field.kind] ?? 'text', key: textOf(field, column) };
  const options = field.options.map(option => `${escapeLiteral(option.id)}::uuid`).join(',');
  const sql = `array_position(ARRAY[${options}]::uuid[],${column})`;
  return { sql, cast: 'int', key: `(${sql})::text` };
}

export function compileWhere(fields: readonly TableField[], where: QueryNode | null, parameters: unknown[]): string {
  if (!where) return 'TRUE';
  if (where.kind !== 'rule') {
    const parts = where.nodes.map(node => compileWhere(fields, node, parameters));
    return parts.length ? `(${parts.join(where.kind === 'all' ? ' AND ' : ' OR ')})` : 'TRUE';
  }
  if (where.op === 'is-me') throw new TableValidationError('Current member must be resolved before SQL compilation');
  const field = fields.find(item => item.id === where.fieldId);
  if (!field) throw new TableValidationError('Unknown filter field');
  const column = columnOf(field.id);
  const bind = (value: unknown) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  if (collection(field)) {
    switch (where.op) {
      case 'empty':
        return `COALESCE(cardinality(${column}),0)=0`;
      case 'not-empty':
        return `COALESCE(cardinality(${column}),0)>0`;
      case 'in':
        return `COALESCE(${column} && ${bind(where.values)}::uuid[],false)`;
      case 'out':
        return `NOT COALESCE(${column} && ${bind(where.values)}::uuid[],false)`;
      default:
        throw new TableValidationError('Unsupported collection filter');
    }
  }
  if (field.kind === 'relationship' || field.kind === 'file') {
    switch (where.op) {
      case 'empty':
        return `${column} IS NULL`;
      case 'not-empty':
        return `${column} IS NOT NULL`;
      case 'in':
        return `${column} = ANY(${bind(where.values)}::uuid[])`;
      // Membership-none includes empty links, unlike scalar inequality.
      case 'out':
        return `(${column} IS NULL OR ${column} <> ALL(${bind(where.values)}::uuid[]))`;
      default:
        throw new TableValidationError('Unsupported link filter');
    }
  }
  const cast = casts[field.kind];
  if (!cast || !scalarQueryKinds.includes(field.kind)) throw new TableValidationError('Unsupported filter field');
  const [first] = where.values;
  switch (where.op) {
    case 'empty':
      return `${column} IS NULL`;
    case 'not-empty':
      return `${column} IS NOT NULL`;
    case 'contains':
      return `${column} ILIKE ${bind(likePattern(first ?? ''))}`;
    // Scalar comparisons never match missing values, including != and =out=.
    case 'in':
      return `${column} = ANY(${bind(where.values)}::${cast}[])`;
    case 'out':
      return `${column} <> ALL(${bind(where.values)}::${cast}[])`;
    default: {
      const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
      return `${column} ${operators[where.op]} ${bind(first)}::${cast}`;
    }
  }
}

function searchPredicate(fields: readonly TableField[], search: string | undefined, parameters: unknown[]) {
  if (!search) return 'TRUE';
  const columns = fields.filter(field => field.kind === 'text').map(field => columnOf(field.id));
  if (!columns.length) return 'FALSE';
  parameters.push(likePattern(search));
  return `(${columns.map(column => `${column} ILIKE $${parameters.length}`).join(' OR ')})`;
}

/** Binds a cursor to the table, revision, and every input that affects which rows or groups come next. */
export function queryDigest(tableId: string, revision: string, query: TableQuery, identityScope?: string) {
  const shape =
    query.mode === 'rows'
      ? { mode: query.mode, where: query.where, search: query.search ?? null, sort: query.sort }
      : {
          mode: query.mode,
          where: query.where,
          search: query.search ?? null,
          groupBy: query.groupBy,
          metrics: query.metrics,
          order: query.order ?? null,
        };
  return createHash('sha256')
    .update(JSON.stringify([tableId, revision, shape, ...(identityScope ? [identityScope] : [])]))
    .digest('base64url')
    .slice(0, 22);
}

export async function bindCurrentMemberQuery(
  tx: TableTransaction,
  actor: Actor,
  generation: store.Generation,
  query: TableQuery,
) {
  const fields = (node: QueryNode | null): string[] =>
    !node ? [] : node.kind === 'rule' ? (node.op === 'is-me' ? [node.fieldId] : []) : node.nodes.flatMap(fields);
  const selected = fields(query.where);
  if (!selected.length) return { query, identityScope: undefined };
  const registration = await store.workspaceMembersTable(tx);
  if (!registration) throw new WorkspaceMemberError('member-unavailable');
  const tableId = registration.coreDefinition.id;
  for (const id of selected) {
    const field = generation.definition.fields.find(field => field.id === id);
    if (field?.kind !== 'relationship' || field.targetTableId !== tableId) {
      throw new TableQueryError([
        { code: 'unsupported-operator', fieldId: id, message: 'Is me requires a link to Workspace members.' },
      ]);
    }
  }
  const human = await queryHumanContext(tx, actor);
  if (!human)
    throw new TableQueryError([
      {
        code: 'human-context-required',
        message: 'Is me needs a current human request. Use an explicit member for an autonomous run.',
      },
    ]);
  await requireTablePermission(tx, actor, tableId, 'table.row.read');
  const member = z
    .object({ member_id: recordIdSchema, live: z.boolean() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT a.member_id,i.live FROM ${table(tx, 'tf_workspace_member_accounts')} a
      JOIN ${table(tx, 'tf_memberships')} m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
      JOIN ${table(tx, 'tf_table_identities')} i ON i.table_id=a.table_id AND i.row_id=a.member_id
      WHERE a.table_id=$1 AND a.user_id=$2 AND a.membership_id=$3`,
          [tableId, human.userId, human.membershipId],
        )
      ).rows[0],
    );
  if (!member) throw new WorkspaceMemberError('member-unavailable');
  if (!member.live) throw new WorkspaceMemberError('member-profile-pending');
  const bind = (node: QueryNode): QueryNode =>
    node.kind !== 'rule'
      ? { ...node, nodes: node.nodes.map(bind) }
      : node.op === 'is-me'
        ? { ...node, op: 'in', values: [member.member_id] }
        : node;
  return {
    query: { ...query, where: query.where ? bind(query.where) : null },
    identityScope: JSON.stringify([tx.workspaceId, human.userId, human.membershipId]),
  };
}

const rowCursorSchema = z
  .object({ v: z.literal(2), d: z.string(), k: z.array(z.string().nullable()).max(3), id: recordIdSchema })
  .strict();
const summaryCursorSchema = z.object({ v: z.literal(2), d: z.string(), o: z.int().min(1).max(1_000_000) }).strict();
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode<T>(schema: z.ZodType<T>, cursor: string, digest: string): T {
  let value: T;
  try {
    value = schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new TableValidationError('Malformed cursor');
  }
  if ((value as { d: string }).d !== digest) throw new TableValidationError('Cursor does not match the query');
  return value;
}

async function countUpTo(tx: TableTransaction, source: string, parameters: unknown[]) {
  const counted = z.coerce
    .number()
    .parse(
      (
        await tx.client.query(
          `SELECT count(*) AS total FROM (${source} LIMIT ${queryCountLimit + 1}) capped`,
          parameters,
        )
      ).rows[0]?.total,
    );
  return counted > queryCountLimit ? `${queryCountLimit}+` : String(counted);
}

async function bounded(tx: TableTransaction) {
  await tx.client.query(`SET LOCAL statement_timeout = '${queryStatementTimeout}'`);
  await tx.client.query(`SET LOCAL lock_timeout = '${queryLockTimeout}'`);
}

export async function runRowsQuery(
  tx: TableTransaction,
  generation: store.Generation,
  query: TableRowsQuery,
  identityScope?: string,
) {
  await bounded(tx);
  const fields = generation.definition.fields,
    parameters: unknown[] = [];
  const where = `${compileWhere(fields, query.where, parameters)} AND ${searchPredicate(fields, query.search, parameters)}`;
  const source = table(tx, generation.physical_table);
  const total = query.after ? null : await countUpTo(tx, `SELECT 1 FROM ${source} WHERE ${where}`, [...parameters]);
  const keys = query.sort.map(sort => {
    const field = fields.find(item => item.id === sort.fieldId);
    if (!field || !scalarQueryKinds.includes(field.kind)) throw new TableValidationError('Unsortable field');
    return { ...orderExpression(field), direction: sort.direction };
  });
  const digest = queryDigest(generation.table_id, generation.revision, query, identityScope);
  let after = 'TRUE';
  if (query.after) {
    const cursor = decode(rowCursorSchema, query.after, digest);
    if (cursor.k.length !== keys.length) throw new TableValidationError('Cursor does not match the query');
    const bind = (value: unknown) => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    // Lexicographic keyset with NULLS LAST: a row is after the anchor if it ties on a prefix and is later on the next key.
    const equal = (index: number) => {
      const value = cursor.k[index];
      const key = keys[index]!;
      return value === null ? `${key.sql} IS NULL` : `${key.sql} = ${bind(value)}::${key.cast}`;
    };
    const later = (index: number) => {
      const value = cursor.k[index],
        key = keys[index]!;
      return value === null
        ? 'FALSE'
        : `(${key.sql} ${key.direction === 'asc' ? '>' : '<'} ${bind(value)}::${key.cast} OR ${key.sql} IS NULL)`;
    };
    const branches = keys.map((_, index) =>
      [...keys.slice(0, index).map((__, prior) => equal(prior)), later(index)].join(' AND '),
    );
    branches.push([...keys.map((_, index) => equal(index)), `id > ${bind(cursor.id)}`].join(' AND '));
    after = `(${branches.map(branch => `(${branch})`).join(' OR ')})`;
  }
  const order = [...keys.map(key => `${key.sql} ${key.direction.toUpperCase()} NULLS LAST`), 'id'].join(',');
  parameters.push(query.limit + 1);
  const rows = z
    .array(z.object({ id: recordIdSchema, keys: z.array(z.string().nullable()) }))
    .parse(
      (
        await tx.client.query(
          `SELECT id,ARRAY[${keys.map(key => key.key).join(',') || 'NULL::text'}]::text[] AS keys FROM ${source} WHERE ${where} AND ${after} ORDER BY ${order} LIMIT $${parameters.length}`,
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
  const selected = query.select ? new Set<string>(query.select) : null;
  const records = page.flatMap(row => {
    const record = byId.get(row.id);
    if (!record) return [];
    return selected
      ? [{ ...record, values: Object.fromEntries(Object.entries(record.values).filter(([id]) => selected.has(id))) }]
      : [record];
  });
  const nextCursor =
    rows.length > query.limit && last
      ? encode({ v: 2, d: digest, k: keys.length ? last.keys : [], id: last.id })
      : null;
  return { records, total, nextCursor };
}

export async function runSummaryQuery(
  tx: TableTransaction,
  generation: store.Generation,
  query: TableSummaryQuery,
  identityScope?: string,
) {
  await bounded(tx);
  const fields = generation.definition.fields,
    parameters: unknown[] = [];
  const where = `${compileWhere(fields, query.where, parameters)} AND ${searchPredicate(fields, query.search, parameters)}`;
  const source = table(tx, generation.physical_table);
  const field = (id: string | undefined) => {
    const found = fields.find(item => item.id === id);
    if (!found) throw new TableValidationError('Unknown summary field');
    return found;
  };
  const groups = query.groupBy.map(id => {
    const target = field(id);
    return { field: target, column: columnOf(target.id), order: orderExpression(target).sql };
  });
  const metrics = query.metrics.map(metric => {
    if (metric.fn === 'count') return 'count(*)::text';
    const target = field(metric.fieldId),
      column = columnOf(target.id);
    if (metric.fn === 'avg') return `round(avg(${column}),6)::text`;
    if (metric.fn === 'sum') return `sum(${column})::text`;
    return textOf(target, `${metric.fn}(${column})`);
  });
  const digest = queryDigest(generation.table_id, generation.revision, query, identityScope);
  const offset = query.after ? decode(summaryCursorSchema, query.after, digest).o : 0;
  const groupBy = groups.length ? `GROUP BY ${groups.map(group => group.column).join(',')}` : '';
  const groupOrder = groups.map(group => `${group.order} ASC NULLS LAST`);
  const metricOrder = (index: number, direction: 'asc' | 'desc') =>
    `${query.metrics[index]?.fn === 'count' ? 'count(*)' : `${query.metrics[index]!.fn}(${columnOf(query.metrics[index]!.fieldId!)})`} ${direction.toUpperCase()} NULLS LAST`;
  const order =
    query.order?.kind === 'metric'
      ? [metricOrder(query.order.index, query.order.direction), ...groupOrder]
      : query.order?.kind === 'group'
        ? groups.map(
            (group, index) =>
              `${group.order} ${index === query.order!.index ? query.order!.direction.toUpperCase() : 'ASC'} NULLS LAST`,
          )
        : groupOrder;
  const groupCount =
    query.after || !groups.length
      ? null
      : await countUpTo(tx, `SELECT 1 FROM ${source} WHERE ${where} ${groupBy}`, [...parameters]);
  parameters.push(query.limit + 1, offset);
  const select = [...groups.map(group => textOf(group.field, group.column)), ...metrics]
    .map((expression, index) => `${expression} AS c${index}`)
    .join(',');
  const rows = (
    await tx.client.query(
      `SELECT ${select} FROM ${source} WHERE ${where} ${groupBy} ${order.length ? `ORDER BY ${order.join(',')}` : ''} LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    )
  ).rows as Record<string, string | null>[];
  const page = rows.slice(0, query.limit).map(row => {
    const cells = Array.from({ length: groups.length + metrics.length }, (_, index) => row[`c${index}`] ?? null);
    return { keys: cells.slice(0, groups.length), values: cells.slice(groups.length) };
  });
  const nextCursor = rows.length > query.limit ? encode({ v: 2, d: digest, o: offset + query.limit }) : null;
  return { groups: page, groupCount, nextCursor };
}
