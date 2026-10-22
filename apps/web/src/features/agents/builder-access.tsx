import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Disclosure } from '@/components/disclosure';
import { TablePicker } from '@/features/tables/table-picker';
import { McpDraftPermissions } from '@/features/workspace-mcp/draft-permissions';
import type { PermissionSlot } from '@/features/workspace-mcp/contracts';
import { parseLimits, taskLimitFields, type LimitDraft } from '@/features/tasks/limits';
import { AgentToolPicker, type ToolName } from './tool-picker';
import { DefinitionSharing } from './sharing';
import { ScopeSummary } from './reference-names';
import { useAgentSlackApi, useAgentSlackDestinations } from './slack-queries';
import { AgentRead } from './feedback';
import type { AgentContext } from './api';
import type { Policy, RecordPermission, TeamPermission } from './administration';

export type BuilderAccessDraft = {
  grants: Policy['grants'];
  personGrants: Policy['personGrants'];
  enrollment: string[];
  scope: Policy['limits'];
  limits: Policy['limits'];
  slackSender: 'user' | 'app';
  taskLimits: LimitDraft;
  mcp: PermissionSlot[];
};
const permissions: readonly TeamPermission[] = ['read', 'invoke', 'edit', 'manage', 'delete'];
const tableChoices = [
  { value: 'table.row.read', label: 'Read rows', disabled: true },
  { value: 'table.row.create', label: 'Create rows' },
  { value: 'table.row.update', label: 'Update rows' },
  { value: 'table.row.delete', label: 'Delete rows' },
] satisfies { value: RecordPermission; label: string; disabled?: boolean }[];

