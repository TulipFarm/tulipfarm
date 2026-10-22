import { useState } from 'react';
import { BookOpen, Bot, ChevronDown, Database, Plug, ScrollText, Wrench } from 'lucide-react';
import { agentToolRuntimeDescription, toolNameSchema } from '@tulipfarm/agents/contracts';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { toolLabels } from './labels';

export type ToolName = ReturnType<typeof toolNameSchema.parse>;

export const changingTools = new Set<ToolName>([
  'rows.create',
  'rows.update',
  'rows.delete',
  'slack.message.send',
  'slack.thread.reply',
  'slack.reaction.add',
  'google.propose',
  'google.execute',
  'github.personal.propose',
  'mcp.call',
  'skills.execute',
  'agents.task.start',
]);
export const suggestedTools: readonly ToolName[] = [
  'tables.list',
  'schema.inspect',
  'rows.list',
  'rows.get',
  'rows.summarize',
];

const apps = [
  { key: 'tables', label: 'Tables', prefixes: ['tables', 'schema', 'rows'] },
  { key: 'knowledge', label: 'Knowledge and web', prefixes: ['knowledge', 'web'] },
  { key: 'skills', label: 'Skills', prefixes: ['skills'] },
  { key: 'agents', label: 'Other agents', prefixes: ['agents'] },
  { key: 'slack', label: 'Slack', prefixes: ['slack'] },
  { key: 'google', label: 'Google Workspace', prefixes: ['google'] },
  { key: 'github', label: 'GitHub', prefixes: ['github'] },
  { key: 'mcp', label: 'MCP tools', prefixes: ['mcp'] },
] as const;

const appOf = (tool: ToolName) =>
  apps.find(app => (app.prefixes as readonly string[]).includes(tool.split('.')[0] ?? ''))?.key ?? 'other';
export const toolApps = [...apps, { key: 'other', label: 'Other actions', prefixes: [] }]
  .map(app => {
    const tools = toolNameSchema.options.filter(tool => appOf(tool) === app.key);
    return {
      key: app.key,
      label: app.label,
      read: tools.filter(tool => !changingTools.has(tool)),
      change: tools.filter(tool => changingTools.has(tool)),
    };
  })
  .filter(app => app.read.length + app.change.length > 0);

const option = (tool: ToolName) => ({
  value: tool,
  label: toolLabels[tool],
  description: agentToolRuntimeDescription(tool),
});

function ToolAppIcon({ app }: { app: string }) {
  if (app === 'slack' || app === 'google' || app === 'github') return <BrandIcon brand={app} size="inline" />;
  const Icon =
    app === 'tables'
      ? Database
      : app === 'knowledge'
        ? BookOpen
        : app === 'skills'
          ? ScrollText
          : app === 'agents'
            ? Bot
            : app === 'mcp'
              ? Plug
              : Wrench;
  return (
    <span className="shrink-0">
      <Icon aria-hidden="true" size={16} />
    </span>
  );
}

