import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceList } from '@tulipfarm/sprout/choice-list';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { AppIcon } from '@/features/integrations/app-icon';
import { fillTemplate, mcpAppForEndpoint, type McpApp } from '@/features/integrations/mcp-apps';
import { integrationDetailRoute } from '@/router';
import type { McpApi } from './api';
import { McpAccessTab, McpAdvancedTab } from './app-settings';
import { useMcpConnect, type Ownership } from './connect';
import type { Capabilities, Integration, IntegrationDetail } from './contracts';
import { useMcpCapabilities, useMcpApi, useMcpIntegration, useMcpIntegrations } from './queries';
import { takeMcpConnected } from './sign-in';
import { McpGate, McpRead } from './state';
import { McpToolsTab } from './tools-tab';

type Tab = 'overview' | 'tools' | 'access' | 'advanced';
const connecting: Integration['status'][] = ['setup', 'oauth-pending', 'registration-required', 'discovering'];

/** The page for one MCP app: a curated app such as Linear, or a server someone connected (`mcp-<id>`). */
export function McpAppPage({
  workspaceId,
  slug,
  app,
  id,
  missing,
}: {
  workspaceId: string;
  slug: string;
  app?: McpApp | undefined;
  id?: string | undefined;
  missing: ReactNode;
}) {
  const api = useMcpApi(workspaceId);
  const available = useMcpCapabilities(api);
  const [justConnected] = useState(takeMcpConnected);
  if (available.state.kind === 'ready' && !available.state.data.enabled) return missing;
  return (
    <PageContent>
      <McpGate workspaceId={workspaceId}>
        {(gated, capabilities) => (
          <Resolve
            api={gated}
            capabilities={capabilities}
            slug={slug}
            app={app}
            id={id}
            missing={missing}
            justConnected={justConnected}
          />
        )}
      </McpGate>
    </PageContent>
  );
}

function Resolve({
  api,
  capabilities,
  slug,
  app,
  id,
  missing,
  justConnected,
}: {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  app: McpApp | undefined;
  id: string | undefined;
  missing: ReactNode;
  justConnected: string | null;
}) {
  const list = useMcpIntegrations(api);
  return (
    <McpRead state={list.state} refresh={list.refresh} label="Integration">
      {data => {
        const connection = id
          ? data.integrations.find(integration => integration.id === id)
          : app &&
            data.integrations.find(
              integration =>
                (integration.canManage || integration.canUse) && mcpAppForEndpoint(integration.endpoint)?.id === app.id,
            );
        if (id && !connection) return missing;
        const brand = app ?? (connection && mcpAppForEndpoint(connection.endpoint));
        return connection ? (
          <ConnectedApp
            key={connection.id}
            api={api}
            capabilities={capabilities}
            slug={slug}
            app={brand}
            refreshList={list.refresh}
            connection={connection}
            justConnected={justConnected === connection.id}
          />
        ) : brand ? (
          <NewApp
            key={brand.id}
            api={api}
            capabilities={capabilities}
            slug={slug}
            app={brand}
            refreshList={list.refresh}
          />
        ) : (
          missing
        );
      }}
    </McpRead>
  );
}

type PageProps = {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  app: McpApp | undefined;
  refreshList: () => Promise<void>;
};

function Header({ slug, name }: { slug: string; name: string }) {
  const { returnChat } = integrationDetailRoute.useSearch();
  return (
    <PageHeader
      title={name}
      parent={{
        label: 'Integrations',
        link: <Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} search={{ returnChat }} />,
      }}
    />
  );
}

function Hero({
  app,
  name,
  status,
  about,
  action,
}: {
  app: McpApp | undefined;
  name: string;
  status?: ReactNode;
  about: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section aria-label={`${name} summary`} className="flex flex-wrap items-start gap-4">
      <AppIcon brand={app?.brand} tile={app?.tile} logo={app?.logo} size="xl" />
      <div className="min-w-0 flex-1 basis-56 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="break-words text-2xl font-semibold tracking-tight">{name}</p>
          {status && <span className="flex h-6 items-center">{status}</span>}
        </div>
        <p className="text-sm text-muted-foreground">{about}</p>
      </div>
      {action && <div className="w-full sm:w-auto sm:shrink-0 sm:pt-1">{action}</div>}
    </section>
  );
}

