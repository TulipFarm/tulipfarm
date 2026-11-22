import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  AddIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  FilterIcon,
  KeyIcon,
  LockIcon,
  SlidersIcon,
  UserIcon,
  WalletIcon,
} from '@tulipfarm/icons';
import type {
  UsageConnection,
  UsageDimension,
  UsageFilterDimension,
  UsageMeasure,
  UsageMeasures,
  UsageReport,
} from '@tulipfarm/workspace-storage/model-usage-contracts';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ButtonGroup } from '@tulipfarm/sprout/button-group';
import { cardVariants } from '@tulipfarm/sprout/card';
import { Calendar, type DateRange } from '@tulipfarm/sprout/calendar';
import { CategoryChart, type ChartRow, type UsageSeries } from '@tulipfarm/sprout/chart';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Progress } from '@tulipfarm/sprout/progress';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table, type TableColumn, type TableState } from '@tulipfarm/sprout/table';
import { Tabs, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { ModelRead } from '@/features/models/read';
import { planLabels, planUsageUrls } from '@/features/chat/reply-failure-copy';
import { timeAgo } from '@/features/chat/plan-usage';
import { useMemberDirectory } from '@/features/secrets/queries';
import { usageSearchSchema, type UsageSearch } from './search.ts';
import { useUsageReport } from './queries.ts';
import { usageDimensions, type Member, type UsageDimensions } from './usage-dimensions.tsx';
import {
  addMeasures,
  dateOf,
  dimensionKeys,
  earliestDay,
  emptyMeasures,
  encodeFilters,
  filterKeys,
  formatNumber,
  formatUsd,
  isTime,
  localDate,
  measureInfo,
  measureKeys,
  pivot,
  presets,
  rangeDays,
  readExplorerState,
  reportQuery,
  searchRows,
  sortRows,
  totalOf,
  usageCsv,
  type ExplorerState,
  type PivotRow,
  type Preset,
} from './usage-model.ts';

const chartColor = (index: number) => (index < 5 ? `var(--chart-${index + 1})` : 'var(--muted-foreground)');

type SetSearch = (next: Partial<UsageSearch>) => void;
function useSetSearch(): SetSearch {
  const navigate = useNavigate({ from: '/$workspaceSlug/settings/usage' });
  return next =>
    void navigate({
      search: previous => {
        const merged: Record<string, string | undefined> = { ...previous, ...next };
        for (const [key, value] of Object.entries(merged)) if (!value) delete merged[key];
        return merged;
      },
      replace: true,
      resetScroll: false,
    });
}

type Context = {
  state: ExplorerState;
  set: SetSearch;
  /** Any change other than the time range or search makes the view custom. */
  custom: SetSearch;
  report: UsageReport;
  dims: UsageDimensions;
};

export function UsageExplorer({ workspaceId }: { workspaceId: string }) {
  const raw = useSearch({ from: '/$workspaceSlug/settings/usage' });
  const search = useMemo(() => usageSearchSchema.parse(raw), [raw]);
  const state = useMemo(() => readExplorerState(search), [search]);
  const query = useMemo(() => reportQuery(state), [state]);
  const { state: read, refresh } = useUsageReport(workspaceId, query);
  const directory = useMemberDirectory(workspaceId);
  const members = useMemo(() => {
    const list = directory.state.kind === 'ready' ? directory.state.data : [];
    return new Map<string, Member>(list.map(member => [member.id, member]));
  }, [directory.state]);
  // Keep showing the last report while a changed view loads, so the page doesn't blank on every click.
  const [last, setLast] = useState<{ report: UsageReport; groups: UsageDimension[] } | null>(null);
  if (read.kind === 'ready' && last?.report !== read.data) setLast({ report: read.data, groups: query.group });
  if (read.kind === 'loading' && last)
    return <Explorer report={last.report} groups={last.groups} state={state} members={members} updating />;
  return (
    <ModelRead state={read} refresh={refresh} label="usage">
      {report => <Explorer report={report} groups={query.group} state={state} members={members} />}
    </ModelRead>
  );
}

function Explorer({
  report,
  groups,
  state: urlState,
  members,
  updating,
}: {
  report: UsageReport;
  groups: UsageDimension[];
  state: ExplorerState;
  members: ReadonlyMap<string, Member>;
  updating?: boolean;
}) {
  const set = useSetSearch();
  const state = { ...urlState, groups };
  const dims = useMemo(() => usageDimensions(report, members), [report, members]);
  const context: Context = { state, set, custom: next => set({ view: 'custom', ...next }), report, dims };
  const rows = useMemo(
    () =>
      searchRows(
        pivot(report, groups, (dimension, value) => dims[dimension].name(value)),
        state.query,
      ),
    [report, groups, dims, state.query],
  );
  const [controlsOpen, setControlsOpen] = useState(false);
  const filterCount = Object.values(state.filters).filter(values => values?.length).length;

  return (
    <div className="space-y-6" aria-busy={updating}>
      <SourceSummary context={context} />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            value={state.preset}
            onValueChange={value => {
              if (value === 'custom') return set({ view: 'custom' });
              set({
                view: value === 'models' ? undefined : (value as Preset),
                group: undefined,
                cols: undefined,
                measure: undefined,
                sort: undefined,
                chart: undefined,
              });
            }}
          >
            <TabsList variant="line" aria-label="Saved views">
              {(Object.keys(presets) as Exclude<Preset, 'custom'>[]).map(key => (
                <TabsTrigger key={key} value={key}>
                  {presets[key].label}
                </TabsTrigger>
              ))}
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2">
            <RangePicker context={context} />
            <Button variant="outline" size="sm" disabled={!rows.length} onClick={() => downloadCsv(rows, context)}>
              <DownloadIcon size="sm" aria-hidden />
              Export CSV
            </Button>
          </div>
        </div>

        <div className="hidden flex-wrap items-center gap-2 md:flex">
          <Controls context={context} />
        </div>
        <div className="flex flex-wrap items-center gap-2 md:hidden">
          <Button variant="outline" size="sm" onClick={() => setControlsOpen(true)}>
            <SlidersIcon size="sm" aria-hidden />
            Group and filter{filterCount ? ` (${filterCount})` : ''}
          </Button>
          <span className="text-sm text-muted-foreground">
            By {state.groups.map(key => dims[key].label.toLowerCase()).join(', then ')}
          </span>
        </div>
        <FilterChips context={context} />
        <Sheet open={controlsOpen} onOpenChange={setControlsOpen}>
          <SheetContent side="bottom">
            <SheetHeader>
              <SheetTitle>Group and filter</SheetTitle>
              <SheetDescription>Choose how to break down usage, and which rows to keep.</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <div className="flex flex-col items-stretch gap-3 pb-6">
                <Controls context={context} stacked />
                <FilterChips context={context} />
              </div>
            </SheetBody>
          </SheetContent>
        </Sheet>
      </div>

      {report.rows.length ? (
        <>
          <ExplorerChart context={context} />
          <ExplorerTable rows={rows} context={context} />
        </>
      ) : (
        <StatePanel
          kind="empty"
          title={filterCount ? 'No usage matches these filters' : 'No usage in this range'}
          description={
            filterCount
              ? 'Remove a filter or choose a longer time range.'
              : 'Model requests from chats, agents, and tasks appear here once they finish.'
          }
        >
          {filterCount > 0 && (
            <Button variant="outline" onClick={() => context.custom({ filter: undefined })}>
              Clear filters
            </Button>
          )}
        </StatePanel>
      )}

      <div className="space-y-2 text-sm text-muted-foreground">
        {report.truncated && (
          <p>
            Showing the busiest groups only. Add a filter or choose fewer groups to see the rest; totals and the chart
            cover everything.
          </p>
        )}
        <p>
          Est. cost uses each model’s list price. Plan value is not billed: members’ own ChatGPT, Claude, and GitHub
          Copilot plans cover those requests.
        </p>
        <p>
          {report.detailSince
            ? `Chat tokens and payment sources are recorded from ${dateOf(localDate(new Date(report.detailSince))).toLocaleDateString(undefined, { dateStyle: 'medium' })}. Earlier chats show credits only; agent runs and tasks show tokens from the start.`
            : 'Chat tokens and payment sources are recorded from now on. Earlier chats show credits only; agent runs and tasks show tokens from the start.'}
        </p>
        <p className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">
            <LockIcon size="sm" aria-hidden />
          </span>
          {report.viewer.admin
            ? 'As a workspace admin, you see each member’s plan usage. Members see only their own plans, plus the workspace’s credits and API keys.'
            : 'You see your own plans and your share of credits and API keys. Other members’ usage shows as one total, and their plans stay private.'}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment sources: credits, plans, keys. Each card opens the matching breakdown.

function SourceSummary({ context }: { context: Context }) {
  const { report, state } = context;
  const total = (paidBy: string) =>
    addMeasures(emptyMeasures(), report.options.paidBy?.find(option => option.value === paidBy) ?? emptyMeasures());
  const credits = total('credits');
  const plans = total('plan');
  const keys = total('key');
  const connections = Object.values(report.labels.connections).filter(
    connection => report.viewer.admin || connection.ownerMembershipId === report.viewer.membershipId,
  );
  const limited = connections.filter(connection => connection.status.status === 'limit-reached').length;
  const reconnect = connections.filter(connection => connection.status.status === 'reconnect').length;
  const lowCopilot = connections.filter(connection => {
    const premium = connection.status.premiumRequests;
    return premium && premium.entitlement > 0 && premium.remaining / premium.entitlement < 0.1;
  });
  const days = rangeDays(state).length;
  const open = (paidBy: string) =>
    context.custom({ group: 'connection,model', filter: encodeFilters({ paidBy: [paidBy] }), sort: 'requests:desc' });
  const balance = report.balance;
  return (
    <section aria-label="Payment sources" className="grid gap-3 sm:grid-cols-3">
      <SourceCard
        icon={<WalletIcon size="sm" aria-hidden />}
        title="TulipFarm credits"
        value={balance.available === null ? 'Unlimited' : formatNumber(balance.available)}
        caption={`${balance.available !== null && balance.available < 0 ? 'Overdrawn · ' : balance.available !== null && balance.granted !== null ? `left of ${formatNumber(balance.granted)} · ` : ''}${measureInfo.credits.format(credits.credits).replace('—', '0')} used in ${days} days`}
        onOpen={() => open('credits')}
        openLabel="See credit usage"
      />
      <SourceCard
        icon={<UserIcon size="sm" aria-hidden />}
        title="Member plans"
        value={measureInfo.requests.format(plans.requests)}
        caption={
          connections.length
            ? `requests on ${connections.length} ${connections.length === 1 ? 'plan' : 'plans'} · ≈ ${formatUsd(plans.planValueUsd)} value, not billed`
            : 'requests · no plan used in this range'
        }
        onOpen={() => open('plan')}
        openLabel="See plan usage"
      >
        {connections.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {limited > 0 && <Badge variant="destructive">{limited} limit reached</Badge>}
            {reconnect > 0 && <Badge variant="warning">{reconnect} reconnect needed</Badge>}
            {lowCopilot.map(connection => (
              <Badge key={connection.id} variant="warning">
                {copilotOwner(connection, context)}Copilot: {connection.status.premiumRequests!.remaining} left
              </Badge>
            ))}
            {!limited && !reconnect && !lowCopilot.length && <Badge variant="success">All available</Badge>}
          </span>
        )}
      </SourceCard>
      <SourceCard
        icon={<KeyIcon size="sm" aria-hidden />}
        title="API keys"
        value={formatUsd(keys.billedUsd)}
        caption={
          keys.requests
            ? `est. at list price on ${measureInfo.requests.format(keys.requests)} requests · billed by the provider`
            : 'Your own provider API keys aren’t available yet.'
        }
        onOpen={() => open('key')}
        openLabel="See API key usage"
      />
    </section>
  );
}

function SourceCard({
  icon,
  title,
  value,
  caption,
  onOpen,
  openLabel,
  children,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  caption: string;
  onOpen: () => void;
  openLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className={cardVariants({ size: 'sm', className: 'flex flex-col gap-1 px-4' })}>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon} {title}
      </span>
      <span className="text-2xl font-medium tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
      {children}
      <span className="mt-auto pt-1">
        <Button variant="link" size="sm" onClick={onOpen}>
          {openLabel}
        </Button>
      </span>
    </div>
  );
}

function copilotOwner(connection: UsageConnection, context: Context) {
  if (!context.report.viewer.admin || connection.ownerMembershipId === context.report.viewer.membershipId) return '';
  const name = context.dims.member.name(connection.ownerMembershipId);
  return `${name.split(' ')[0]}’s `;
}

// ---------------------------------------------------------------------------------------------------------------------
// Controls.

function RangePicker({ context }: { context: Context }) {
  const { state, set } = context;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const short = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="flex items-center gap-1">
      <ToggleGroup
        value={[state.range === 'custom' ? '' : state.range]}
        onValueChange={value => {
          const next = value[0];
          if (next) set({ range: next === '30' ? undefined : next, from: undefined, to: undefined });
        }}
        variant="outline"
        size="sm"
        aria-label="Time range"
      >
        <ToggleGroupItem value="7">7 days</ToggleGroupItem>
        <ToggleGroupItem value="30">30 days</ToggleGroupItem>
        <ToggleGroupItem value="90">90 days</ToggleGroupItem>
      </ToggleGroup>
      <Popover
        open={open}
        onOpenChange={next => {
          setOpen(next);
          if (next) setDraft({ from: dateOf(state.from), to: dateOf(state.to) });
        }}
      >
        <PopoverTrigger render={<Button variant={state.range === 'custom' ? 'secondary' : 'outline'} size="sm" />}>
          <CalendarIcon size="sm" aria-hidden />
          {state.range === 'custom' ? `${short(state.from)} – ${short(state.to)}` : 'Custom'}
        </PopoverTrigger>
        <PopoverContent align="end" size="picker" aria-label="Choose a date range">
          <Calendar
            mode="range"
            selected={draft}
            onSelect={next => {
              setDraft(next);
              if (next?.from && next.to) {
                set({ range: 'custom', from: localDate(next.from), to: localDate(next.to) });
                setOpen(false);
              }
            }}
            disabled={{ before: dateOf(earliestDay()), after: new Date() }}
            defaultMonth={dateOf(state.from)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Controls({ context, stacked }: { context: Context; stacked?: boolean }) {
  const { state, dims } = context;
  const [first, second] = state.groups;
  const field = stacked ? 'flex flex-col gap-1.5' : 'flex items-center gap-2';
  const label = 'text-sm text-muted-foreground';
  const suffix = stacked ? '-sheet' : '';
  return (
    <>
      <div className={field}>
        <span className={label} id={`usage-group-1${suffix}`}>
          Group by
        </span>
        <Select
          value={first}
          onValueChange={value => {
            if (!value) return;
            context.custom({ group: [value, second === value ? undefined : second].filter(Boolean).join(',') });
          }}
        >
          <SelectTrigger size="sm" width={stacked ? 'full' : 'fit'} aria-labelledby={`usage-group-1${suffix}`}>
            <SelectValue>{first ? dims[first].label : ''}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {dimensionKeys.map(key => (
              <SelectItem key={key} value={key}>
                {dims[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={field}>
        <span className={label} id={`usage-group-2${suffix}`}>
          then by
        </span>
        <Select
          value={second ?? 'none'}
          onValueChange={value => {
            if (!value || !first) return;
            context.custom({ group: value === 'none' ? first : `${first},${value}` });
          }}
        >
          <SelectTrigger size="sm" width={stacked ? 'full' : 'fit'} aria-labelledby={`usage-group-2${suffix}`}>
            <SelectValue>{second ? dims[second].label : 'Nothing'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Nothing</SelectItem>
            {dimensionKeys
              .filter(key => key !== first)
              .map(key => (
                <SelectItem key={key} value={key}>
                  {dims[key].label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      {stacked && (
        <div className={field}>
          <span className={label} id="usage-sort-by">
            Sort by
          </span>
          <Select
            value={state.sorting[0]?.id ?? 'requests'}
            onValueChange={value => value && context.set({ sort: `${value}:${value === 'label' ? 'asc' : 'desc'}` })}
          >
            <SelectTrigger size="sm" width="full" aria-labelledby="usage-sort-by">
              <SelectValue>
                {state.sorting[0]?.id === 'label'
                  ? 'Name'
                  : measureInfo[(state.sorting[0]?.id ?? 'requests') as UsageMeasure]?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="label">Name</SelectItem>
              {measureKeys.map(key => (
                <SelectItem key={key} value={key}>
                  {measureInfo[key].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className={stacked ? 'grid grid-cols-2 gap-2' : 'flex items-center gap-2'}>
        <AddFilter context={context} />
        <ColumnsMenu context={context} />
      </div>
      <div className={stacked ? 'w-full' : 'ml-auto w-56'}>
        <SearchField
          label="Search rows"
          value={state.query}
          onChange={value => context.set({ q: value || undefined })}
        />
      </div>
    </>
  );
}

function setFilter(context: Context, dimension: UsageFilterDimension, values: string[]) {
  context.custom({ filter: encodeFilters({ ...context.state.filters, [dimension]: values }) });
}

/** A dimension's values in the time range, busiest first; chosen values stay listed even when they have no usage. */
function FilterValues({ context, dimension }: { context: Context; dimension: UsageFilterDimension }) {
  const chosen = context.state.filters[dimension] ?? [];
  const options = [...(context.report.options[dimension] ?? [])].sort((a, b) => b.requests - a.requests);
  const values = [
    ...options.map(option => option.value),
    ...chosen.filter(value => !options.some(o => o.value === value)),
  ];
  const info = context.dims[dimension];
  if (!values.length) return <p className="px-2 py-1.5 text-sm text-muted-foreground">No values in this range</p>;
  return (
    <DropdownMenuGroup>
      {values.map(value => (
        <DropdownMenuCheckboxItem
          key={value}
          checked={chosen.includes(value)}
          closeOnClick={false}
          onCheckedChange={checked =>
            setFilter(context, dimension, checked ? [...chosen, value] : chosen.filter(item => item !== value))
          }
        >
          <span className="inline-flex items-center gap-2">
            {info.icon?.(value)}
            {info.name(value)}
          </span>
        </DropdownMenuCheckboxItem>
      ))}
    </DropdownMenuGroup>
  );
}

function AddFilter({ context }: { context: Context }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <AddIcon size="sm" aria-hidden />
        Add filter
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Filter by</DropdownMenuLabel>
        {filterKeys.map(key => (
          <DropdownMenuSub key={key}>
            <DropdownMenuSubTrigger>{context.dims[key].label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <FilterValues context={context} dimension={key} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnsMenu({ context }: { context: Context }) {
  const { cols } = context.state;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        Measures ({cols.length})
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {measureKeys.map(key => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={cols.includes(key)}
              closeOnClick={false}
              onCheckedChange={checked => {
                const next = measureKeys.filter(item => (item === key ? checked : cols.includes(item)));
                if (next.length) context.custom({ cols: next.join(',') });
              }}
            >
              {measureInfo[key].label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterChips({ context }: { context: Context }) {
  const active = (Object.entries(context.state.filters) as [UsageFilterDimension, string[]][]).filter(
    ([, values]) => values.length,
  );
  if (!active.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">
        <FilterIcon size="sm" aria-hidden />
      </span>
      {active.map(([dimension, values]) => {
        const info = context.dims[dimension];
        const names = values.map(info.name);
        const text = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
        return (
          <ButtonGroup key={dimension} aria-label={`${info.label} filter`}>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <span className="text-muted-foreground">{info.label}:</span>
                <span className="max-w-52 truncate">{text}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <FilterValues context={context} dimension={dimension} />
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Remove ${info.label} filter`}
              onClick={() => setFilter(context, dimension, [])}
            >
              <CloseIcon size="xs" aria-hidden />
            </Button>
          </ButtonGroup>
        );
      })}
      <Button variant="link" size="sm" onClick={() => context.custom({ filter: undefined })}>
        Clear all
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Chart: bars per group stacked by the second group, or bars per day stacked by a group.

type Point = { at: string; stack: string | null; measures: UsageMeasures };
const dayLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function ExplorerChart({ context }: { context: Context }) {
  const { state, report, dims } = context;
  const measure = state.chartMeasure;
  const info = measureInfo[measure];
  const [first, second] = state.groups;
  const timeFirst = isTime(first);
  const mode = timeFirst ? 'time' : state.chartMode;
  // Over time, stack by the first non-time group: the second when the first is a day or week.
  const stackDim = mode === 'time' ? (timeFirst ? (isTime(second) ? undefined : second) : first) : second;

  const points = useMemo<Point[]>(() => {
    if (mode === 'time' && !timeFirst)
      return report.series.map(({ date, key, ...measures }) => ({ at: date, stack: key, measures }));
    return report.rows.map(({ keys, ...measures }) => ({
      at: keys[0] ?? '',
      stack: stackDim ? (keys[1] ?? null) : null,
      measures,
    }));
  }, [report, mode, timeFirst, stackDim]);

  const { series, slotOf } = useMemo(() => {
    if (!stackDim) return { series: [{ key: 's0', label: info.label, color: chartColor(0) }], slotOf: () => 's0' };
    const totals = new Map<string, number>();
    for (const point of points)
      if (point.stack !== null) totals.set(point.stack, (totals.get(point.stack) ?? 0) + point.measures[measure]);
    const ranked = [...totals.entries()].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1]);
    const slots = new Map(ranked.map(([id], index) => [id, `s${Math.min(index, 5)}`]));
    const list: UsageSeries[] = ranked
      .slice(0, 5)
      .map(([id], index) => ({ key: `s${index}`, label: dims[stackDim].name(id), color: chartColor(index) }));
    if (ranked.length > 5) list.push({ key: 's5', label: `${ranked.length - 5} more`, color: chartColor(5) });
    return { series: list, slotOf: (point: Point) => slots.get(point.stack ?? '') ?? 's5' };
  }, [points, stackDim, measure, dims, info.label]);

  const daily = useMemo(() => {
    const weekly = first === 'week' && mode === 'time';
    const days = weekly ? [...new Set(points.map(point => point.at))].sort() : rangeDays(state);
    const rows = new Map<string, ChartRow>(
      days.map(day => [day, { category: dayLabel.format(new Date(`${day}T00:00:00Z`)) }]),
    );
    for (const point of points) {
      const row = rows.get(point.at);
      if (!row) continue;
      const key = slotOf(point);
      row[key] = ((row[key] as number | undefined) ?? 0) + point.measures[measure];
    }
    return [...rows.values()];
  }, [points, slotOf, measure, first, mode, state.from, state.to]);

  const grouped = useMemo(() => {
    if (mode !== 'group' || !first) return [];
    const rows = new Map<string, ChartRow & { total: number }>();
    for (const point of points) {
      const row = rows.get(point.at) ?? { category: dims[first].name(point.at), total: 0 };
      const key = slotOf(point);
      const amount = point.measures[measure];
      row[key] = ((row[key] as number | undefined) ?? 0) + amount;
      row.total += amount;
      rows.set(point.at, row);
    }
    return [...rows.values()]
      .filter(row => row.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [points, mode, first, slotOf, measure, dims]);

  const title =
    mode === 'time'
      ? `${info.label} per ${first === 'week' ? 'week' : 'day'}${stackDim ? `, by ${dims[stackDim].label.toLowerCase()}` : ''}`
      : `${info.label} by ${dims[first!].label.toLowerCase()}${second ? `, split by ${dims[second].label.toLowerCase()}` : ''}`;

  return (
    <section aria-labelledby="usage-chart" className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="usage-chart" className="text-sm font-medium">
          {title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={measure} onValueChange={next => next && context.custom({ measure: next })}>
            <SelectTrigger size="sm" aria-label="Chart measure">
              <SelectValue>{info.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {measureKeys.map(key => (
                <SelectItem key={key} value={key}>
                  {measureInfo[key].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!timeFirst && (
            <ToggleGroup
              value={[mode]}
              onValueChange={next => next[0] && context.set({ chart: next[0] === 'time' ? 'time' : undefined })}
              variant="outline"
              size="sm"
              aria-label="Chart layout"
            >
              <ToggleGroupItem value="group">By group</ToggleGroupItem>
              <ToggleGroupItem value="time">Over time</ToggleGroupItem>
            </ToggleGroup>
          )}
        </div>
      </div>
      {measure === 'planValueUsd' && (
        <p className="text-xs text-muted-foreground">Value at list price. Not billed; members’ plans cover it.</p>
      )}
      {mode === 'time' ? (
        <CategoryChart
          rows={daily}
          category="category"
          series={series}
          stack="stacked"
          title={title}
          valueFormatter={info.format}
        />
      ) : (
        <CategoryChart
          rows={grouped}
          category="category"
          series={series}
          horizontal
          stack="stacked"
          title={title}
          valueFormatter={info.format}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Table.

function ConnectionStatus({ value, context }: { value: string; context: Context }) {
  const { report } = context;
  if (value === 'credits')
    return (
      <span className="text-xs text-muted-foreground">
        {report.balance.available === null
          ? 'Unlimited'
          : report.balance.available < 0
            ? `${formatNumber(-report.balance.available)} credits overdrawn`
            : `${formatNumber(report.balance.available)} credits left`}
      </span>
    );
  const connection = report.labels.connections[value];
  if (!connection) return null;
  const { status, limitedAt, premiumRequests } = connection.status;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {status === 'reconnect' ? (
        <Badge variant="warning">Reconnect needed</Badge>
      ) : status === 'limit-reached' ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge variant="destructive">Limit reached</Badge>
          {limitedAt && <span className="text-xs text-muted-foreground">{timeAgo(limitedAt)}</span>}
        </span>
      ) : premiumRequests ? (
        <QuotaBar remaining={premiumRequests.remaining} entitlement={premiumRequests.entitlement} />
      ) : (
        <Badge variant="success">Available</Badge>
      )}
      <Button
        variant="link"
        size="sm"
        nativeButton={false}
        render={<a href={planUsageUrls[connection.provider]} target="_blank" rel="noopener noreferrer" />}
      >
        Manage usage
        <ArrowUpRightIcon size="xs" aria-hidden />
        <span className="sr-only"> on {planLabels[connection.provider]} (opens in a new tab)</span>
      </Button>
    </span>
  );
}

function QuotaBar({ remaining, entitlement }: { remaining: number; entitlement: number }) {
  const share = entitlement > 0 ? Math.min(1, Math.max(0, remaining / entitlement)) : 0;
  const low = share < 0.1;
  return (
    <span className="inline-flex min-w-36 flex-col gap-1">
      <span className="text-xs">
        <span className={low ? 'font-medium text-destructive' : 'font-medium'}>{remaining.toLocaleString()}</span>
        <span className="text-muted-foreground"> of {entitlement.toLocaleString()} premium requests left</span>
      </span>
      <Progress value={Math.round(share * 100)} aria-hidden />
    </span>
  );
}

function RowLabel({ row, context }: { row: PivotRow; context: Context }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {context.dims[row.dimension].icon?.(row.value)}
      <span className="truncate">{row.label}</span>
    </span>
  );
}

function ExplorerTable({ rows, context }: { rows: PivotRow[]; context: Context }) {
  const { state, dims } = context;
  const [expanded, setExpanded] = useState<TableState['expanded']>({});
  const showStatus = state.groups.includes('connection');
  const columns = useMemo<TableColumn<PivotRow>[]>(
    () => [
      {
        key: 'label',
        header: state.groups.map(key => dims[key].label).join(' › '),
        sort: true,
        pin: 'left',
        width: 240,
        cell: row => <RowLabel row={row} context={context} />,
      },
      ...(showStatus
        ? [
            {
              key: 'value' as const,
              header: 'Status',
              width: 230,
              cell: (row: PivotRow) =>
                row.dimension === 'connection' ? <ConnectionStatus value={row.value} context={context} /> : null,
            },
          ]
        : []),
      ...state.cols.map((key): TableColumn<PivotRow> => ({
        key,
        header: measureInfo[key].label,
        ...(measureInfo[key].hint ? { hint: measureInfo[key].hint } : {}),
        align: 'right',
        width: 116,
        sort: true,
        aggregate: 'sum',
        formatAggregate: measureInfo[key].format,
        cell: row => (
          <span
            className={
              key === 'planValueUsd'
                ? 'text-muted-foreground tabular-nums'
                : key === 'fallbacks' && row.fallbacks
                  ? 'font-medium text-warning tabular-nums'
                  : 'tabular-nums'
            }
          >
            {measureInfo[key].format(row[key])}
          </span>
        ),
      })),
    ],
    // `context` changes every render; the columns depend only on these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.groups.join(','), state.cols.join(','), showStatus, dims],
  );
  const allOpen = expanded === true;
  return (
    <section aria-labelledby="usage-table" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="usage-table" className="text-sm font-medium">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </h2>
        {state.groups.length > 1 && (
          <span className="hidden md:inline-flex">
            <Button variant="ghost" size="sm" onClick={() => setExpanded(allOpen ? {} : true)}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </Button>
          </span>
        )}
      </div>
      <MobileRows rows={rows} context={context} />
      <div className="hidden md:block">
        <Table
          key={state.groups.join(',')}
          aria-label="Usage breakdown"
          data={rows}
          columns={columns}
          getRowId={row => row.id}
          getSubRows={row => row.subRows}
          narrow="scroll"
          state={{ sorting: state.sorting, expanded }}
          onStateChange={next => {
            setExpanded(next.expanded);
            const sort = next.sorting[0];
            const current = state.sorting[0];
            if (sort && (sort.id !== current?.id || sort.desc !== current.desc))
              context.set({ sort: `${sort.id}:${sort.desc ? 'desc' : 'asc'}` });
          }}
          empty="No usage matches this search."
        />
      </div>
    </section>
  );
}

/** Phones: one card per group with its measures, and the second level folded inside. */
function MobileRows({ rows, context }: { rows: PivotRow[]; context: Context }) {
  const { state } = context;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const total = totalOf(rows);
  const [primary, ...rest] = state.cols;
  if (!rows.length) return <p className="text-sm text-muted-foreground md:hidden">No usage matches this search.</p>;
  const values = (row: UsageMeasures, keys: UsageMeasure[]) => (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {keys.map(key => (
        <div key={key} className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">{measureInfo[key].label}</dt>
          <dd className="tabular-nums">{measureInfo[key].format(row[key])}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <ul className="space-y-2 md:hidden" aria-label="Usage breakdown">
      {sortRows(rows, state.sorting).map(row => {
        const expanded = open.has(row.id);
        return (
          <li key={row.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 font-medium">
                <RowLabel row={row} context={context} />
              </span>
              {primary && (
                <span className="shrink-0 text-right">
                  <span className="block font-medium tabular-nums">{measureInfo[primary].format(row[primary])}</span>
                  <span className="block text-xs text-muted-foreground">{measureInfo[primary].label}</span>
                </span>
              )}
            </div>
            {row.dimension === 'connection' && <ConnectionStatus value={row.value} context={context} />}
            {values(row, rest)}
            {row.subRows?.length ? (
              <div className="border-t pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded}
                  onClick={() =>
                    setOpen(current => {
                      const next = new Set(current);
                      if (expanded) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  {expanded ? <ChevronDownIcon size="sm" aria-hidden /> : <ChevronRightIcon size="sm" aria-hidden />}
                  {context.dims[row.subRows[0]!.dimension].label} ({row.subRows.length})
                </Button>
                {expanded && (
                  <ul className="mt-1 space-y-2">
                    {sortRows(row.subRows, state.sorting).map(sub => (
                      <li key={sub.id} className="space-y-1 rounded-md bg-muted/40 p-2">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <RowLabel row={sub} context={context} />
                          {primary && (
                            <span className="shrink-0 tabular-nums">{measureInfo[primary].format(sub[primary])}</span>
                          )}
                        </div>
                        {sub.dimension === 'connection' && <ConnectionStatus value={sub.value} context={context} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
      <li className="space-y-2 rounded-lg border bg-muted/40 p-3">
        <div className="flex items-center justify-between gap-3 font-medium">
          <span>Total</span>
          {primary && <span className="tabular-nums">{measureInfo[primary].format(total[primary])}</span>}
        </div>
        {values(total, rest)}
      </li>
    </ul>
  );
}

function downloadCsv(rows: PivotRow[], context: Context) {
  const csv = usageCsv(rows, context.state, dimension => context.dims[dimension].label);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `usage-${context.state.from}-to-${context.state.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
