import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Add } from 'reicon-react/icons/Add';
import { Download } from 'reicon-react/icons/Download';
import { Eye } from 'reicon-react/icons/Eye';
import { Filter } from 'reicon-react/icons/Filter';
import { Grid } from 'reicon-react/icons/Grid';
import { Kanban } from 'reicon-react/icons/Kanban';
import { List } from 'reicon-react/icons/List';
import { Search } from 'reicon-react/icons/Search';
import { SliderHorizontal } from 'reicon-react/icons/SliderHorizontal';
import {
  describeWhere,
  kindQueryOps,
  opLabel,
  printRsql,
  queryCapabilities,
  queryLimits,
  rsqlOperators,
  type QueryIssue,
  type QueryMetric,
  type QueryOp,
  type QueryRule,
} from '@tulipfarm/tables/query';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@tulipfarm/sprout/popover';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { SelectionSlot } from '@tulipfarm/sprout/selection-slot';
import { ToolbarStatus } from '@tulipfarm/sprout/toolbar-status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { exportCsv, exportRowCap } from './table-export';
import { TableRequestError } from './request-state';
import { useTableCapabilities } from './hooks';
import { TableQueryRejected, type TableApi, type TableDefinition, type Translation } from './api';
import { localDateTime, useUrlDraft, utcTimestamp } from './row-query';
import {
  draftKey,
  draftRules,
  emptyDraft,
  filterChips,
  fromDraft,
  linkQueryCharacters,
  listOp,
  metricKinds,
  metricLabels,
  rsqlToDraft,
  rulesWhere,
  sortable,
  summarized,
  valueless,
  viewRequest,
  type DraftGroup,
  type DraftNode,
  type DraftRule,
  type Layout,
  type QueryDefinition,
  type SearchMode,
  type TableView,
  queryDefinition,
} from './table-view';

type Definition = QueryDefinition;
type Field = Definition['fields'][number];
type Props = {
  api: TableApi;
  table: TableDefinition;
  view: TableView;
  references: Record<string, string>;
  apply: (view: TableView) => void;
  disabled: boolean;
};
type ToolbarProps = Props & {
  layout: Layout;
  changeLayout: (layout: Layout) => void;
  mode: SearchMode | undefined;
  changeMode: (mode: SearchMode) => void;
  actions?: ReactNode;
  selection?: ReactNode;
};

const filterable = (definition: Definition) => definition.fields.filter(field => kindQueryOps[field.kind].length > 0);
const fieldOf = (definition: Definition, id: string) => definition.fields.find(field => field.id === id);
const tooLong = 'This search is too long to keep in the page link. Remove some conditions and apply it again.';
const layouts = [
  { value: 'table', label: 'Table', icon: Grid },
  { value: 'board', label: 'Board', icon: Kanban },
  { value: 'list', label: 'List', icon: List },
] as const;

/** Layout, search, column, summary, and export controls, then the applied filters as chips. Every applied change is written to the URL. */
export function QueryBar({
  api,
  table,
  view,
  references,
  apply,
  disabled,
  layout,
  changeLayout,
  mode,
  changeMode,
  actions,
  selection,
}: ToolbarProps) {
  const definition = queryDefinition(table.definition);
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="@container/queries space-y-3">
      <div className="flex min-w-0 flex-col gap-2 @3xl/queries:flex-row @3xl/queries:items-center">
        <ToggleGroup
          aria-label="Layout"
          variant="outline"
          size="sm"
          spacing={0}
          value={[layout]}
          disabled={disabled}
          onValueChange={value => {
            const next = layouts.find(item => item.value === value[0]);
            if (next) changeLayout(next.value);
          }}
        >
          {layouts.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value}>
              <Icon size={14} aria-hidden="true" />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="@container/selection min-w-0 flex-1">
          <SelectionSlot active={!!selection} selection={selection}>
            <fieldset
              disabled={disabled}
              aria-label="Table tools"
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <SearchMenu
                api={api}
                table={table}
                view={view}
                references={references}
                apply={apply}
                disabled={disabled}
                mode={mode}
                changeMode={changeMode}
              />
              {!(layout === 'table' && summarized(view)) && (
                <ColumnsMenu definition={definition} view={view} apply={apply} disabled={disabled} />
              )}
              {layout === 'table' && (
                <SummaryMenu definition={definition} view={view} apply={apply} disabled={disabled} />
              )}
              <ExportButton api={api} table={table} view={view} disabled={disabled} />
              {actions}
            </fieldset>
          </SelectionSlot>
        </div>
      </div>
      <FilterChips
        api={api}
        table={table}
        view={view}
        references={references}
        apply={apply}
        disabled={disabled}
        advanced={advanced}
        toggleAdvanced={() => setAdvanced(open => !open)}
      />
      {advanced && (
        <AdvancedFilters
          key={view.where}
          api={api}
          table={table}
          view={view}
          references={references}
          apply={apply}
          disabled={disabled}
          close={() => setAdvanced(false)}
        />
      )}
    </div>
  );
}