/** "Just me" or "Everyone", asked only of people who can share. Everyone else connects for themselves in one click. */
export function useOwnershipChoice(capabilities: Capabilities, connect: (ownership: Ownership) => void, signIn = true) {
  const [asking, setAsking] = useState(false);
  const [ownership, setOwnership] = useState<Ownership>('personal');
  return {
    start: () => (capabilities.canManageShared ? setAsking(true) : connect('personal')),
    dialog: (name: string) => (
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {name}</DialogTitle>
            <DialogDescription>
              {signIn ? `You’ll sign in to ${name}, then come straight back here.` : `Choose who can use ${name}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ChoiceList
              legend="Who can use it"
              options={[
                { id: 'personal', label: 'Just me' },
                { id: 'shared', label: 'Everyone in this workspace, including people who join later' },
              ]}
              value={[ownership]}
              onChange={next => next[0] && setOwnership(next[0] as Ownership)}
            />
            {ownership === 'shared' && (
              <p className="mt-3 text-sm text-muted-foreground">
                Everyone uses the {name} account you {signIn ? 'sign in with' : 'connect'}, so pick one that only sees
                what the whole team should.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => {
                setAsking(false);
                connect(ownership);
              }}
            >
              {signIn ? `Continue to ${name}` : `Connect ${name}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}

function NewApp({ api, capabilities, slug, app, refreshList }: PageProps & { app: McpApp }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.trim()]));
  const needsKey = app.auth === 'api-key';
  const fields = [
    ...app.variables,
    ...(needsKey ? [{ name: 'key', description: app.headers[0]?.description ?? `Your ${app.name} API key` }] : []),
  ];
  const ready = fields.every(field => filled[field.name]);
  const flow = useMcpConnect({
    api,
    name: app.name,
    endpoint: fillTemplate(app.endpoint, filled),
    authentication:
      app.auth === 'api-key'
        ? { headers: app.headers.map(header => ({ name: header.name, value: fillTemplate(header.value, filled) })) }
        : app.auth,
    existing: undefined,
    refresh: refreshList,
  });
  const choice = useOwnershipChoice(capabilities, flow.connect, app.auth === 'oauth');
  const busy = flow.command.busy;
  const connectButton = (
    <Button
      size="lg"
      disabled={busy || !capabilities.integrationsEnabled || !ready}
      aria-busy={busy}
      onClick={choice.start}
    >
      {busy && <Spinner aria-hidden="true" />}
      {busy ? `Connecting ${app.name}…` : `Connect ${app.name}`}
    </Button>
  );
  return (
    <>
      <Header slug={slug} name={app.name} />
      <div className="max-w-5xl space-y-8">
        <Hero
          app={app}
          name={app.name}
          about={`${app.blurb}. By ${app.maker}.`}
          action={fields.length ? undefined : connectButton}
        />
        {fields.length > 0 && (
          <section aria-labelledby="mcp-account" className="max-w-md space-y-4">
            <div className="space-y-1">
              <h2 id="mcp-account" className="text-base font-semibold">
                Your {app.name} account
              </h2>
              <p className="text-sm text-muted-foreground">
                {needsKey ? `${app.name} connects with an API key.` : `Tell us which ${app.name} account to use.`}{' '}
                <a href={app.docs} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  {needsKey ? 'Where to find it' : 'How to find these'}
                </a>
              </p>
            </div>
            {fields.map(field => (
              <Field
                key={field.name}
                id={`mcp-${field.name}`}
                label={field.name === 'key' ? 'API key' : field.description}
                required
                helper={field.name === 'key' ? field.description : undefined}
              >
                <Input
                  type={field.name === 'key' ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={'example' in field ? field.example : undefined}
                  value={values[field.name] ?? ''}
                  onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))}
                />
              </Field>
            ))}
            {connectButton}
          </section>
        )}
        <ConnectError command={flow.command} name={app.name} />
        <section aria-labelledby="mcp-does" className="max-w-2xl space-y-3">
          <h2 id="mcp-does" className="text-base font-semibold">
            What your agents can do
          </h2>
          <ul className="list-disc space-y-1 ps-5 text-foreground-secondary">
            {app.does.map(item => (
              <li key={item}>{item}</li>
            ))}
            <li>Change things only after you approve them in chat</li>
          </ul>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Official {app.maker} MCP server <Badge variant="secondary">Verified publisher</Badge>
          </p>
        </section>
      </div>
      {choice.dialog(app.name)}
    </>
  );
}

function ConnectError({ command, name }: { command: ReturnType<typeof useMcpConnect>['command']; name: string }) {
  if (command.state.kind !== 'error') return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        Couldn’t open {name}. {command.state.message}
      </AlertDescription>
    </Alert>
  );
}

const ownershipText = (integration: Integration) =>
  integration.ownership === 'shared' ? 'Shared with your workspace' : 'Only you';

