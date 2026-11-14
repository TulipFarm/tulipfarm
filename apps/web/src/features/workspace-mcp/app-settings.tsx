import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import type { McpApp } from '@/features/integrations/mcp-apps';
import { UnsavedChanges } from '@/features/tables/feedback';
import { McpActions } from './actions';
import type { McpApi } from './api';
import { packageLabel, type Capabilities, type IntegrationDetail } from './contracts';
import { McpSetup } from './setup';
import { useMcpCommand } from './state';

type Grant = IntegrationDetail['grants'][number];
const same = (a: Grant, b: Grant) => a.kind === b.kind && a.id === b.id;
const toggle = (list: Grant[], grant: Grant, on: boolean) => [
  ...list.filter(item => !same(item, grant)),
  ...(on ? [grant] : []),
];
const input = (detail: IntegrationDetail) => ({
  requestId: crypto.randomUUID(),
  expectedVersion: detail.integration.version,
});

function Feedback({ command, refresh }: { command: ReturnType<typeof useMcpCommand>; refresh: () => Promise<void> }) {
  if (command.state.kind !== 'error') return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{command.state.message}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              command.reset();
              void refresh();
            }}
          >
            Check again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Who can use a connection. Personal connections are private; shared ones list people, teams and managers. */
export function McpAccessTab({
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
  const [draft, setDraft] = useState<{
    grants: Grant[];
    workspace: boolean;
    managers: Grant[];
  } | null>(null);
  const command = useMcpCommand();
  const integration = detail.integration;
  if (integration.ownership === 'personal')
    return <p className="max-w-prose">Only you can use this connection. Workspace admins can’t see or use it.</p>;
  if (!integration.canManage)
    return (
      <p className="max-w-prose">
        Your workspace shared this connection with you. Only the people who manage it can change who can use it.
      </p>
    );
  const current = draft ?? { grants: detail.grants, workspace: detail.workspace, managers: detail.managers };
  const locked = blocked || command.blocked;
  const edit = (patch: Partial<typeof current>) => setDraft({ ...current, ...patch });
  return (
    <div className="max-w-2xl space-y-6">
      <UnsavedChanges dirty={!!draft || command.busy} />
      <p className="text-sm text-muted-foreground">
        Everyone you choose uses {integration.accountLabel ?? 'the account it’s signed in with'}. They can’t see its
        sign-in details.
      </p>
      <Label>
        <Checkbox
          disabled={locked}
          checked={current.workspace}
          onCheckedChange={checked => edit({ workspace: checked === true })}
        />
        Everyone in this workspace, including people who join later
      </Label>
      {detail.grantOptions.length > 0 && (
        <section aria-labelledby="mcp-people" className="space-y-2">
          <h3 id="mcp-people" className="text-sm font-medium">
            People and teams
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {detail.grantOptions.map(option => {
              const grant = { kind: option.kind, id: option.id };
              return (
                <li
                  key={`${option.kind}/${option.id}`}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2.5"
                >
                  <Label>
                    <Checkbox
                      disabled={locked || current.workspace}
                      checked={current.workspace || current.grants.some(item => same(item, grant))}
                      onCheckedChange={checked => edit({ grants: toggle(current.grants, grant, checked === true) })}
                    />
                    {option.label}
                    {option.kind === 'team' && <span className="text-muted-foreground"> · team</span>}
                  </Label>
                  <Label>
                    <Checkbox
                      disabled={locked}
                      checked={current.managers.some(item => same(item, grant))}
                      onCheckedChange={checked => edit({ managers: toggle(current.managers, grant, checked === true) })}
                    />
                    Can manage
                  </Label>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-muted-foreground">
            Managers can sign in again, change tools and choose who can use it.
          </p>
        </section>
      )}
      {!current.managers.length && <p className="text-sm text-destructive">Choose at least one manager.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={locked || !draft || !current.managers.length}
          aria-busy={command.busy}
          onClick={() =>
            void command.run(
              () => api.integrationCommand(integration.id, 'grants', { ...input(detail), ...current }),
              async () => {
                await refresh();
                setDraft(null);
              },
            )
          }
        >
          {command.busy ? 'Saving…' : 'Save'}
        </Button>
        {draft && (
          <Button variant="ghost" disabled={command.busy} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        )}
        {command.state.kind === 'success' && !draft && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        )}
      </div>
      <Feedback command={command} refresh={refresh} />
    </div>
  );
}

const typeLabel = (detail: IntegrationDetail) =>
  detail.integration.package ? 'MCP package run by TulipFarm' : 'Remote MCP server';

/** Connection details, sign-in, turning off and removing, saved-agent use and the action history. */
export function McpAdvancedTab({
  api,
  capabilities,
  app,
  name,
  detail,
  blocked,
  refresh,
  slug,
}: {
  api: McpApi;
  capabilities: Capabilities;
  app: McpApp | undefined;
  name: string;
  detail: IntegrationDetail;
  blocked: boolean;
  refresh: () => Promise<void>;
  slug: string;
}) {
  const integration = detail.integration;
  const navigate = useNavigate();
  const command = useMcpCommand();
  const [confirm, setConfirm] = useState<'disconnect' | 'delete' | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const locked = blocked || command.blocked;
  const run = (work: () => Promise<unknown>, after: () => void | Promise<void> = refresh) =>
    void command.run(work, after);
  const facts: [string, React.ReactNode][] = [
    ['Type', typeLabel(detail)],
    [
      integration.package ? 'Package' : 'Server',
      <span key="server" className="break-all font-mono text-xs leading-5">
        {integration.package ? packageLabel(integration.package) : integration.endpoint}
      </span>,
    ],
    ...(integration.egress
      ? [
          ['Can reach', integration.egress.length ? integration.egress.join(', ') : 'No other sites'] as [
            string,
            string,
          ],
        ]
      : []),
    ...(app ? [['Listed as', `${app.registry} · published by ${app.maker}`] as [string, string]] : []),
    ['Signed in as', integration.accountLabel ?? 'Not shown by the server'],
    ['Connected for', integration.ownership === 'shared' ? 'Your workspace' : 'Only you'],
  ];
  return (
    <div className="max-w-3xl space-y-8">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-4 sm:gap-y-3">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="pt-2 text-muted-foreground sm:pt-0">{label}</dt>
            <dd className="min-w-0 break-words sm:col-span-3">{value}</dd>
          </div>
        ))}
      </dl>
      {integration.canManage && (
        <section aria-labelledby="mcp-manage" className="space-y-3">
          <h3 id="mcp-manage" className="font-medium">
            Manage
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={
                locked || ['disconnected', 'oauth-pending', 'registration-required'].includes(integration.status)
              }
              aria-busy={command.busy}
              onClick={() => run(() => api.integrationCommand(integration.id, 'discover', input(detail)))}
            >
              Look for new tools
            </Button>
            {integration.authMethod !== 'oauth' && integration.authMethod !== 'none' && (
              <Button
                variant="outline"
                disabled={locked || !capabilities.integrationsEnabled}
                onClick={() => setReconnect(!reconnect)}
              >
                Change sign-in details
              </Button>
            )}
            <Button
              variant="outline"
              disabled={locked || integration.status === 'disconnected'}
              onClick={() =>
                run(() =>
                  api.lifecycle(integration.id, {
                    ...input(detail),
                    operation: integration.status === 'disabled' ? 'enable' : 'disable',
                  }),
                )
              }
            >
              {integration.status === 'disabled' ? `Turn ${name} on` : `Turn ${name} off`}
            </Button>
            <Button variant="outline" disabled={locked} onClick={() => setConfirm('disconnect')}>
              Disconnect
            </Button>
            <Button variant="destructive" disabled={locked} onClick={() => setConfirm('delete')}>
              Remove {name}
            </Button>
          </div>
          {reconnect && (
            <McpSetup
              api={api}
              capabilities={capabilities}
              integration={integration}
              close={() => setReconnect(false)}
              saved={() => {
                setReconnect(false);
                void refresh();
              }}
            />
          )}
          <Feedback command={command} refresh={refresh} />
        </section>
      )}
      {detail.descriptor.kind !== 'chat-only' && integration.canManage && (
        <section aria-labelledby="mcp-agents" className="space-y-2">
          <h3 id="mcp-agents" className="font-medium">
            Use in saved agents
          </h3>
          <p className="max-w-prose text-sm text-muted-foreground">
            Let saved agents use this server. Each person who runs the agent uses their own access, so the agent never
            carries your account or sign-in details.
          </p>
          {detail.descriptor.kind === 'reviewable' ? (
            <Button
              variant="outline"
              disabled={locked}
              onClick={() =>
                run(() =>
                  api.integrationCommand(integration.id, 'descriptor', {
                    ...input(detail),
                    serverIdentity: detail.descriptor.kind === 'reviewable' ? detail.descriptor.id : '',
                  }),
                )
              }
            >
              Allow in saved agents
            </Button>
          ) : (
            <Badge variant="success">Allowed in saved agents</Badge>
          )}
        </section>
      )}
      <McpActions api={api} capabilities={capabilities} kind="integration" originId={integration.id} />
      <AlertDialog open={confirm !== null} onOpenChange={open => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'delete' ? `Remove ${name}?` : `Disconnect ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'delete'
                ? `Agents stop using ${name} and its sign-in is deleted. You can connect it again later.`
                : `Agents stop using ${name} until someone signs in again. Its tools and settings stay.`}{' '}
              Actions that already ran aren’t undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={command.busy}>Keep {name}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={locked}
              aria-busy={command.busy}
              onClick={() => {
                const operation = confirm;
                if (!operation) return;
                run(
                  () => api.lifecycle(integration.id, { ...input(detail), operation }),
                  async () => {
                    setConfirm(null);
                    if (operation === 'delete')
                      await navigate({ to: '/$workspaceSlug/integrations', params: { workspaceSlug: slug } });
                    else await refresh();
                  },
                );
              }}
            >
              {confirm === 'delete' ? 'Remove' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