function SearchMenu({
  api,
  table,
  view,
  references,
  apply,
  disabled,
  mode,
  changeMode,
}: Props & { mode: SearchMode | undefined; changeMode: (mode: SearchMode) => void }) {
  const definition = queryDefinition(table.definition);
  const searchable = definition.fields.some(field => field.kind === 'text');
  const tab = mode === 'text' && !searchable ? 'rsql' : (mode ?? (searchable ? 'text' : 'rsql'));
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant={view.search ? 'secondary' : 'outline'} size="sm" disabled={disabled} />}>
        <Search size={14} aria-hidden="true" />
        {view.search ? (
          <span title={view.search} className="max-w-40 truncate">
            “{view.search}”
          </span>
        ) : (
          'Search'
        )}
      </PopoverTrigger>
      <PopoverContent size="panel" align="end">
        <Tabs value={tab} onValueChange={value => changeMode(value as SearchMode)}>
          <div className="border-b border-border px-3 pt-2">
            <TabsList variant="line">
              {searchable && <TabsTrigger value="text">Text</TabsTrigger>}
              <TabsTrigger value="ai">Ask AI</TabsTrigger>
              <TabsTrigger value="rsql">RSQL</TabsTrigger>
            </TabsList>
          </div>
          {searchable && (
            <TabsContent value="text">
              <div
                className="p-4"
                onKeyDownCapture={event => {
                  // Escape closes the search and keeps its text, rather than clearing it first.
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }}
              >
                <TextSearch view={view} apply={apply} />
              </div>
            </TabsContent>
          )}
          <TabsContent value="ai">
            <div className="p-4">
              <AskAi
                api={api}
                table={table}
                view={view}
                apply={next => {
                  if (next.where.length <= linkQueryCharacters) apply(next);
                }}
                disabled={disabled}
              />
            </div>
          </TabsContent>
          <TabsContent value="rsql">
            <div className="p-4">
              <RsqlSearch
                key={view.where}
                api={api}
                table={table}
                view={view}
                references={references}
                apply={apply}
                disabled={disabled}
              />
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

function TextSearch({ view, apply }: Pick<Props, 'view' | 'apply'>) {
  const [search, setSearch] = useUrlDraft(view.search ?? '', next =>
    apply({ ...view, search: next.trim() || undefined }),
  );
  return (
    <div className="space-y-2">
      <SearchField
        id="rows-search"
        label="Search rows"
        value={search}
        maxLength={queryLimits.searchCharacters}
        onChange={setSearch}
        placeholder="Search text fields"
      />
      <p className="text-sm text-muted-foreground">
        Finds rows whose text fields contain these words. Filters still apply.
      </p>
    </div>
  );
}

function RsqlSearch({ api, table, view, references, apply, disabled }: Props) {
  const [text, setText] = useState(view.where);
  const [issues, setIssues] = useState<QueryIssue[]>([]);
  const [note, setNote] = useState('');
  const [checking, setChecking] = useState(false);
  const applyText = async () => {
    if (text.length > linkQueryCharacters) {
      setNote(tooLong);
      return;
    }
    setChecking(true);
    setIssues([]);
    setNote('');
    try {
      const checked = await api.validateQuery(
        table,
        viewRequest({ ...view, where: text }),
        AbortSignal.timeout(15_000),
      );
      Object.assign(references, checked.references);
      if (checked.rsql.length > linkQueryCharacters) setNote(tooLong);
      else apply({ ...view, where: checked.rsql });
    } catch (error) {
      if (error instanceof TableQueryRejected) setIssues(error.issues);
      else
        setNote(
          error instanceof TableRequestError
            ? error.message
            : 'The search could not be checked. Check your connection and try again.',
        );
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="space-y-3">
      <Field
        label="RSQL query"
        optional
        helper="A field name, an operator, and a value. Applied filters appear as chips."
        error={
          text.length > linkQueryCharacters
            ? `${text.length.toLocaleString()} of ${linkQueryCharacters.toLocaleString()} characters`
            : undefined
        }
      >
        <div className="font-mono">
          <Textarea
            value={text}
            disabled={disabled || checking}
            spellCheck={false}
            onChange={event => {
              setText(event.target.value);
              setIssues([]);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void applyText();
              }
            }}
            placeholder="status==Open and priority=in=(High,Urgent)"
          />
        </div>
      </Field>
      {issues.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {issues.map((issue, index) => (
                <li key={index}>
                  {issue.message}
                  {issue.choices?.length ? ` Choices: ${issue.choices.map(choice => choice.label).join(', ')}.` : ''}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {note && (
        <p role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled || checking} aria-busy={checking} onClick={() => void applyText()}>
          {checking ? (
            <>
              <Spinner />
              Checking…
            </>
          ) : (
            'Apply RSQL'
          )}
        </Button>
        {view.where && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || checking}
            onClick={() => apply({ ...view, where: '' })}
          >
            Clear filters
          </Button>
        )}
      </div>
      <RsqlExamples api={api} table={table} />
    </div>
  );
}

/** One chip per top-level AND condition. Searches with OR or nested groups show one chip that opens Advanced. */
function FilterChips({
  api,
  table,
  view,
  references,
  apply,
  disabled,
  advanced,
  toggleAdvanced,
}: Props & { advanced: boolean; toggleAdvanced: () => void }) {
  const definition = queryDefinition(table.definition);
  const chips = filterChips(definition, view.where);
  const labels = useRef<Record<string, string>>({});
  Object.assign(labels.current, references);
  const [note, setNote] = useState('');
  const save = (rules: QueryRule[]) => {
    const where = rulesWhere(definition, rules);
    if (where.length > linkQueryCharacters) {
      setNote(tooLong);
      return false;
    }
    setNote('');
    apply({ ...view, where });
    return true;
  };
  const rules = chips.kind === 'chips' ? chips.rules : [];
  return (
    <div className="space-y-1">
      <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
        {chips.kind === 'advanced' ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            aria-expanded={advanced}
            aria-controls="table-query-panel"
            onClick={toggleAdvanced}
          >
            <Filter size={14} aria-hidden="true" />
            Advanced filter · {chips.conditions} {chips.conditions === 1 ? 'condition' : 'conditions'}
          </Button>
        ) : (
          rules.map((rule, index) => (
            <RuleChip
              key={`${index}:${rule.fieldId}:${rule.op}:${rule.values.join(',')}`}
              api={api}
              table={table}
              rule={rule}
              label={describeWhere(definition, rule, labels.current)}
              labels={labels.current}
              disabled={disabled}
              save={next => save(rules.map((item, at) => (at === index ? next : item)))}
              remove={() => save(rules.filter((_, at) => at !== index))}
            />
          ))
        )}
        {chips.kind === 'chips' && rules.length < queryLimits.comparisons && (
          <RuleChip
            api={api}
            table={table}
            labels={labels.current}
            disabled={disabled}
            save={next => save([...rules, next])}
          />
        )}
        <Button
          variant="link"
          size="sm"
          disabled={disabled}
          aria-expanded={advanced}
          aria-controls="table-query-panel"
          onClick={toggleAdvanced}
        >
          Advanced…
        </Button>
        {view.where && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => apply({ ...view, where: '' })}>
            Clear filters
          </Button>
        )}
      </div>
      {note && (
        <p role="status" className="text-sm text-destructive">
          {note}
        </p>
      )}
    </div>
  );
}