function ConnectedApp({
  api,
  capabilities,
  slug,
  app,
  refreshList,
  connection,
  justConnected,
}: PageProps & { connection: Integration; justConnected: boolean }) {
  const read = useMcpIntegration(api, connection.id);
  const name = app?.name ?? connection.name;
  return (
    <>
      <Header slug={slug} name={name} />
      <McpRead state={read.state} refresh={read.refresh} label={name}>
        {(detail, blocked) => (
          <ConnectedBody
            api={api}
            capabilities={capabilities}
            app={app}
            name={name}
            detail={detail}
            blocked={blocked}
            justConnected={justConnected}
            slug={slug}
            refresh={async () => {
              await Promise.all([read.refresh(), refreshList()]);
            }}
          />
        )}
      </McpRead>
    </>
  );
}

function StatusBadge({ integration }: { integration: Integration }) {
  if (integration.reauthorizationRequired) return <Badge variant="warning">Sign in again</Badge>;
  switch (integration.status) {
    case 'ready':
      return (
        <Badge variant="success">
          <CheckIcon aria-hidden="true" />
          Connected
        </Badge>
      );
    case 'review-required':
      return <Badge variant="warning">Tools changed</Badge>;
    case 'disabled':
      return <Badge variant="outline">Turned off</Badge>;
    case 'disconnected':
      return <Badge variant="outline">Disconnected</Badge>;
    case 'error':
      return <Badge variant="warning">Needs attention</Badge>;
    case 'registration-required':
      return <Badge variant="warning">One more step</Badge>;
    default:
      return <Badge variant="secondary">Connecting…</Badge>;
  }
}