export function AgentToolPicker({
  value,
  onChange,
  error,
  disabled,
  suggestions = true,
}: {
  value: readonly ToolName[];
  onChange: (tools: ToolName[]) => void;
  error: string | undefined;
  disabled: boolean;
  suggestions?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(
    () =>
      new Set(
        toolApps.filter(app => [...app.read, ...app.change].some(tool => value.includes(tool))).map(app => app.key),
      ),
  );
  const missing = suggestedTools.filter(tool => !value.includes(tool));
  const toggle = (key: string, next: boolean) =>
    setOpen(current => {
      const copy = new Set(current);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  const replace = (tools: readonly ToolName[], next: readonly ToolName[]) =>
    onChange([
      ...value.filter(tool => !tools.includes(tool) || next.includes(tool)),
      ...next.filter(tool => !value.includes(tool)),
    ]);
  const matches = (tool: ToolName, app: string) =>
    `${app} ${toolLabels[tool]} ${agentToolRuntimeDescription(tool)}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  const shown = toolApps.filter(app => [...app.read, ...app.change].some(tool => matches(tool, app.label)));
  return (
    <div className="grid gap-4">
      {suggestions && (
        <section
          aria-labelledby="agent-suggested-actions-title"
          className="grid gap-3 rounded-lg border bg-muted/40 p-4"
        >
          <div className="grid gap-1">
            <h3 id="agent-suggested-actions-title" className="text-sm font-medium text-foreground">
              Suggested start: read tables
            </h3>
            <p className="text-sm text-muted-foreground">
              These let the agent find tables, read their fields, and find, read, and total rows. They cannot change
              data, and the agent only reaches the tables a manager allows when activating it. Add more below only when
              the job needs them.
            </p>
          </div>
          <ul aria-label="Suggested actions" className="flex flex-wrap gap-1.5">
            {suggestedTools.map(tool => (
              <li key={tool}>
                <Badge variant={value.includes(tool) ? 'secondary' : 'outline'}>{toolLabels[tool]}</Badge>
              </li>
            ))}
          </ul>
          <div>
            <Button
              variant="outline"
              disabled={disabled || !missing.length}
              onClick={() => {
                onChange([...value, ...missing]);
                toggle('tables', true);
              }}
            >
              {missing.length
                ? `Add ${missing.length} suggested read action${missing.length === 1 ? '' : 's'}`
                : 'Suggested actions added'}
            </Button>
          </div>
        </section>
      )}
      <SearchField
        id="agent-action-search"
        label="Find actions"
        placeholder="Search apps and actions"
        value={search}
        maxLength={120}
        onChange={setSearch}
      />
      {!shown.length && (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">No actions match this search. Your selections are kept.</p>
          <div>
            <Button variant="outline" onClick={() => setSearch('')}>
              Clear search
            </Button>
          </div>
        </div>
      )}
      <ul aria-label="Actions by app" className="grid divide-y rounded-lg border">
        {shown.map(app => {
          const tools = [...app.read, ...app.change];
          const selected = tools.filter(tool => value.includes(tool));
          const changing = selected.filter(tool => changingTools.has(tool)).length;
          // Too many actions is fixed by unchecking some, so only groups holding selections show the error.
          const flagged = error && selected.length ? error : undefined;
          const expanded = open.has(app.key) || !!flagged || !!search.trim();
          const reads = app.read.filter(tool => matches(tool, app.label));
          const changes = app.change.filter(tool => matches(tool, app.label));
          return (
            <li key={app.key}>
              <section aria-label={`${app.label} actions`}>
                <Collapsible open={expanded} onOpenChange={next => toggle(app.key, next)}>
                  <h3 id={`agent-tools-${app.key}`} className="grid">
                    <CollapsibleTrigger render={<Button variant="ghost" size="lg" />}>
                      <span className="flex min-w-0 flex-1 items-center gap-2.5">
                        <ToolAppIcon app={app.key} />
                        {app.label}
                      </span>
                      <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                        <span>
                          {selected.length
                            ? `${selected.length} of ${tools.length} selected${changing ? `, ${changing} change data` : ''}`
                            : `${tools.length} available`}
                        </span>
                        <ChevronDown aria-hidden="true" className={expanded ? 'size-4 rotate-180' : 'size-4'} />
                      </span>
                    </CollapsibleTrigger>
                  </h3>
                  <CollapsibleContent keepMounted>
                    <div className="grid gap-4 px-3 pb-4 pt-1">
                      {reads.length > 0 && (
                        <ChoiceGroup
                          type="checkbox"
                          optional
                          disabled={disabled}
                          legend="Read and inspect"
                          error={app.read.some(tool => value.includes(tool)) ? flagged : undefined}
                          options={reads.map(option)}
                          value={value.filter(tool => reads.includes(tool))}
                          onValueChange={next => replace(reads, next)}
                        />
                      )}
                      {changes.length > 0 && (
                        <ChoiceGroup
                          type="checkbox"
                          optional
                          disabled={disabled}
                          legend="Create or change data"
                          warning="Changes data"
                          error={app.change.some(tool => value.includes(tool)) ? flagged : undefined}
                          options={changes.map(option)}
                          value={value.filter(tool => changes.includes(tool))}
                          onValueChange={next => replace(changes, next)}
                        />
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
