import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
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
import { tableAccessEnrollment, tableAccessProblem, type AgentSetup } from '@tulipfarm/agents/setup-contracts';

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
  previous,
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
  previous?: AgentSetup | undefined;
}) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const parsedLimits = parseLimits(value.taskLimits, { kind: 'start' });
  const limitErrors = showErrors && !parsedLimits.ok ? parsedLimits.errors : {};
  const problem = tableAccessProblem(teams, value.scope, value.enrollment, previous);
  const enrolledNames = teams.filter(team => value.enrollment.includes(team.id)).map(team => team.name);
  function addScope(assetId: string, permissions: Policy['limits'][number]['permissions']) {
    const scope = withScopeEntry(value.scope, assetId, permissions);
    onChange({
      limits: withScopeEntry(value.limits, assetId, permissions),
      scope,
      enrollment: tableAccessEnrollment(
        teams,
        scope.find(entry => entry.assetId === assetId)!,
        value.enrollment,
      ),
    });
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
        <AgentDataScope
          workspaceId={workspaceId}
          teams={teams}
          id="builder-read-table"
          value={value.limits}
          disabled={disabled}
          onAdd={addScope}
          onRemove={assetId =>
            onChange({
              limits: value.limits.filter(item => item.assetId !== assetId),
              scope: value.scope.filter(item => item.assetId !== assetId),
            })
          }
        />
        {tools.some(tool => tool.startsWith('slack.')) && (
          <OutgoingDestinations workspaceId={workspaceId} slug={slug} disabled={disabled} add={addScope} />
        )}
        <p className="wrap-anywhere text-sm text-muted-foreground" role="status">
          {value.enrollment.length
            ? enrolledNames.length
              ? `Uses access from ${new Intl.ListFormat('en').format(enrolledNames)}.`
              : 'Uses access from enrolled teams.'
            : 'No team access selected. Choose a team that can read the selected tables.'}
        </p>
        {problem && (
          <Alert>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <Disclosure title="Change teams used for access">
          <ChoiceGroup
            type="checkbox"
            optional
            legend="Teams whose permissions the agent may use"
            helper="Separate from team placement and from who can use this agent."
            value={value.enrollment}
            options={teams.map(team => ({
              value: team.id,
              label: team.name,
              disabled: !team.canAssign && !previous?.enrollment.includes(team.id),
            }))}
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

/** A table picked in the data scope but not yet added with "Add table access". */
export type PendingTable = { assetId: string; permissions: RecordPermission[] };
export const noPendingTable: PendingTable = { assetId: '', permissions: ['table.row.read'] };

/** Business tables and other assets an agent may use, as offered in the builder's "What data it can use" step. */
export function AgentDataScope({
  workspaceId,
  teams,
  id,
  value,
  disabled,
  onAdd,
  onRemove,
  pending: controlled,
  onPendingChange,
}: {
  workspaceId: string;
  teams: AgentContext['teams'];
  id: string;
  value: Policy['limits'];
  disabled: boolean;
  onAdd: (assetId: string, permissions: Policy['limits'][number]['permissions']) => void;
  onRemove: (assetId: string) => void;
  /** Lets the parent save a picked table without "Add table access". */
  pending?: PendingTable;
  onPendingChange?: (pending: PendingTable) => void;
}) {
  const [local, setLocal] = useState(noPendingTable);
  const pending = controlled ?? local;
  const setPending = onPendingChange ?? setLocal;
  const table = pending.assetId;
  const tablePermissions = pending.permissions;
  return (
    <>
      <TablePicker
        workspaceId={workspaceId}
        teams={teams}
        id={id}
        label="Business table"
        required={false}
        value={table}
        disabled={disabled}
        onChange={assetId => setPending({ ...pending, assetId })}
      />
      {table && (
        <>
          <ChoiceGroup
            type="checkbox"
            optional
            legend="Table access"
            options={tableChoices}
            value={tablePermissions}
            onValueChange={permissions => setPending({ ...pending, permissions })}
          />
          <div>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onAdd(table, tablePermissions);
                setPending(noPendingTable);
              }}
            >
              <Plus aria-hidden="true" />
              Add table access
            </Button>
          </div>
        </>
      )}
      {!value.length && !table && (
        <p className="text-sm text-muted-foreground">No business tables or outgoing Slack destinations allowed.</p>
      )}
      {value.length > 0 && (
        <ul aria-label="Data access limits" className="grid gap-3">
          {value.map(limit => (
            <li key={limit.assetId} className="flex min-w-0 items-start gap-3">
              <p className="min-w-0 flex-1 wrap-anywhere text-sm">
                <ScopeSummary workspaceId={workspaceId} scope={[limit]} />
              </p>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove access limit"
                disabled={disabled}
                onClick={() => onRemove(limit.assetId)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Adds an asset's permissions to a scope, merging with any it already has. */
export function withScopeEntry(
  entries: Policy['limits'],
  assetId: string,
  permissions: Policy['limits'][number]['permissions'],
) {
  return [
    ...entries.filter(item => item.assetId !== assetId),
    {
      assetId,
      permissions: [
        ...new Set([...(entries.find(item => item.assetId === assetId)?.permissions ?? []), ...permissions]),
      ],
    },
  ];
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