function ConnectedBody({
  api,
  capabilities,
  app,
  name,
  detail,
  blocked,
  justConnected,
  slug,
  refresh,
}: {
  api: McpApi;
  capabilities: Capabilities;
  app: McpApp | undefined;
  name: string;
  detail: IntegrationDetail;
  blocked: boolean;
  justConnected: boolean;
  slug: string;
  refresh: () => Promise<void>;
}) {
  const integration = detail.integration;
  const search = integrationDetailRoute.useSearch();
  const navigate = useNavigate({ from: integrationDetailRoute.fullPath });
  const tabs: Tab[] = ['overview', 'tools', 'access', 'advanced'];
  const tab: Tab = search.tab && (tabs as string[]).includes(search.tab) ? (search.tab as Tab) : 'overview';
  const setTab = (next: Tab) =>
    void navigate({
      search: { tab: next === 'overview' ? undefined : next, returnChat: search.returnChat },
      replace: true,
    });
  const oauth = integration.kind === 'remote' && integration.authMethod === 'oauth';
  const flow = useMcpConnect({
    api,
    name,
    endpoint: integration.endpoint,
    authentication: 'oauth',
    existing: integration,
    refresh,
  });
  const on = detail.tools.filter(tool => tool.enabled).length;
  const signIn =
    oauth &&
    integration.canManage &&
    (integration.reauthorizationRequired ||
      ['setup', 'oauth-pending', 'registration-required', 'disconnected'].includes(integration.status));
  const busy = flow.command.busy;
  const action = signIn ? (
    <Button
      disabled={busy || blocked || !capabilities.integrationsEnabled}
      aria-busy={busy}
      onClick={() => flow.connect(integration.ownership)}
    >
      {busy && <Spinner aria-hidden="true" />}
      {integration.status === 'registration-required' && flow.registration
        ? 'Continue'
        : integration.status === 'disconnected' || integration.reauthorizationRequired
          ? `Sign in to ${name} again`
          : `Finish connecting`}
    </Button>
  ) : undefined;
  const about = [
    integration.accountLabel,
    ownershipText(integration),
    integration.status === 'ready' || integration.status === 'review-required'
      ? `${on} of ${detail.tools.length} tools on`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="max-w-5xl space-y-6">
      <Hero app={app} name={name} status={<StatusBadge integration={integration} />} about={about} action={action} />
      {justConnected && integration.status === 'ready' && (
        <Alert>
          <CheckIcon aria-hidden="true" />
          <AlertDescription>
            {name} is connected. Your agents can use its {on} tools in chat.
            {search.returnChat && (
              <>
                {' '}
                <Button
                  variant="link"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug/chat/$chatId"
                      params={{ workspaceSlug: slug, chatId: search.returnChat }}
                    />
                  }
                >
                  Back to chat
                </Button>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      <ConnectError command={flow.command} name={name} />
      {integration.barrier && (
        <Alert variant="destructive">
          <AlertDescription>
            {name} is paused for everyone who uses it, because TulipFarm couldn’t confirm whether an earlier action
            finished. Check {name}, then mark the action done or not done in Advanced.
          </AlertDescription>
        </Alert>
      )}
      {flow.registration && <Registration name={name} flow={flow} />}
      {connecting.includes(integration.status) && !flow.registration && (
        <p role="status" className="text-sm text-muted-foreground">
          {integration.status === 'discovering'
            ? `Finding what ${name} can do…`
            : integration.status === 'registration-required'
              ? `${name} needs one more step before you can sign in.`
              : `Sign in to ${name} to finish connecting.`}
        </p>
      )}
      {integration.status === 'error' && integration.statusReason && (
        <Alert variant="destructive">
          <AlertDescription>{integration.statusReason}</AlertDescription>
        </Alert>
      )}
      <Tabs value={tab} onValueChange={value => setTab(value as Tab)}>
        <div className="max-w-full overflow-x-auto pb-1">
          <TabsList variant="line" aria-label={`${name} sections`}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="tools">Tools {detail.tools.length || ''}</TabsTrigger>
            <TabsTrigger value="access">Who can use it</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <div className="pt-6">
            <Overview app={app} detail={detail} onTools={() => setTab('tools')} />
          </div>
        </TabsContent>
        <TabsContent value="tools">
          <div className="pt-6">
            <McpToolsTab api={api} detail={detail} blocked={blocked} refresh={refresh} />
          </div>
        </TabsContent>
        <TabsContent value="access">
          <div className="pt-6">
            <McpAccessTab api={api} detail={detail} blocked={blocked} refresh={refresh} />
          </div>
        </TabsContent>
        <TabsContent value="advanced">
          <div className="pt-6">
            <McpAdvancedTab
              api={api}
              capabilities={capabilities}
              app={app}
              name={name}
              detail={detail}
              blocked={blocked}
              refresh={refresh}
              slug={slug}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Registration({ name, flow }: { name: string; flow: ReturnType<typeof useMcpConnect> }) {
  const registration = flow.registration!;
  return (
    <section aria-labelledby="mcp-registration" className="max-w-2xl space-y-3 rounded-xl border border-border p-4">
      <h2 id="mcp-registration" className="font-medium">
        One more step for {name}
      </h2>
      <p className="text-sm">
        {name} doesn’t let apps sign in automatically. In {name}’s settings, create an OAuth app with this callback URL,
        then paste its client ID here.
      </p>
      <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs">
        {registration.registration.redirectUri}
      </p>
      <Input
        aria-label="Client ID"
        placeholder="Client ID"
        autoComplete="off"
        value={flow.clientId}
        onChange={event => flow.setClientId(event.target.value)}
      />
      <Input
        aria-label="Client secret, if your app has one"
        placeholder="Client secret, if your app has one"
        type="password"
        autoComplete="off"
        value={flow.clientSecret}
        onChange={event => flow.setClientSecret(event.target.value)}
      />
      <Button
        disabled={!flow.clientId.trim() || flow.command.busy}
        aria-busy={flow.command.busy}
        onClick={() => flow.connect(registration.integration.ownership)}
      >
        Continue to {name}
      </Button>
    </section>
  );
}

function Overview({
  app,
  detail,
  onTools,
}: {
  app: McpApp | undefined;
  detail: IntegrationDetail;
  onTools: () => void;
}) {
  const on = detail.tools.filter(tool => tool.enabled);
  const asks = on.filter(tool => !tool.readOnly && !tool.standingException).length;
  const changed = detail.tools.filter(tool => tool.review === 'changed').length;
  const stats: [string, string][] = [
    ['Tools on', `${on.length} of ${detail.tools.length}`],
    ['Ask you first', `${asks} ${asks === 1 ? 'tool' : 'tools'}`],
    [
      'Who can use it',
      detail.integration.ownership === 'shared' ? (detail.workspace ? 'Everyone' : 'Chosen people') : 'Just you',
    ],
  ];
  return (
    <div className="max-w-3xl space-y-6">
      {changed > 0 && (
        <Alert>
          <AlertDescription>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {detail.integration.name} changed {changed} {changed === 1 ? 'tool' : 'tools'}. Check{' '}
                {changed === 1 ? 'it' : 'them'} before they run again.
              </span>
              <Button variant="outline" size="sm" onClick={onTools}>
                Check tools
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid gap-4 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {app && (
        <section aria-labelledby="mcp-does" className="space-y-3">
          <h2 id="mcp-does" className="text-base font-semibold">
            What your agents can do
          </h2>
          <ul className="list-disc space-y-1 ps-5 text-foreground-secondary">
            {app.does.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
