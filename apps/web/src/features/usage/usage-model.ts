import {
  usageDimensionSchema,
  usageFilterDimensions,
  type UsageDimension,
  type UsageFilterDimension,
  type UsageMeasure,
  type UsageMeasures,
  type UsageReport,
} from '@tulipfarm/workspace-storage/model-usage-contracts';
import type { UsageSearch } from './search.ts';

export const measureKeys = [
  'requests',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'credits',
  'billedUsd',
  'planValueUsd',
  'fallbacks',
] as const satisfies readonly UsageMeasure[];
export const dimensionKeys = usageDimensionSchema.options;
export const filterKeys = usageFilterDimensions;

export const formatNumber = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
export const formatTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : Math.round(value).toLocaleString();
export const formatUsd = (value: number) =>
  value >= 1_000
    ? `$${Math.round(value).toLocaleString()}`
    : value > 0 && value < 0.01
      ? '<$0.01'
      : `$${value.toFixed(value >= 100 ? 0 : 2)}`;
const formatCredits = (value: number) =>
  value > 0 && value < 0.01 ? '<0.01' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const measureInfo: Record<UsageMeasure, { label: string; hint?: string; format: (value: number) => string }> = {
  requests: { label: 'Requests', format: value => Math.round(value).toLocaleString() },
  inputTokens: { label: 'Input tokens', format: formatTokens },
  outputTokens: { label: 'Output tokens', format: formatTokens },
  totalTokens: { label: 'Total tokens', format: formatTokens },
  credits: {
    label: 'Credits',
    hint: 'TulipFarm credits charged. Plans and API keys use none.',
    format: value => (value ? formatCredits(value) : '—'),
  },
  billedUsd: {
    label: 'Est. cost',
    hint: 'At each model’s list price, for requests paid with TulipFarm credits or an API key. Your provider’s bill for a key can differ.',
    format: value => (value ? formatUsd(value) : '—'),
  },
  planValueUsd: {
    label: 'Plan value',
    hint: 'What requests on members’ own plans would cost at list price. Not billed: each member’s plan covers them.',
    format: value => (value ? `≈ ${formatUsd(value)}` : '—'),
  },
  fallbacks: {
    label: 'Fallbacks',
    hint: 'Requests another route answered because the chosen plan or model could not, for example after a plan hit its limit.',
    format: value => (value ? Math.round(value).toLocaleString() : '—'),
  },
};

export const emptyMeasures = (): UsageMeasures => Object.fromEntries(measureKeys.map(key => [key, 0])) as UsageMeasures;
export function addMeasures(total: UsageMeasures, next: UsageMeasures) {
  for (const key of measureKeys) total[key] += next[key];
  return total;
}

const isDimension = (value: string): value is UsageDimension => (dimensionKeys as readonly string[]).includes(value);
const isFilterKey = (value: string): value is UsageFilterDimension => (filterKeys as readonly string[]).includes(value);
const isMeasure = (value: string): value is UsageMeasure => (measureKeys as readonly string[]).includes(value);
export const isTime = (dimension: UsageDimension | undefined) => dimension === 'day' || dimension === 'week';

// ---------------------------------------------------------------------------------------------------------------------
// Views and URL state.

export type Preset = 'models' | 'providers' | 'people' | 'custom';
export const presets: Record<
  Exclude<Preset, 'custom'>,
  { label: string; groups: UsageDimension[]; cols: UsageMeasure[]; chart: UsageMeasure }
> = {
  models: {
    label: 'Models',
    groups: ['model', 'paidBy'],
    cols: ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'billedUsd', 'planValueUsd'],
    chart: 'totalTokens',
  },
  providers: {
    label: 'Providers',
    groups: ['paidBy', 'connection'],
    cols: ['requests', 'totalTokens', 'credits', 'billedUsd', 'planValueUsd', 'fallbacks'],
    chart: 'requests',
  },
  people: {
    label: 'People & agents',
    groups: ['usedBy', 'model'],
    cols: ['requests', 'totalTokens', 'credits', 'billedUsd', 'planValueUsd', 'fallbacks'],
    chart: 'totalTokens',
  },
};

export type Filters = Partial<Record<UsageFilterDimension, string[]>>;
export function encodeFilters(filters: Filters) {
  const kept = Object.entries(filters).filter(([, values]) => values?.length);
  return kept.length ? JSON.stringify(Object.fromEntries(kept)) : undefined;
}
function decodeFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const filters: Filters = {};
    for (const [key, values] of Object.entries(value))
      if (isFilterKey(key) && Array.isArray(values))
        filters[key] = values.filter((item): item is string => typeof item === 'string').slice(0, 200);
    return filters;
  } catch {
    return {};
  }
}

export type Range = '7' | '30' | '90' | 'custom';
/** A local calendar date, `YYYY-MM-DD`. */
export const localDate = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
export const dateOf = (day: string) => new Date(`${day}T00:00:00`);
function addDays(day: string, days: number) {
  const date = dateOf(day);
  date.setDate(date.getDate() + days);
  return localDate(date);
}
/** Ranges stop a year back; the server allows a little more. */
export const earliestDay = () => addDays(localDate(new Date()), -365);

