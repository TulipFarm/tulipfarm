import { useState } from 'react';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Switch } from '@tulipfarm/sprout/switch';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { Disclosure } from '@/components/disclosure';
import { ToolGroup, type ToolRowView } from '@/features/integrations/tools-list';
import type { McpApi } from './api';
import type { IntegrationDetail } from './contracts';
import { useMcpCommand } from './state';

type Tool = IntegrationDetail['tools'][number];
type Filter = 'all' | 'reads' | 'changes' | 'off';

/** "list_issues" reads as "List issues" when the server gives no title. */
export const toolTitle = (tool: Pick<Tool, 'name' | 'title'>) => {
  if (tool.title?.trim()) return tool.title.trim();
  const words = tool.name.replace(/[_\-.]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : tool.name;
};

const usable = (tool: Tool) => tool.compatibility === 'compatible';
const unsupportedReason = (reason: string | null) =>
  reason === 'required-task'
    ? 'Only runs as a long background task, which TulipFarm doesn’t support yet'
    : reason?.startsWith('schema') || reason === 'unsupported-schema'
      ? 'Its inputs are too complex for TulipFarm to fill in yet'
      : 'TulipFarm can’t run this tool yet';

/** Every tool a server offers. Switches and "Ask first" save as soon as they change. */
export function McpToolsTab({
  api,
  detail,
  blocked,
  refresh,
}: {
  api: McpApi;
  detail: IntegrationDetail;
  blocked: boolean;
  refresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<Tool[] | null>(null);
  const command = useMcpCommand();
  const tools = pending ?? detail.tools;
  const editable = detail.integration.canManage && !blocked && !command.busy;
  const save = (name: string, patch: Partial<Pick<Tool, 'enabled' | 'standingException'>>) => {
    const next = tools.map(tool => {
      if (tool.name !== name) return tool;
      const enabled = patch.enabled ?? tool.enabled;
      return { ...tool, enabled, standingException: enabled && (patch.standingException ?? tool.standingException) };
    });
    setPending(next);
    void command.run(
      () =>
        api.integrationCommand(detail.integration.id, 'tools', {
          requestId: crypto.randomUUID(),
          expectedVersion: detail.integration.version,
          tools: next.map(({ name, revision, enabled, standingException }) => ({
            name,
            revision,
            enabled,
            standingException,
          })),
        }),
      async () => {
        await refresh();
        setPending(null);
      },
    );
  };
  const needle = query.trim().toLowerCase();
  const matches = tools.filter(
    tool =>
      (!needle || `${toolTitle(tool)} ${tool.name} ${tool.description}`.toLowerCase().includes(needle)) &&
      (filter === 'all' ||
        (filter === 'reads' && tool.readOnly) ||
        (filter === 'changes' && !tool.readOnly) ||
        (filter === 'off' && !tool.enabled)),
  );
  const count = (keep: (tool: Tool) => boolean) => tools.filter(keep).length;
  const row = (tool: Tool): ToolRowView => ({
    key: tool.name,
    title: toolTitle(tool),
    description: usable(tool) ? tool.description || 'No description' : unsupportedReason(tool.reason),
    off: !tool.enabled,
    badges: (
      <>
        {tool.review === 'changed' && <Badge variant="warning">Changed</Badge>}
        {tool.destructive && <Badge variant="destructive">Deletes</Badge>}
      </>
    ),
    control: (
      <Switch
        size="sm"
        aria-label={`Use ${toolTitle(tool)}`}
        checked={tool.enabled}
        disabled={!editable || !usable(tool)}
        onCheckedChange={checked => save(tool.name, { enabled: checked === true })}
      />
    ),
    setting: tool.enabled ? (
      <span className="hidden shrink-0 sm:block">
        <Select
          value={tool.standingException ? 'alone' : 'ask'}
          disabled={!editable}
          onValueChange={value => save(tool.name, { standingException: value === 'alone' })}
        >
          <SelectTrigger size="sm" aria-label={`When ${toolTitle(tool)} runs`}>
            <SelectValue>{tool.standingException ? 'Runs on its own' : 'Asks first'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">Asks first</SelectItem>
            <SelectItem value="alone">Runs on its own</SelectItem>
          </SelectContent>
        </Select>
      </span>
    ) : undefined,
    details: <ToolDetails tool={tool} />,
  });
  const groups = [
    {
      id: 'reads',
      title: 'Reads data',
      note: 'Runs on its own',
      tools: matches.filter(tool => usable(tool) && tool.readOnly),
    },
    {
      id: 'changes',
      title: 'Changes data',
      note: 'Asks you in chat first, unless you choose otherwise',
      tools: matches.filter(tool => usable(tool) && !tool.readOnly),
    },
    {
      id: 'unsupported',
      title: 'Can’t be used',
      note: 'TulipFarm can’t run these yet',
      tools: matches.filter(tool => !usable(tool)),
    },
  ];
  if (!detail.tools.length)
    return (
      <p className="max-w-prose text-muted-foreground">
        {detail.integration.name} didn’t offer any tools. Check that the account you signed in with has access, then
        look for tools again in Advanced.
      </p>
    );
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchField label={`Search ${tools.length} tools`} value={query} onChange={setQuery} />
        <div className="shrink-0 overflow-x-auto">
          <ToggleGroup
            aria-label="Show tools"
            variant="outline"
            size="sm"
            spacing={0}
            value={[filter]}
            onValueChange={value => value[0] && setFilter(value[0] as Filter)}
          >
            <ToggleGroupItem value="all">All {tools.length}</ToggleGroupItem>
            <ToggleGroupItem value="reads">Reads {count(tool => tool.readOnly)}</ToggleGroupItem>
            <ToggleGroupItem value="changes">Changes data {count(tool => !tool.readOnly)}</ToggleGroupItem>
            <ToggleGroupItem value="off">Off {count(tool => !tool.enabled)}</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {groups.map(group => (
        <ToolGroup
          key={group.id}
          id={group.id}
          title={group.title}
          note={group.note}
          rows={group.tools.map(row)}
          expanded={!!needle}
        />
      ))}
      {!matches.length && <p className="text-sm text-muted-foreground">No tools match.</p>}
      <div role="status" className="flex min-h-8 flex-wrap items-center gap-3 text-sm text-muted-foreground">
        {!detail.integration.canManage ? (
          'Only the person who connected it or a manager can change its tools.'
        ) : command.state.kind === 'sending' ? (
          'Saving…'
        ) : command.state.kind === 'error' ? (
          <>
            <span className="text-destructive">{command.state.message}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPending(null);
                command.reset();
                void refresh();
              }}
            >
              Check again
            </Button>
          </>
        ) : command.state.kind === 'success' ? (
          'Saved'
        ) : (
          'Changes save as you make them.'
        )}
      </div>
    </div>
  );
}