/** Edits one condition in a popover. Without a rule it adds a new condition. */
function RuleChip({
  api,
  table,
  rule,
  label,
  labels,
  disabled,
  save,
  remove,
}: {
  api: TableApi;
  table: TableDefinition;
  rule?: QueryRule;
  label?: string;
  labels: Record<string, string>;
  disabled: boolean;
  save: (rule: QueryRule) => boolean;
  remove?: () => void;
}) {
  const definition = queryDefinition(table.definition);
  const first = filterable(definition)[0];
  const fresh = (): DraftRule | null => (rule ? { ...rule, key: draftKey() } : first ? newRule(first) : null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(fresh);
  const [problem, setProblem] = useState<string | undefined>();
  if (!draft) return null;
  const toggle = (next: boolean) => {
    setOpen(next);
    if (next) {
      setDraft(fresh());
      setProblem(undefined);
    }
  };
  const commit = () => {
    const result = fromDraft(definition, { key: 'chip', kind: 'all', nodes: [draft] });
    const where = result.where;
    const next = where?.kind === 'rule' ? where : where?.nodes[0];
    if (Object.keys(result.problems).length || next?.kind !== 'rule') {
      setProblem(Object.values(result.problems)[0] ?? 'Finish this condition.');
      return;
    }
    if (save(next)) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger
        render={
          rule ? (
            <Button variant="outline" size="sm" disabled={disabled} aria-label={`Edit filter: ${label}`} />
          ) : (
            <Button variant="ghost" size="sm" disabled={disabled} />
          )
        }
      >
        {rule ? (
          <span title={label} className="max-w-64 truncate">
            {label}
          </span>
        ) : (
          <>
            <Add size={14} aria-hidden="true" />
            Add filter
          </>
        )}
      </PopoverTrigger>
      <PopoverContent size="panel" align="start">
        <div className="space-y-3 p-4">
          <PopoverHeader>
            <PopoverTitle>{rule ? 'Edit filter' : 'Add filter'}</PopoverTitle>
          </PopoverHeader>
          <RuleEditor
            api={api}
            table={table}
            rule={draft}
            problem={problem}
            labels={labels}
            disabled={disabled}
            change={next => {
              setDraft(next);
              setProblem(undefined);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={disabled} onClick={commit}>
              {rule ? 'Apply' : 'Add filter'}
            </Button>
            {remove && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  remove();
                  setOpen(false);
                }}
              >
                Remove filter
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AdvancedFilters({ api, table, view, references, apply, disabled, close }: Props & { close: () => void }) {
  const definition = queryDefinition(table.definition);
  const initial = rsqlToDraft(definition, view.where);
  const [draft, setDraft] = useState<DraftGroup>('draft' in initial ? initial.draft : emptyDraft());
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [note, setNote] = useState(
    'issues' in initial ? 'These filters could not be opened here. Edit them in Search › RSQL.' : '',
  );
  const labels = useRef<Record<string, string>>({ ...references });
  const commit = (where: string) => {
    if (where.length > linkQueryCharacters) {
      setNote(tooLong);
      return;
    }
    setNote('');
    apply({ ...view, where });
  };
  const applyFilters = () => {
    const result = fromDraft(definition, draft);
    setProblems(result.problems);
    if (Object.keys(result.problems).length) return;
    commit(printRsql(definition, result.where));
  };
  return (
    <section
      id="table-query-panel"
      aria-label="Advanced filters"
      className="space-y-4 rounded-xl border border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Advanced filters</h3>
        <Button variant="ghost" size="sm" onClick={close}>
          Close
        </Button>
      </div>
      <GroupEditor
        api={api}
        table={table}
        group={draft}
        root
        depth={1}
        problems={problems}
        labels={labels.current}
        disabled={disabled}
        change={next => {
          setDraft(next as DraftGroup);
          setProblems({});
        }}
        remove={() => {}}
      />
      {Object.keys(problems).length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>Finish or remove the highlighted conditions, then apply again.</AlertDescription>
        </Alert>
      )}
      {note && (
        <p role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={applyFilters}>
          Apply filters
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setDraft(emptyDraft());
            setProblems({});
            if (view.where) commit('');
          }}
        >
          Clear filters
        </Button>
      </div>
    </section>
  );
}

function ExportButton({
  api,
  table,
  view,
  disabled,
}: {
  api: TableApi;
  table: TableDefinition;
  view: TableView;
  disabled: boolean;
}) {
  const [rows, setRows] = useState<number | null>(null);
  const [note, report] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async () => {
    const next = new AbortController();
    controller.current = next;
    setRows(0);
    report('');
    try {
      const result = await exportCsv(api, table, view, setRows, next.signal);
      report(
        result.capped
          ? `Exported the first ${exportRowCap.toLocaleString('en-US')} rows. Narrow the search to export the rest.`
          : `Exported ${result.rows.toLocaleString('en-US')} ${result.rows === 1 ? 'row' : 'rows'}.`,
      );
    } catch (error) {
      if (!next.signal.aborted)
        report(
          `Export failed. ${error instanceof TableRequestError ? error.message : 'Check your connection and try again.'}`,
        );
    } finally {
      if (controller.current === next) {
        controller.current = null;
        setRows(null);
      }
    }
  };
  return (
    <div className="grid w-28 shrink-0">
      {rows !== null ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            controller.current?.abort();
            report('Export cancelled.');
          }}
          aria-label={`Exporting ${rows} rows. Cancel export`}
        >
          <Spinner />
          Cancel export
        </Button>
      ) : note ? (
        <ToolbarStatus
          label={note.startsWith('Export failed') ? 'Export failed' : 'Export result'}
          message={note}
          error={note.startsWith('Export failed')}
        >
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run()}>
            {note.startsWith('Export failed') ? 'Retry export' : 'Export again'}
          </Button>
        </ToolbarStatus>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run()}>
          <Download size={14} aria-hidden="true" />
          Export
        </Button>
      )}
    </div>
  );
}