export function readExplorerState(search: UsageSearch) {
  const preset: Preset =
    search.view === 'providers' || search.view === 'people' || search.view === 'custom' ? search.view : 'models';
  const base = presets[preset === 'custom' ? 'models' : preset];
  const groups = [...new Set(search.group?.split(',').filter(isDimension) ?? [])].slice(0, 2);
  const cols = search.cols?.split(',').filter(isMeasure) ?? [];
  const chartMeasure = search.measure && isMeasure(search.measure) ? search.measure : base.chart;
  const [sortKey, sortDir] = (search.sort ?? `${chartMeasure}:desc`).split(':');
  const range: Range =
    search.range === '7' || search.range === '90' || (search.range === 'custom' && search.from && search.to)
      ? search.range
      : '30';
  const today = localDate(new Date());
  const from =
    range === 'custom'
      ? search.from! < earliestDay()
        ? earliestDay()
        : search.from!
      : addDays(today, 1 - Number(range));
  const to = range === 'custom' ? (search.to! > today ? today : search.to!) : today;
  return {
    preset,
    groups: groups.length ? groups : base.groups,
    cols: cols.length ? cols : base.cols,
    chartMeasure,
    chartMode: (search.chart === 'time' ? 'time' : 'group') as 'time' | 'group',
    sorting: [
      { id: sortKey === 'label' || (sortKey && isMeasure(sortKey)) ? sortKey : chartMeasure, desc: sortDir !== 'asc' },
    ],
    filters: decodeFilters(search.filter),
    range,
    /** First and last local day, inclusive. */
    from: from <= to ? from : to,
    to,
    query: search.q ?? '',
  };
}
export type ExplorerState = ReturnType<typeof readExplorerState>;

/** Every local day in the range, oldest first. */
export function rangeDays(state: Pick<ExplorerState, 'from' | 'to'>) {
  const days: string[] = [];
  for (let day = state.from; day <= state.to && days.length < 400; day = addDays(day, 1)) days.push(day);
  return days;
}

export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The report request for a view: the range runs from local midnight on the first day to local midnight after the last. */
export function reportQuery(state: ExplorerState) {
  return {
    from: dateOf(state.from).toISOString(),
    to: dateOf(addDays(state.to, 1)).toISOString(),
    group: state.groups,
    filters: state.filters,
    timeZone: timeZone(),
  };
}
export type ReportQuery = ReturnType<typeof reportQuery>;

// ---------------------------------------------------------------------------------------------------------------------
// Rows.

export type PivotRow = UsageMeasures & {
  id: string;
  label: string;
  dimension: UsageDimension;
  value: string;
  subRows?: PivotRow[];
};

/** Nests the report's rows under their first group, totalling each parent. */
export function pivot(
  report: UsageReport,
  groups: UsageDimension[],
  name: (dimension: UsageDimension, value: string) => string,
): PivotRow[] {
  const [first, second] = groups;
  if (!first) return [];
  const parents = new Map<string, PivotRow>();
  for (const { keys, ...measures } of report.rows) {
    const value = keys[0] ?? '';
    const id = `${first}=${value}`;
    let parent = parents.get(value);
    if (!parent) {
      parent = { ...emptyMeasures(), id, label: name(first, value), dimension: first, value };
      if (second) parent.subRows = [];
      parents.set(value, parent);
    }
    addMeasures(parent, measures);
    if (second && parent.subRows) {
      const child = keys[1] ?? '';
      parent.subRows.push({
        ...measures,
        id: `${id}/${second}=${child}`,
        label: name(second, child),
        dimension: second,
        value: child,
      });
    }
  }
  return [...parents.values()];
}

export function searchRows(rows: PivotRow[], query: string): PivotRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.flatMap(row => {
    if (row.label.toLowerCase().includes(needle)) return [row];
    const subRows = row.subRows ? searchRows(row.subRows, query) : [];
    return subRows.length ? [{ ...row, subRows }] : [];
  });
}

export function sortRows(rows: PivotRow[], sorting: ExplorerState['sorting']): PivotRow[] {
  const sort = sorting[0];
  const key = (sort?.id ?? 'requests') as keyof PivotRow;
  const direction = sort?.desc === false ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
    return String(left).localeCompare(String(right)) * direction;
  });
}

export function totalOf(rows: PivotRow[]) {
  return rows.reduce((total, row) => addMeasures(total, row), emptyMeasures());
}

const csvCell = (cell: string) => `"${(/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell).replaceAll('"', '""')}"`;
/** The leaf rows as CSV, one column per group level and measure. Cells that look like formulas are quoted as text. */
export function usageCsv(rows: PivotRow[], state: ExplorerState, groupLabel: (dimension: UsageDimension) => string) {
  const header = [...state.groups.map(groupLabel), ...state.cols.map(key => measureInfo[key].label)];
  const lines = [header];
  const walk = (items: PivotRow[], path: string[]) => {
    for (const row of items) {
      if (row.subRows) walk(row.subRows, [...path, row.label]);
      else lines.push([...path, row.label, ...state.cols.map(key => String(Math.round(row[key] * 10_000) / 10_000))]);
    }
  };
  walk(rows, []);
  return lines.map(line => line.map(csvCell).join(',')).join('\n');
}