export function BuilderAccess({
  workspaceId,
  slug,
  teams,
  tools,
  onTools,
  value,
  onChange,
  disabled,
  showErrors,
}: {
  workspaceId: string;
  slug: string;
  teams: AgentContext['teams'];
  tools: ToolName[];
  onTools: (tools: ToolName[]) => void;
  value: BuilderAccessDraft;
  onChange: (change: Partial<BuilderAccessDraft>) => void;
  disabled: boolean;
  showErrors: boolean;
}) {
  const [table, setTable] = useState('');
  const [tablePermissions, setTablePermissions] = useState<RecordPermission[]>(['table.row.read']);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const parsedLimits = parseLimits(value.taskLimits, { kind: 'start' });
  const limitErrors = showErrors && !parsedLimits.ok ? parsedLimits.errors : {};
  function addScope(assetId: string, permissions: Policy['limits'][number]['permissions']) {
    const add = (entries: Policy['limits']) => [
      ...entries.filter(item => item.assetId !== assetId),
      {
        assetId,
        permissions: [
          ...new Set([...(entries.find(item => item.assetId === assetId)?.permissions ?? []), ...permissions]),
        ],
      },
    ];
    onChange({ limits: add(value.limits), scope: add(value.scope) });
  }
  return (
    <>
      <FormSection
        title="What it can do"
        description="Choose actions by app. Skills guide the work; these choices grant the capability."
        meta={`${tools.length} / 20`}
      >
        <AgentToolPicker
          value={tools}
          onChange={onTools}
          disabled={disabled}
          suggestions={false}
          error={showErrors && tools.length > 20 ? 'Choose no more than 20 actions.' : undefined}
        />
        {tools.includes('mcp.call') && (
          <Disclosure title={`Reviewed MCP tools (${value.mcp.reduce((sum, slot) => sum + slot.tools.length, 0)})`}>
            <McpDraftPermissions
              workspaceId={workspaceId}
              value={value.mcp}
              onChange={mcp => onChange({ mcp })}
              disabled={disabled}
            />
          </Disclosure>
        )}
      </FormSection>
      <FormSection
        title="What data it can use"
        description="These limits bound its access. They never grant access that a caller or the agent's teams do not have."
      >
        <TablePicker
          workspaceId={workspaceId}
          teams={teams}
          id="builder-read-table"
          label="Business table"
          required={false}
          value={table}
          disabled={disabled}
          onChange={setTable}
        />
        {table && (
          <>
            <ChoiceGroup
              type="checkbox"
              optional
              legend="Table access"
              options={tableChoices}
              value={tablePermissions}
              onValueChange={setTablePermissions}
            />
            <div>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  addScope(table, tablePermissions);
                  setTable('');
                  setTablePermissions(['table.row.read']);
                }}
              >
                <Plus aria-hidden="true" />
                Add table access
              </Button>
            </div>
          </>
        )}
        {!value.limits.length && (
          <p className="text-sm text-muted-foreground">No business tables or outgoing Slack destinations allowed.</p>
        )}
        {value.limits.length > 0 && (
          <ul aria-label="Data access limits" className="grid gap-3">
            {value.limits.map(limit => (
              <li key={limit.assetId} className="flex min-w-0 items-start gap-3">
                <p className="min-w-0 flex-1 wrap-anywhere text-sm">
                  <ScopeSummary workspaceId={workspaceId} scope={[limit]} />
                </p>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove access limit"
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      limits: value.limits.filter(item => item.assetId !== limit.assetId),
                      scope: value.scope.filter(item => item.assetId !== limit.assetId),
                    })
                  }
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {tools.some(tool => tool.startsWith('slack.')) && (
          <OutgoingDestinations workspaceId={workspaceId} slug={slug} disabled={disabled} add={addScope} />
        )}
        <Disclosure title="Team enrollment">
          <ChoiceGroup
            type="checkbox"
            optional
            legend="Teams whose permissions the agent may use"
            helper="Separate from team placement and from who can use this agent."
            value={value.enrollment}
            options={teams.map(team => ({ value: team.id, label: team.name }))}
            onValueChange={enrollment => onChange({ enrollment })}
          />
        </Disclosure>
      </FormSection>
      <FormSection title="Who can use it" description="You remain the owner and manager. Sharing below is optional.">
        <DefinitionSharing
          workspaceId={workspaceId}
          permissions={permissions}
          people={value.personGrants}
          teams={value.grants}
          setPeople={personGrants => onChange({ personGrants })}
          setTeams={grants => onChange({ grants })}
          disabled={disabled}
        />
        <p className="text-sm text-muted-foreground">
          In attached Slack channels, linked workspace members can talk to this agent without a separate sharing grant.
          This does not give them access to its settings or private data.
        </p>
      </FormSection>
      <Disclosure
        title="Advanced execution limits"
        open={limitsOpen || Object.keys(limitErrors).length > 0}
        onOpenChange={setLimitsOpen}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {taskLimitFields.map(field => (
            <Field
              key={field.key}
              id={`builder-limit-${field.key}`}
              label={field.label}
              required
              error={limitErrors[field.key]}
            >
              <Input
                type="number"
                min={field.min}
                max={field.max}
                value={value.taskLimits[field.key]}
                onChange={event => onChange({ taskLimits: { ...value.taskLimits, [field.key]: event.target.value } })}
              />
            </Field>
          ))}
        </div>
        <div className="mt-4">
          <ChoiceGroup
            type="radio"
            legend="Outgoing Slack identity"
            optional
            value={value.slackSender}
            onValueChange={slackSender => onChange({ slackSender })}
            disabled={disabled}
            options={[
              { value: 'user', label: 'Current caller', description: 'Use the caller’s authorized Slack integration.' },
              { value: 'app', label: 'Workspace app', description: 'Requires an authorized workspace Slack app.' },
            ]}
          />
        </div>
      </Disclosure>
    </>
  );
}

function OutgoingDestinations({
  workspaceId,
  slug,
  disabled,
  add,
}: {
  workspaceId: string;
  slug: string;
  disabled: boolean;
  add: (assetId: string, permissions: Policy['limits'][number]['permissions']) => void;
}) {
  const api = useAgentSlackApi(workspaceId);
  const read = useAgentSlackDestinations(api);
  return (
    <Disclosure title="Outgoing Slack destinations">
      <p className="mb-3 text-sm text-muted-foreground">
        Channels it may post to as an action. Attaching an incoming channel in Triggers is a separate choice.
      </p>
      <AgentRead state={read.state} refresh={read.refresh}>
        {data =>
          data.destinations.length ? (
            <Field id="builder-slack-destination" label="Add a permitted destination" optional>
              <Select
                value={null}
                disabled={disabled}
                onValueChange={id => {
                  const destination = data.destinations.find(item => item.id === id);
                  if (destination) add(destination.id, destination.permissions);
                }}
              >
                <SelectTrigger width="full">
                  <SelectValue placeholder="Choose a reviewed destination" />
                </SelectTrigger>
                <SelectContent>
                  {data.destinations.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">No reviewed destinations are configured.</p>
          )
        }
      </AgentRead>
      <div className="mt-3">
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <Link
              to="/$workspaceSlug/integrations"
              params={{ workspaceSlug: slug }}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          Manage integrations
        </Button>
      </div>
    </Disclosure>
  );
}