type Field = { name: string; about: string; required: boolean };
function fieldsOf(schema: unknown): Field[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const needed = new Set(Array.isArray(required) ? required.filter(item => typeof item === 'string') : []);
  return Object.entries(properties).map(([name, value]) => {
    const about =
      value && typeof value === 'object' && 'description' in value && typeof value.description === 'string'
        ? value.description
        : '';
    return { name, about, required: needed.has(name) };
  });
}

function ToolDetails({ tool }: { tool: Tool }) {
  const fields = fieldsOf(tool.inputSchema);
  return (
    <div className="space-y-3 text-sm">
      {tool.description && <p className="max-w-prose whitespace-pre-wrap break-words">{tool.description}</p>}
      {fields.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground">What the agent fills in</p>
          <dl className="space-y-1">
            {fields.map(field => (
              <div key={field.name} className="flex gap-6">
                <dt className="w-32 shrink-0 truncate font-mono text-xs leading-5" title={field.name}>
                  {field.name}
                </dt>
                <dd className="min-w-0 text-foreground-secondary">
                  {field.about || '—'}
                  {field.required && <span className="text-muted-foreground"> · required</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Tool name <code className="font-mono">{tool.name}</code>
      </p>
      <Disclosure title="Full definition">
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }, null, 2)}
        </pre>
      </Disclosure>
    </div>
  );
}