function RsqlExamples({ api, table }: Pick<Props, 'api' | 'table'>) {
  const read = useTableCapabilities(api, table);
  const fields = (
    read.state.kind === 'ready' && !read.state.error
      ? read.state.data
      : queryCapabilities(queryDefinition(table.definition))
  ).fields.filter(field => field.ops.length);
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Field names and operators</CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 pt-2 text-sm text-muted-foreground">
          <p>
            Join conditions with <span className="font-mono">and</span> or <span className="font-mono">or</span> (or{' '}
            <span className="font-mono">;</span> and <span className="font-mono">,</span>). Use parentheses to group.
            Quote values with spaces: <span className="font-mono">"In progress"</span>.
          </p>
          <ul className="space-y-1">
            {fields.map(field => (
              <li key={field.fieldId}>
                <span className="font-mono text-foreground">{field.selector}</span> {field.label}:{' '}
                {field.ops.map(op => (
                  <span key={op} className="mr-2 font-mono">
                    {rsqlOperators[op]}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {fields.some(field => field.ops.includes('is-me')) && (
            <p>
              Use <span className="font-mono">=isme=true</span> to match your workspace member. Shared views resolve it
              for the person reading them.
            </p>
          )}
          <CapabilitiesFeedback read={read} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function GroupEditor({
  api,
  table,
  group,
  root,
  depth,
  problems,
  labels,
  disabled,
  change,
  remove,
}: {
  api: TableApi;
  table: TableDefinition;
  group: DraftGroup;
  root?: boolean;
  depth: number;
  problems: Record<string, string>;
  labels: Record<string, string>;
  disabled: boolean;
  change: (node: DraftNode) => void;
  remove: () => void;
}) {
  const definition = queryDefinition(table.definition);
  const first = filterable(definition)[0];
  const full = draftRules(group) >= queryLimits.comparisons;
  const update = (index: number, node: DraftNode) =>
    change({ ...group, nodes: group.nodes.map((item, at) => (at === index ? node : item)) });
  const drop = (index: number) => change({ ...group, nodes: group.nodes.filter((_, at) => at !== index) });
  const addRule = () => {
    if (first) change({ ...group, nodes: [...group.nodes, newRule(first)] });
  };
  const addGroup = () => {
    if (first)
      change({
        ...group,
        nodes: [
          ...group.nodes,
          { key: draftKey(), kind: group.kind === 'all' ? 'any' : 'all', nodes: [newRule(first)] },
        ],
      });
  };
  return (
    <div
      role="group"
      aria-label={root ? 'Conditions' : 'Condition group'}
      className={root ? 'space-y-3' : 'space-y-3 rounded-lg border border-dashed border-border p-3'}
    >
      {group.nodes.length > 1 || !root ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Match</span>
          <Select
            value={group.kind}
            disabled={disabled}
            onValueChange={value => change({ ...group, kind: value === 'any' ? 'any' : 'all' })}
          >
            <SelectTrigger size="sm" aria-label="Match all or any">
              <SelectValue>{group.kind === 'all' ? 'all conditions' : 'any condition'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all conditions</SelectItem>
              <SelectItem value="any">any condition</SelectItem>
            </SelectContent>
          </Select>
          {!root && (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={remove}>
              Remove group
            </Button>
          )}
        </div>
      ) : null}
      {!group.nodes.length && root && (
        <p className="text-sm text-muted-foreground">No conditions. Every row is shown.</p>
      )}
      {group.nodes.map((node, index) => (
        <div key={node.key} className="space-y-1">
          {index > 0 && (
            <p className="text-xs font-medium uppercase text-muted-foreground">{group.kind === 'all' ? 'and' : 'or'}</p>
          )}
          {node.kind === 'rule' ? (
            <RuleEditor
              api={api}
              table={table}
              rule={node}
              problem={problems[node.key]}
              labels={labels}
              disabled={disabled}
              change={next => update(index, next)}
              remove={() => drop(index)}
            />
          ) : (
            <GroupEditor
              api={api}
              table={table}
              group={node}
              depth={depth + 1}
              problems={problems}
              labels={labels}
              disabled={disabled}
              change={next => update(index, next)}
              remove={() => drop(index)}
            />
          )}
        </div>
      ))}
      {problems[group.key] && <p className="text-sm text-destructive">{problems[group.key]}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={disabled || full || !first} onClick={addRule}>
          <Add size={14} aria-hidden="true" />
          Add condition
        </Button>
        {depth < queryLimits.depth - 1 && (
          <Button variant="ghost" size="sm" disabled={disabled || full || !first} onClick={addGroup}>
            <Add size={14} aria-hidden="true" />
            Add group
          </Button>
        )}
      </div>
    </div>
  );
}

function newRule(field: Field): DraftRule {
  return { key: draftKey(), kind: 'rule', fieldId: field.id, op: kindQueryOps[field.kind][0] ?? 'eq', values: [] };
}

function RuleEditor({
  api,
  table,
  rule,
  problem,
  labels,
  disabled,
  change,
  remove,
}: {
  api: TableApi;
  table: TableDefinition;
  rule: DraftRule;
  problem: string | undefined;
  labels: Record<string, string>;
  disabled: boolean;
  change: (rule: DraftRule) => void;
  remove?: () => void;
}) {
  const definition = queryDefinition(table.definition);
  const fields = filterable(definition);
  const field = fieldOf(definition, rule.fieldId);
  const read = useTableCapabilities(api, table);
  const available = read.state.kind === 'ready' && !read.state.error ? read.state.data : queryCapabilities(definition);
  const ops = available.fields.find(item => item.fieldId === rule.fieldId)?.ops ?? [];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-start gap-2">
        <Select
          value={rule.fieldId}
          disabled={disabled}
          onValueChange={value => {
            const next = fieldOf(definition, value ?? '');
            if (next) change(newRule(next));
          }}
        >
          <SelectTrigger size="sm" aria-label="Field" aria-invalid={!!problem}>
            <SelectValue>{field?.label ?? 'Choose field'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {fields.map(item => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field && (
          <Select
            value={rule.op}
            disabled={disabled}
            onValueChange={value => {
              const op = ops.find(item => item === value) ?? rule.op;
              change({
                ...rule,
                op,
                values: valueless(op)
                  ? []
                  : listOp(op) || listOp(rule.op) === listOp(op)
                    ? rule.values
                    : rule.values.slice(0, 1),
              });
            }}
          >
            <SelectTrigger size="sm" aria-label="Condition">
              <SelectValue>{opLabel(field, rule.op)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ops.map(op => (
                <SelectItem key={op} value={op}>
                  {opLabel(field, op)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {field && !valueless(rule.op) && (
          <ValueEditor
            api={api}
            table={table}
            field={field}
            op={rule.op}
            values={rule.values}
            labels={labels}
            invalid={!!problem}
            disabled={disabled}
            change={values => change({ ...rule, values })}
          />
        )}
        {remove && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove condition on ${field?.label ?? 'field'}`}
            onClick={remove}
          >
            Remove
          </Button>
        )}
      </div>
      {rule.op === 'is-me' && (
        <p className="text-sm text-muted-foreground">Matches your workspace member each time you open this view.</p>
      )}
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      <CapabilitiesFeedback read={read} />
    </div>
  );
}

function CapabilitiesFeedback({ read }: { read: ReturnType<typeof useTableCapabilities> }) {
  if (read.state.kind === 'loading')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking available filters…
      </p>
    );
  if (read.state.kind === 'unavailable')
    return (
      <p role="alert" className="text-sm text-destructive">
        Filter access is unavailable. Reload the table to check your access.
      </p>
    );
  if (read.state.kind !== 'error' && !(read.state.kind === 'ready' && read.state.error)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-destructive">
        Couldn’t check personal filters. Your draft is kept.
      </p>
      <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
        Retry filters
      </Button>
    </div>
  );
}

function ValueEditor({
  api,
  table,
  field,
  op,
  values,
  labels,
  invalid,
  disabled,
  change,
}: {
  api: TableApi;
  table: TableDefinition;
  field: Field;
  op: QueryOp;
  values: string[];
  labels: Record<string, string>;
  invalid: boolean;
  disabled: boolean;
  change: (values: string[]) => void;
}) {
  const one = values[0] ?? '';
  if (field.kind === 'relationship')
    return (
      <ReferencePicker
        api={api}
        tableId={table.id}
        field={field}
        values={values}
        labels={labels}
        disabled={disabled}
        change={change}
      />
    );
  if (field.kind === 'single-select' || field.kind === 'multi-select') {
    const options = field.options.filter(option => !option.retired || values.includes(option.id));
    const name = (id: string) => field.options.find(option => option.id === id)?.label ?? 'Unknown option';
    if (!listOp(op))
      return (
        <Select value={one} disabled={disabled} onValueChange={value => change(value ? [value] : [])}>
          <SelectTrigger size="sm" aria-label="Value" aria-invalid={invalid}>
            <SelectValue>{one ? name(one) : 'Choose option'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map(option => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} aria-invalid={invalid} />}>
          {values.length ? values.map(name).join(', ') : 'Choose options'}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {options.map(option => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={values.includes(option.id)}
                closeOnClick={false}
                onCheckedChange={checked =>
                  change(checked ? [...values, option.id] : values.filter(id => id !== option.id))
                }
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (field.kind === 'boolean')
    return (
      <Select value={one} disabled={disabled} onValueChange={value => change(value ? [value] : [])}>
        <SelectTrigger size="sm" aria-label="Value" aria-invalid={invalid}>
          <SelectValue>{one === 'true' ? 'Yes' : one === 'false' ? 'No' : 'Choose'}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  if (listOp(op))
    return (
      <div className="w-64">
        <Input
          aria-label="Values, separated by commas"
          aria-invalid={invalid}
          disabled={disabled}
          value={values.join(', ')}
          placeholder="First, Second"
          onChange={event => change(event.target.value.split(',').map(item => item.trimStart()))}
        />
      </div>
    );
  const timestamp = field.kind === 'timestamp';
  return (
    <div className="w-56">
      <Input
        aria-label="Value"
        aria-invalid={invalid}
        disabled={disabled}
        value={timestamp ? localDateTime(one) : one}
        type={field.kind === 'date' ? 'date' : timestamp ? 'datetime-local' : 'text'}
        inputMode={field.kind === 'numeric' ? 'decimal' : undefined}
        maxLength={field.kind === 'text' ? Math.min(field.maxLength, queryLimits.literalCharacters) : undefined}
        onChange={event => change([timestamp ? utcTimestamp(event.target.value) : event.target.value])}
      />
    </div>
  );
}

/** Linked rows are chosen by name and stored by ID, so renaming a row never changes the search. */
function ReferencePicker({
  api,
  tableId,
  field,
  values,
  labels,
  disabled,
  change,
}: {
  api: TableApi;
  tableId: string;
  field: Field;
  values: string[];
  labels: Record<string, string>;
  disabled: boolean;
  change: (values: string[]) => void;
}) {
  const [term, setTerm] = useState('');
  const [choices, setChoices] = useState<{ id: string; label: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [, rename] = useState(0);
  useEffect(() => {
    const missing = values.filter(id => !labels[id]);
    if (!missing.length) return;
    const controller = new AbortController();
    api
      .queryReferences(tableId, field.id, { ids: missing }, controller.signal)
      .then(found => {
        for (const item of found) labels[item.id] = item.label;
        rename(count => count + 1);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [values.join(',')]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFailed(false);
      api
        .queryReferences(tableId, field.id, term.trim() ? { search: term.trim() } : {}, controller.signal)
        .then(found => {
          for (const item of found) labels[item.id] = item.label;
          setChoices(found);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);
  const name = (id: string) => labels[id] ?? `Row ${id.slice(0, 8)}`;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
        {values.length ? values.map(name).join(', ') : `Choose ${field.label.toLowerCase()}`}
      </PopoverTrigger>
      <PopoverContent size="picker">
        <div className="space-y-2 p-3">
          <SearchField
            id={`ref-${field.id}`}
            label={`Search ${field.label}`}
            value={term}
            maxLength={255}
            onChange={setTerm}
          />
          {failed ? (
            <p className="text-sm text-destructive">Couldn’t load linked rows. Try another search.</p>
          ) : choices === null ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Spinner />
              Loading rows…
            </p>
          ) : !choices.length ? (
            <p className="text-sm text-muted-foreground">No rows match.</p>
          ) : (
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {choices.map(choice => (
                <li key={choice.id}>
                  <Button
                    variant={values.includes(choice.id) ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={values.includes(choice.id)}
                    onClick={() =>
                      change(
                        values.includes(choice.id) ? values.filter(id => id !== choice.id) : [...values, choice.id],
                      )
                    }
                  >
                    {choice.label}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SummaryMenu({
  definition,
  view,
  apply,
  disabled,
}: {
  definition: Definition;
  view: TableView;
  apply: (view: TableView) => void;
  disabled: boolean;
}) {
  const groupable = definition.fields.filter(sortable);
  const measurable = (fn: QueryMetric['fn']) =>
    fn === 'count' ? [] : definition.fields.filter(field => metricKinds[fn].includes(field.kind));
  const set = (groupBy: string[], metrics: QueryMetric[]) =>
    apply({ ...view, groupBy, metrics: groupBy.length && !metrics.length ? [{ fn: 'count' }] : metrics });
  const metricName = (metric: QueryMetric) =>
    metric.fn === 'count'
      ? 'Count'
      : `${metricLabels[metric.fn]} of ${fieldOf(definition, metric.fieldId ?? '')?.label ?? 'field'}`;
  const label = summarized(view)
    ? `Grouped${view.groupBy.length ? ` by ${view.groupBy.map(id => fieldOf(definition, id)?.label).join(', ')}` : ''}`
    : 'Customize';
  const nextMetric = (): QueryMetric => {
    const numeric = measurable('sum')[0];
    return view.metrics.some(metric => metric.fn === 'count') && numeric
      ? { fn: 'sum', fieldId: numeric.id }
      : { fn: 'count' };
  };
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant={summarized(view) ? 'secondary' : 'outline'} size="sm" disabled={disabled} />}
      >
        <SliderHorizontal size={14} aria-hidden="true" />
        {label}
      </PopoverTrigger>
      <PopoverContent size="menu">
        <div className="space-y-4 p-4">
          <PopoverHeader>
            <PopoverTitle>Group and calculate</PopoverTitle>
            <PopoverDescription>
              Summaries replace the row list. Remove every group and calculation to see rows again.
            </PopoverDescription>
          </PopoverHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">Group by</p>
            {view.groupBy.map((id, index) => (
              <div key={id} className="flex flex-wrap items-center gap-2">
                <Select
                  value={id}
                  onValueChange={value =>
                    set(
                      view.groupBy.map((item, at) => (at === index ? (value ?? item) : item)),
                      view.metrics,
                    )
                  }
                >
                  <SelectTrigger size="sm" aria-label={`Group field ${index + 1}`}>
                    <SelectValue>{fieldOf(definition, id)?.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {groupable
                      .filter(field => field.id === id || !view.groupBy.includes(field.id))
                      .map(field => (
                        <SelectItem key={field.id} value={field.id}>
                          {field.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    set(
                      view.groupBy.filter((_, at) => at !== index),
                      view.groupBy.length === 1 && view.metrics.length === 1 && view.metrics[0]?.fn === 'count'
                        ? []
                        : view.metrics,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {view.groupBy.length < queryLimits.groupBy && groupable.some(field => !view.groupBy.includes(field.id)) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  set([...view.groupBy, groupable.find(field => !view.groupBy.includes(field.id))!.id], view.metrics)
                }
              >
                <Add size={14} aria-hidden="true" />
                Add group
              </Button>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Calculate</p>
            {view.metrics.map((metric, index) => (
              <div key={`${metric.fn}.${metric.fieldId ?? ''}.${index}`} className="flex flex-wrap items-center gap-2">
                <Select
                  value={metric.fn}
                  onValueChange={value => {
                    const fn = (value ?? 'count') as QueryMetric['fn'];
                    const target = measurable(fn)[0];
                    if (fn !== 'count' && !target) return;
                    set(
                      view.groupBy,
                      view.metrics.map((item, at) =>
                        at === index
                          ? fn === 'count'
                            ? { fn }
                            : {
                                fn,
                                fieldId: measurable(fn).some(field => field.id === item.fieldId)
                                  ? item.fieldId
                                  : target!.id,
                              }
                          : item,
                      ),
                    );
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`Calculation ${index + 1}`}>
                    <SelectValue>{metricLabels[metric.fn]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(['count', 'sum', 'avg', 'min', 'max'] as const)
                      .filter(fn => fn === 'count' || measurable(fn).length)
                      .map(fn => (
                        <SelectItem key={fn} value={fn}>
                          {metricLabels[fn]}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {metric.fn !== 'count' && (
                  <Select
                    value={metric.fieldId ?? ''}
                    onValueChange={value =>
                      set(
                        view.groupBy,
                        view.metrics.map((item, at) =>
                          at === index ? { ...item, fieldId: value ?? item.fieldId } : item,
                        ),
                      )
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`Calculation field ${index + 1}`}>
                      <SelectValue>{fieldOf(definition, metric.fieldId ?? '')?.label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {measurable(metric.fn).map(field => (
                        <SelectItem key={field.id} value={field.id}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${metricName(metric)}`}
                  onClick={() =>
                    set(
                      view.groupBy,
                      view.metrics.filter((_, at) => at !== index),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {view.metrics.length < queryLimits.metrics && (
              <Button variant="outline" size="sm" onClick={() => set(view.groupBy, [...view.metrics, nextMetric()])}>
                <Add size={14} aria-hidden="true" />
                Add calculation
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ColumnsMenu({
  definition,
  view,
  apply,
  disabled,
}: {
  definition: Definition;
  view: TableView;
  apply: (view: TableView) => void;
  disabled: boolean;
}) {
  const shown = view.select ?? definition.fields.map(field => field.id);
  const toggle = (id: string, checked: boolean) => {
    const next = definition.fields
      .map(field => field.id)
      .filter(fieldId => (fieldId === id ? checked : shown.includes(fieldId)));
    if (!next.length) return;
    apply({ ...view, select: next.length === definition.fields.length ? undefined : next });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
        <Eye size={14} aria-hidden="true" />
        Columns
        {view.select && (
          <Badge variant="secondary">
            {view.select.length}/{definition.fields.length}
          </Badge>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show columns</DropdownMenuLabel>
          {definition.fields.map(field => (
            <DropdownMenuCheckboxItem
              key={field.id}
              checked={shown.includes(field.id)}
              disabled={shown.length === 1 && shown.includes(field.id)}
              closeOnClick={false}
              onCheckedChange={checked => toggle(field.id, checked)}
            >
              {field.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type AiState =
  | { kind: 'idle' }
  | { kind: 'building'; requestId: string }
  | { kind: 'lost'; requestId: string; message: string }
  | { kind: 'clarification'; message: string; choices: { label: string; prompt: string }[] }
  | { kind: 'unsupported'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'applied'; interpretation: string };

/** A cheap model writes the query; the browser checks nothing extra and runs it through the same query route as Filters and RSQL. */
function AskAi({
  api,
  table,
  view,
  apply,
  disabled,
}: {
  api: TableApi;
  table: TableDefinition;
  view: TableView;
  apply: (view: TableView) => void;
  disabled: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<AiState>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const current = useRef<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const settle = (requestId: string, result: Translation) => {
    if (current.current !== requestId) return;
    if (result.status === 'query') {
      const query = result.query;
      apply({
        ...view,
        where: result.rsql,
        search: query.search,
        sort: query.mode === 'rows' ? query.sort : view.sort,
        groupBy: query.mode === 'summary' ? query.groupBy : [],
        metrics: query.mode === 'summary' ? query.metrics : [],
      });
      setState({ kind: 'applied', interpretation: result.interpretation });
    } else if (result.status === 'clarification')
      setState({ kind: 'clarification', message: result.message, choices: result.choices });
    else if (result.status === 'unsupported') setState({ kind: 'unsupported', message: result.message });
    else if (result.status === 'pending')
      setState({ kind: 'lost', requestId, message: 'The search is still being built.' });
    else
      setState({
        kind: 'failed',
        message:
          result.message ??
          (result.status === 'uncertain'
            ? 'We couldn’t confirm whether this search finished. Submit it again.'
            : 'AI search couldn’t build this search. Filters and RSQL still work.'),
      });
  };
  const run = async (requestId: string, work: (signal: AbortSignal) => Promise<Translation>) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    current.current = requestId;
    setState({ kind: 'building', requestId });
    try {
      settle(requestId, await work(next.signal));
    } catch (error) {
      if (next.signal.aborted || current.current !== requestId) return;
      if (error instanceof TableRequestError) setState({ kind: 'failed', message: error.message });
      else setState({ kind: 'lost', requestId, message: 'The integration dropped before the search came back.' });
    }
  };
  const build = (text = prompt) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPrompt(trimmed);
    const requestId = crypto.randomUUID();
    void run(requestId, signal =>
      api.translate(
        table.id,
        {
          requestId,
          revision: table.revision,
          prompt: trimmed,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          current: viewRequest(view),
        },
        signal,
      ),
    );
  };
  const cancel = () => {
    controller.current?.abort();
    current.current = null;
    setState({ kind: 'idle' });
  };
  const building = state.kind === 'building';
  return (
    <div className="space-y-3">
      <Field
        label="Describe the rows you want"
        optional
        helper="For example: open urgent tickets from last week, newest first. AI writes the search; it never reads your rows. Each search uses a small amount of AI credit."
        counter={`${prompt.length}/2000`}
      >
        <Textarea
          value={prompt}
          maxLength={2000}
          disabled={disabled || building}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              build();
            }
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {building ? (
          <>
            <Button disabled aria-busy="true">
              <Spinner />
              Building search…
            </Button>
            <Button variant="outline" onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : (
          <Button disabled={disabled || !prompt.trim()} onClick={() => build()}>
            Build search
          </Button>
        )}
      </div>
      {state.kind === 'applied' && (
        <Alert>
          <AlertDescription>
            Applied: {state.interpretation.replace(/\.$/, '')}. Review it in Filters or RSQL, or change it like any
            other search.
          </AlertDescription>
        </Alert>
      )}
      {state.kind === 'clarification' && (
        <div className="space-y-2">
          <Alert>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            {state.choices.map(choice => (
              <Button key={choice.label} variant="outline" size="sm" onClick={() => build(choice.prompt)}>
                {choice.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {state.kind === 'unsupported' && (
        <Alert>
          <AlertDescription>{state.message} Try Filters for this search.</AlertDescription>
        </Alert>
      )}
      {state.kind === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'lost' && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>{state.message} Check its result without starting another AI search.</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const requestId = state.requestId;
              void run(requestId, signal => api.translation(table.id, requestId, signal));
            }}
          >
            Check result
          </Button>
        </div>
      )}
    </div>
  );
}
