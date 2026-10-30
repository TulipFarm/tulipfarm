import { z } from 'zod';
import { queryLimits } from '@tulipfarm/tables/query-limits';

/** The router reads `?value=5` as a number and `?value=true` as a boolean, so typed text accepts those back as strings. */
const typed = (max: number) =>
  z
    .union([z.string(), z.number(), z.boolean()])
    .transform(String)
    .pipe(z.string().max(max))
    .optional()
    .catch(undefined);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const list = (item: string, max: number) =>
  z
    .string()
    .regex(new RegExp(`^${item}(,${item}){0,${max - 1}}$`, 'i'))
    .optional()
    .catch(undefined);
/** Links keep the applied filter as canonical RSQL. Longer filters stay usable but are refused for links rather than truncated. */
export const linkQueryCharacters = 4000;
export const legacyOps = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'is-null', 'not-null'] as const;
export const tableListSearchSchema = z.object({ q: typed(255) });
export type TableListSearch = z.infer<typeof tableListSearchSchema>;
export const tableRowsSearchSchema = z.object({
  row: z.uuid().optional().catch(undefined),
  q: typed(255),
  where: typed(linkQueryCharacters),
  order: list(`-?${uuid}`, queryLimits.sortKeys),
  group: list(uuid, queryLimits.groupBy),
  calc: list(`(count|(sum|avg|min|max)\\.${uuid})`, queryLimits.metrics),
  cols: list(uuid, 64),
  // Page layout, each layout's fields, and the open search mode are shared in links too.
  view: z.enum(['table', 'board', 'list', 'chart', 'timeline']).optional().catch(undefined),
  board: z.uuid().optional().catch(undefined),
  chart: z.uuid().optional().catch(undefined),
  start: z.uuid().optional().catch(undefined),
  end: z.uuid().optional().catch(undefined),
  find: z.enum(['text', 'ai', 'rsql']).optional().catch(undefined),
  // Single sort and filter links from before typed queries.
  sort: z.uuid().optional().catch(undefined),
  dir: z.literal('desc').optional().catch(undefined),
  field: z.uuid().optional().catch(undefined),
  op: z.enum(legacyOps).optional().catch(undefined),
  value: typed(1000),
});
export type TableRowsSearch = z.infer<typeof tableRowsSearchSchema>;
