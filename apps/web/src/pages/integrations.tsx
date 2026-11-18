import { cloneElement, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, Navigate, useLinkProps, useLocation, useNavigate } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { InfoCircle } from 'reicon-react/icons/InfoCircle';
import { Plug } from 'reicon-react/icons/Plug';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status as StatusMark } from '@tulipfarm/sprout/status';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import { AppIcon } from '@/features/integrations/app-icon';
import {
  integrationFromHash,
  integrations,
  type Integration,
  type IntegrationTab,
} from '@/features/integrations/catalog';
import { connector } from '@/features/integrations/connect';
import { actionFor, tabsFor } from '@/features/integrations/integration-state';
import { mcpAppById, mcpAppForEndpoint, mcpApps, mcpPagePrefix, type McpApp } from '@/features/integrations/mcp-apps';
import { useIntegrationChanges } from '@/features/integrations/queries';
import {
  notSetUp,
  notYet,
  statusOf,
  useIntegrationStatus,
  type Status,
  type Statuses,
} from '@/features/integrations/status';
import { WorkspaceRefreshNotice } from '@/features/integrations/workspace-refresh';
import type { McpApi } from '@/features/workspace-mcp/api';
import { useOwnershipChoice } from '@/features/workspace-mcp/app-page';
import { mcpStatusLabel, useMcpConnect, type Ownership } from '@/features/workspace-mcp/connect';
import {
  packageLabel,
  type Capabilities,
  type CatalogEntry,
  type Integration as McpIntegration,
} from '@/features/workspace-mcp/contracts';
import { useMcpApi, useMcpCapabilities, useMcpCatalog, useMcpIntegrations } from '@/features/workspace-mcp/queries';
import { McpSetup } from '@/features/workspace-mcp/setup';
import { useFlag } from '@/lib/feature-flags';
import { integrationsRoute, workspaceRoute } from '@/router';

const available = integrations.filter(app => app.provider !== 'soon');
/** The built-in apps this member can see: plan apps show only while their flag is on. */
function useAvailableApps() {
  const chatgpt = useFlag('chatgpt-plan');
  const claude = useFlag('claude-plan');
  return useMemo(
    () => available.filter(app => (app.provider !== 'chatgpt' || chatgpt) && (app.provider !== 'claude' || claude)),
    [chatgpt, claude],
  );
}
// A 'soon' app whose maker now runs an MCP server is listed from the catalog instead.
const upcoming = (app: Integration) => app.provider === 'soon' && !mcpAppById(app.id);
export const isConnected = (status: Status | null) => status?.kind === 'connected' || status?.kind === 'installed';
export const needsAttention = (status: Status | null) => status?.kind === 'attention' || status?.kind === 'error';
// Everything but a connection that's working, turned off or still being checked waits on someone.
export const mcpNeedsAttention = (server: McpIntegration) =>
  !['ready', 'disabled', 'discovering'].includes(server.status) || !!server.reauthorizationRequired;
export const brandOf = (server: McpIntegration) => (server.endpoint ? mcpAppForEndpoint(server.endpoint) : undefined);
const mcpHash = /^(?:review|reauthorize)-mcp-(.+)$/;

export function IntegrationsPage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
  const { returnChat } = integrationsRoute.useSearch();
  const hash = useLocation({ select: location => location.hash });
  // Old links opened a sheet or a section from the hash; send them to the integration's own page.
  const target = integrationFromHash(hash);
  const server = mcpHash.exec(hash)?.[1];
  if (target || server)
    return (
      <Navigate
        to="/$workspaceSlug/integrations/$integrationId"
        params={{
          workspaceSlug: workspace.slug,
          integrationId: server ? `${mcpPagePrefix}${server}` : target!.app.id,
        }}
        search={{ tab: !target || target.tab === 'overview' ? undefined : target.tab, returnChat }}
        replace
      />
    );
  return (
    <IntegrationsContent
      key={`${workspace.id}:${user.id}:${sessionId}`}
      workspaceId={workspace.id}
      slug={workspace.slug}
    />
  );
}

type Entry =
  | { kind: 'app'; app: Integration }
  | { kind: 'curated'; app: McpApp }
  | { kind: 'server'; server: McpIntegration };
type View = 'yours' | 'browse';
type Group = 'connected' | 'attention' | 'available' | 'soon';
function groupOf(entry: Entry, statuses: Statuses): Group {
  if (entry.kind === 'server') return mcpNeedsAttention(entry.server) ? 'attention' : 'connected';
  if (entry.kind === 'curated') return 'available';
  if (entry.app.provider === 'soon') return 'soon';
  const status = statusOf(statuses, entry.app);
  return needsAttention(status) ? 'attention' : isConnected(status) ? 'connected' : 'available';
}
const directoryPatience = 800;
const turnedOff = 'Connecting apps is turned off here. Your workspace admins can’t change this.';
const entryKey = (entry: Entry) => (entry.kind === 'server' ? entry.server.id : `${entry.kind}:${entry.app.id}`);
const entryText = (entry: Entry) =>
  entry.kind === 'server'
    ? `${entry.server.name} ${brandOf(entry.server)?.name ?? ''}`
    : entry.kind === 'curated'
      ? `${entry.app.name} ${entry.app.blurb} ${entry.app.maker}`
      : `${entry.app.name} ${entry.app.blurb}`;

function useMcpDirectory(workspaceId: string) {
  const api = useMcpApi(workspaceId);
  const read = useMcpCapabilities(api);
  const capabilities = read.state.kind === 'ready' && read.state.data.enabled ? read.state.data : null;
  const list = useMcpIntegrations(api, !!capabilities);
  const servers = useMemo(() => (list.state.kind === 'ready' ? list.state.data.integrations : []), [list.state]);
  const loading = read.state.kind === 'loading' || (!!capabilities && list.state.kind === 'loading');
  const failed = !!capabilities && list.state.kind === 'error' ? list.state.message : null;
  const refreshing = list.state.kind === 'ready' && list.state.refreshing;
  return { api, capabilities, servers, loading, failed, refreshing, refresh: list.refresh };
}

function IntegrationsContent({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { workspaceStale, membership } = workspaceRoute.useRouteContext();
  const { returnChat, view: viewParam } = integrationsRoute.useSearch();
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId);
  const apps = useAvailableApps();
  const navigate = useNavigate();
  const mcp = useMcpDirectory(workspaceId);
  const [query, setQuery] = useState('');
  const searchId = useId();
  const [setup, setSetup] = useState<Setup>(null);
  const hosted = useFlag('hosted-mcp') && !!mcp.capabilities?.hosted;
  const admin = membership?.role === 'admin';
  const needle = query.trim().toLowerCase();
  const loading = mcp.loading || Object.values(statuses).some(status => status.kind === 'loading');
  // Hold the apps briefly for every status, so rows don't jump as each provider answers,
  // but never let one slow or retrying provider hide the others.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setPatient(false), directoryPatience);
    return () => window.clearTimeout(timer);
  }, []);
  const holding = loading && patient && !needle;
  // Only providers with an app in the directory can be named in the notice.
  const errors = Object.entries(statuses).flatMap(([provider, status]) => {
    const names = apps.filter(app => app.provider === provider).map(app => app.name);
    return status.kind === 'error' && names.length ? [{ provider, names, detail: status.detail }] : [];
  });
  const checking = refreshing || mcp.refreshing;
  const servers = mcp.servers;

  // What needs attention, then what's connected, then everything else.
  const entries = useMemo((): Entry[] => {
    const app = (item: Integration) => ({ kind: 'app', app: item }) as const;
    const server = (item: McpIntegration) => ({ kind: 'server', server: item }) as const;
    const attention = apps.filter(item => needsAttention(statusOf(statuses, item)));
    const connected = apps.filter(item => isConnected(statusOf(statuses, item)));
    const linked = new Set([...attention, ...connected]);
    const brands = new Set(servers.filter(item => item.canManage || item.canUse).map(item => brandOf(item)?.id));
    return [
      ...attention.map(app),
      ...servers.filter(mcpNeedsAttention).map(server),
      ...connected.map(app),
      ...servers.filter(item => !mcpNeedsAttention(item)).map(server),
      ...apps.filter(item => !linked.has(item)).map(app),
      ...(mcp.capabilities ? mcpApps.filter(item => !brands.has(item.id)) : []).map(
        item => ({ kind: 'curated', app: item }) as const,
      ),
      ...integrations.filter(upcoming).map(app),
    ];
  }, [apps, statuses, servers, mcp.capabilities]);
  // While searching, both tabs and their counts show only the matching apps.
  const matching = useMemo(
    () => (needle ? entries.filter(entry => entryText(entry).toLowerCase().includes(needle)) : entries),
    [needle, entries],
  );
  // Your apps: connected or needing attention. Browse: what this member can connect, then what nobody here can.
  const sorted = useMemo(() => {
    const integrationsEnabled = !!mcp.capabilities?.integrationsEnabled;
    const blocked = (entry: Entry) => {
      if (entry.kind === 'curated') return !integrationsEnabled;
      if (entry.kind !== 'app') return false;
      const status = statusOf(statuses, entry.app);
      return status?.kind === 'unavailable' || actionFor(entry.app, status, admin).kind === 'none';
    };
    const yours: Entry[] = [];
    const connectable: Entry[] = [];
    const unavailable: Entry[] = [];
    for (const entry of matching) {
      const group = groupOf(entry, statuses);
      if (group === 'connected' || group === 'attention') yours.push(entry);
      else if (group === 'soon' || blocked(entry)) unavailable.push(entry);
      else connectable.push(entry);
    }
    return { yours, connectable, unavailable };
  }, [matching, statuses, admin, mcp.capabilities]);
  const owned = useMemo(
    () => entries.some(entry => ['connected', 'attention'].includes(groupOf(entry, statuses))),
    [entries, statuses],
  );
  // Earlier links named the category views; the ones about your own apps open Your apps.
  const linked: View | null =
    viewParam === 'browse' || viewParam === 'available'
      ? 'browse'
      : viewParam && ['yours', 'connected', 'attention'].includes(viewParam)
        ? 'yours'
        : null;
  // With nothing connected there's no Your apps tab, so the page is just Browse.
  const tabbed = holding || owned;
  const view: View = tabbed ? (linked ?? 'yours') : 'browse';
  const setView = (value: View) =>
    void navigate({ to: '.', search: previous => ({ ...previous, view: value }), replace: true });
  const renderEntry = (entry: Entry) =>
    entry.kind === 'app' ? (
      <AppRow
        app={entry.app}
        status={statusOf(statuses, entry.app)}
        workspaceId={workspaceId}
        slug={slug}
        admin={admin}
        returnChat={returnChat}
      />
    ) : entry.kind === 'curated' && mcp.capabilities ? (
      <CuratedRow
        app={entry.app}
        api={mcp.api}
        capabilities={mcp.capabilities}
        slug={slug}
        returnChat={returnChat}
        refresh={mcp.refresh}
      />
    ) : entry.kind === 'server' && mcp.capabilities ? (
      <ServerRow
        server={entry.server}
        api={mcp.api}
        capabilities={mcp.capabilities}
        slug={slug}
        returnChat={returnChat}
        refresh={mcp.refresh}
      />
    ) : null;
  const searched = `“${query.trim()}”`;

  return (
    <PageContent>
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeader
          title="Integrations"
          actions={
            mcp.capabilities ? (
              <Button
                variant="outline"
                size="sm"
                aria-label="Add custom app"
                disabled={!mcp.capabilities.integrationsEnabled}
                onClick={() => setSetup({})}
              >
                <Add aria-hidden="true" />
                <span className="hidden sm:inline">Add custom app</span>
              </Button>
            ) : undefined
          }
          back={
            returnChat
              ? {
                  label: 'Back to chat',
                  link: <Link to="/$workspaceSlug/chat/$chatId" params={{ workspaceSlug: slug, chatId: returnChat }} />,
                }
              : undefined
          }
        />
        <WorkspaceRefreshNotice />
        <fieldset disabled={workspaceStale} className="min-w-0">
          {setup && mcp.capabilities && (
            <McpSetup
              key={setup.entry?.id ?? (setup.hosted ? 'hosted' : 'manual')}
              api={mcp.api}
              capabilities={mcp.capabilities}
              entry={setup.entry}
              hosted={setup.hosted}
              runPackage={hosted && !setup.entry ? () => setSetup({ hosted: true }) : undefined}
              close={() => setSetup(null)}
              saved={id =>
                void navigate({
                  to: '/$workspaceSlug/integrations/$integrationId',
                  params: { workspaceSlug: slug, integrationId: `${mcpPagePrefix}${id}` },
                })
              }
              // Sign-in comes back to the page that started it, so start it from the new server's page.
              authorizing={id =>
                window.history.replaceState(window.history.state, '', `/${slug}/integrations/${mcpPagePrefix}${id}`)
              }
            />
          )}
          <div className="space-y-6">
            {(errors.length > 0 || mcp.failed) && (
              <Alert variant="destructive">
                <AlertDescription>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <ul className="space-y-1">
                      {errors.map(({ provider, names, detail }) => (
                        <li key={provider}>
                          Couldn’t check {names.join(', ')}. {detail}
                        </li>
                      ))}
                      {mcp.failed && <li>Couldn’t load your custom apps. {mcp.failed}</li>}
                    </ul>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checking}
                      aria-busy={checking}
                      onClick={() => void Promise.all([refresh(), mcp.failed ? mcp.refresh() : null])}
                    >
                      {checking ? 'Checking…' : 'Check again'}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
            <Tabs value={view} onValueChange={value => setView(value as View)}>
              {/* Tabs and search stay in reach while the list scrolls. */}
              <div className="sticky top-0 z-20 -mx-4 flex flex-col gap-2 bg-background px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                {tabbed && (
                  <TabsList aria-label="Show apps">
                    <TabsTrigger value="yours">
                      Your apps
                      {!holding && <span className="text-muted-foreground tabular-nums"> {sorted.yours.length}</span>}
                    </TabsTrigger>
                    <TabsTrigger value="browse">
                      Browse
                      {!holding && (
                        <span className="text-muted-foreground tabular-nums"> {sorted.connectable.length}</span>
                      )}
                    </TabsTrigger>
                  </TabsList>
                )}
                <div className={tabbed ? 'w-full sm:max-w-xs' : 'w-full sm:max-w-md'}>
                  <SearchField
                    id={searchId}
                    label="Search apps"
                    value={query}
                    onChange={setQuery}
                    placeholder="Search apps, like PostHog or Jira"
                  />
                </div>
              </div>
              {holding ? (
                <div className="pt-2">
                  <DirectorySkeleton />
                </div>
              ) : (
                <>
                  <TabsContent value="yours">
                    {sorted.yours.length > 0 ? (
                      <ul aria-label="Your apps" className="grid gap-3 pt-2 lg:grid-cols-2">
                        {sorted.yours.map(entry => (
                          <li key={entryKey(entry)} className="min-w-0 rounded-2xl border bg-card">
                            {renderEntry(entry)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <StatePanel
                        kind="empty"
                        heading="h3"
                        icon={Plug}
                        title={`None of your apps match ${searched}`}
                        description="Try Browse to find apps you haven’t connected."
                      >
                        <Button variant="outline" onClick={() => setView('browse')}>
                          Search Browse
                        </Button>
                      </StatePanel>
                    )}
                  </TabsContent>
                  <TabsContent value="browse">
                    <div className="space-y-8 pt-2">
                      {sorted.connectable.length > 0 ? (
                        <ul aria-label={needle ? 'Search results' : 'Apps you can connect'} className={gridClass}>
                          {sorted.connectable.map(entry => (
                            <li key={entryKey(entry)}>{renderEntry(entry)}</li>
                          ))}
                        </ul>
                      ) : (
                        !needle && (
                          <p className="text-sm text-muted-foreground">You’ve connected every app available to you.</p>
                        )
                      )}
                      {sorted.unavailable.length > 0 && (
                        <section aria-labelledby="section-unavailable" className="space-y-2">
                          <h2 id="section-unavailable" className="text-sm font-medium text-muted-foreground">
                            Not available to connect
                          </h2>
                          <ul className={gridClass}>
                            {sorted.unavailable.map(entry => (
                              <li key={entryKey(entry)}>{renderEntry(entry)}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {mcp.capabilities ? (
                        <McpMore
                          api={mcp.api}
                          capabilities={mcp.capabilities}
                          slug={slug}
                          query={needle}
                          found={sorted.connectable.length + sorted.unavailable.length > 0}
                          clear={() => setQuery('')}
                          setup={setSetup}
                        />
                      ) : (
                        needle &&
                        !sorted.connectable.length &&
                        !sorted.unavailable.length && (
                          <StatePanel
                            kind="empty"
                            heading="h3"
                            icon={Plug}
                            title={`No apps match ${searched}`}
                            description="Try another name or clear your search."
                          >
                            <Button variant="outline" onClick={() => setQuery('')}>
                              Clear search
                            </Button>
                          </StatePanel>
                        )
                      )}
                    </div>
                  </TabsContent>
                </>
              )}
            </Tabs>
            {/* Room under the last section, so the floating chat button never covers it. */}
            <div aria-hidden="true" className="h-18" />
          </div>
        </fieldset>
      </div>
    </PageContent>
  );
}

type Setup = { entry?: CatalogEntry; hosted?: boolean } | null;

/** Registry results while searching. */
function McpMore({
  api,
  capabilities,
  slug,
  query,
  found,
  clear,
  setup: setSetup,
}: {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  query: string;
  found: boolean;
  clear: () => void;
  setup: (setup: Setup) => void;
}) {
  const hosted = useFlag('hosted-mcp') && capabilities.hosted;
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  return (
    search &&
    search === query && (
      <div className="pt-4">
        <Registry
          api={api}
          capabilities={capabilities}
          slug={slug}
          search={search}
          hosted={hosted}
          found={found}
          disabled={!capabilities.integrationsEnabled}
          choose={entry => setSetup({ entry })}
          clear={clear}
        />
      </div>
    )
  );
}

function Registry({
  api,
  capabilities,
  slug,
  search,
  hosted,
  found,
  disabled,
  choose,
  clear,
}: {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  search: string;
  hosted: boolean;
  found: boolean;
  disabled: boolean;
  choose: (entry: CatalogEntry) => void;
  clear: () => void;
}) {
  const read = useMcpCatalog(api, search, '');
  if (read.state.kind === 'loading')
    return (
      <div role="status" aria-label="Searching the MCP Registry" className="space-y-2">
        <Skeleton />
        <Skeleton />
      </div>
    );
  if (read.state.kind !== 'ready') return null;
  const entries = read.state.data.entries
    .filter(entry => (hosted || !entry.package) && entry.compatibility !== 'unsupported')
    .filter(entry => !entry.endpoint || !mcpAppForEndpoint(entry.endpoint))
    .slice(0, 8);
  if (!entries.length)
    return found ? null : (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Plug}
        title={`No apps match “${search}”`}
        description="Try another name, or add the server by its URL below."
      >
        <Button variant="outline" onClick={clear}>
          Clear search
        </Button>
      </StatePanel>
    );
  return (
    <section aria-labelledby="section-registry" aria-describedby="section-registry-note" className="space-y-3">
      <div className="space-y-0.5">
        <h2 id="section-registry" className="text-sm font-medium text-muted-foreground">
          Community
        </h2>
        <p id="section-registry-note" className="text-sm text-muted-foreground">
          From the MCP Registry, not the app’s maker. Check before you connect.
        </p>
      </div>
      <ul className={gridClass}>
        {entries.map(entry => (
          <li key={entry.id}>
            <RegistryRow
              api={api}
              capabilities={capabilities}
              entry={entry}
              slug={slug}
              disabled={disabled}
              setUp={() => choose(entry)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Remote servers that sign in with OAuth, or need nothing, connect in one click. Others need their keys first. */
function RegistryRow({
  api,
  capabilities,
  entry,
  slug,
  disabled,
  setUp,
}: {
  api: McpApi;
  capabilities: Capabilities;
  entry: CatalogEntry;
  slug: string;
  disabled: boolean;
  setUp: () => void;
}) {
  const navigate = useNavigate();
  const page = (id: string) => `${mcpPagePrefix}${id}`;
  // The registry often doesn't say how a server signs in: try without sign-in first, then OAuth.
  const [authentication, setAuthentication] = useState<'none' | 'oauth'>(
    entry.authentication === 'oauth' ? 'oauth' : 'none',
  );
  const [retry, setRetry] = useState<Ownership | null>(null);
  const flow = useMcpConnect({
    api,
    name: entry.name,
    endpoint: entry.endpoint,
    authentication,
    existing: undefined,
    refresh: async () => {},
    opened: result => {
      // Sign-in returns to the page it started from, so start it from the new connection's page.
      if (result.kind === 'oauth')
        window.history.replaceState(window.history.state, '', `/${slug}/integrations/${page(result.integration.id)}`);
      else
        void navigate({
          to: '/$workspaceSlug/integrations/$integrationId',
          params: { workspaceSlug: slug, integrationId: page(result.integration.id) },
        });
    },
  });
  const connect = (ownership: Ownership) => {
    setRetry(ownership);
    flow.connect(ownership);
  };
  const choice = useOwnershipChoice(capabilities, connect);
  const fallBack =
    flow.command.state.kind === 'error' && authentication === 'none' && entry.authentication === 'unknown';
  useEffect(() => {
    if (fallBack) {
      flow.command.reset();
      setAuthentication('oauth');
    }
  }, [fallBack, flow.command]);
  useEffect(() => {
    if (authentication === 'oauth' && retry && entry.authentication === 'unknown') flow.connect(retry);
    // Runs once, when the no-sign-in attempt falls back to OAuth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authentication]);
  const oneClick = !entry.package && ['oauth', 'none', 'unknown'].includes(entry.authentication) && !!entry.endpoint;
  const failed = flow.command.state.kind === 'error' && !fallBack;
  return (
    <>
      <Row
        icon={<AppIcon tile={{ letter: monogram(entry.name), color: 'var(--muted-foreground)' }} size="lg" />}
        name={readableName(entry.name)}
        title={entry.name}
        description={
          failed
            ? 'Couldn’t connect. The server may be down, or it may need details only you can add.'
            : sentence(entry.description) || (entry.package ? packageLabel(entry.package) : (entry.endpoint ?? ''))
        }
        tone={failed ? 'error' : 'muted'}
        link={null}
        actions={
          disabled ? (
            <Unavailable label="Turned off" reason={turnedOff} />
          ) : oneClick && !failed ? (
            <Start
              label={flow.command.busy ? 'Connecting…' : 'Connect'}
              name={readableName(entry.name)}
              busy={flow.command.busy}
              onClick={choice.start}
            />
          ) : (
            <Button variant="outline" size="sm" aria-label={`Set up ${readableName(entry.name)}`} onClick={setUp}>
              Set up
            </Button>
          )
        }
      />
      {choice.dialog(entry.name)}
    </>
  );
}

/** The first letter of a registry server's own name, after any `io.github.owner/` style namespace. */
const monogram = (name: string) =>
  (
    name
      .split('/')
      .at(-1)
      ?.match(/[a-z0-9]/i)?.[0] ?? '?'
  ).toUpperCase();
/** Registry names are often ids such as `io.github.owner/some-server`: show `Some server`. */
const readableName = (name: string) =>
  name.includes('/') ? sentence((name.split('/').at(-1) ?? name).replace(/[-_]+/g, ' ').trim()) || name : name;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Rows bleed into the page margin so their logos line up with the tabs above.
const gridClass = '-mx-4 grid grid-cols-apps gap-x-8 gap-y-2';
type Tone = 'muted' | 'warning' | 'error' | 'pending';
type LinkProps = ReturnType<typeof useLinkProps>;

/**
 * One app: logo, name and what it does, with its actions on the right. The name is the link to the app's page,
 * stretched over the whole row, so the actions stay separate controls beside it.
 */
function Row({
  icon,
  name,
  description,
  tone = 'muted',
  link,
  title,
  actions,
  connected = false,
}: {
  icon: ReactNode;
  name: string;
  title?: string;
  description: string;
  tone?: Tone;
  link: LinkProps | null;
  actions?: ReactNode;
  connected?: boolean;
}) {
  // A word beside the mark, so the state never rests on colour alone.
  const state =
    tone === 'warning'
      ? { mark: 'warning' as const, label: 'Needs attention', text: 'text-warning' }
      : connected && tone !== 'error'
        ? { mark: 'success' as const, label: 'Connected', text: 'text-primary-text' }
        : null;
  return (
    <div
      className={`app-row relative flex h-16 items-center gap-3 rounded-2xl px-4 transition-colors sm:h-20 sm:gap-4 ${link ? 'hover:bg-muted/60' : ''}`}
    >
      <span className="relative shrink-0">
        {icon}
        {tone !== 'muted' && !state && (
          <span className="absolute -top-1 -right-1 flex rounded-full bg-background p-0.5">
            <StatusMark state={tone} size="sm" aria-hidden="true" tooltip={false} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        {link ? (
          <a
            {...link}
            className="block truncate text-base font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {name}
          </a>
        ) : (
          <span className="block truncate text-base font-medium text-foreground" title={title}>
            {name}
          </span>
        )}
        {state ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" title={description}>
            <StatusMark state={state.mark} size="sm" aria-hidden="true" tooltip={false} />
            <span className={`shrink-0 font-medium ${state.text}`}>{state.label}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{description}</span>
          </span>
        ) : (
          <span
            className={`block truncate text-sm ${tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
            title={description}
          >
            {description}
          </span>
        )}
      </span>
      {actions && <span className="relative z-10 flex shrink-0 items-center whitespace-nowrap">{actions}</span>}
    </div>
  );
}

function DirectorySkeleton() {
  return (
    <ul role="status" aria-label="Loading apps" className={gridClass}>
      {Array.from({ length: 9 }, (_, index) => (
        <li key={index} aria-hidden="true" className="flex h-16 items-center gap-3 px-4 sm:h-20 sm:gap-4">
          <span className="block size-10 shrink-0 overflow-hidden rounded-xl sm:size-12">
            <Skeleton shape="panel" />
          </span>
          <span className="block min-w-0 flex-1 space-y-2">
            <span className="block w-24">
              <Skeleton />
            </span>
            <span className="block w-40 max-w-full">
              <Skeleton />
            </span>
          </span>
          <span className="block w-20 shrink-0">
            <Skeleton shape="action" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Gives a button a reason: a tooltip on hover or focus, and its accessible description. */
function Explained({
  reason,
  children,
}: {
  reason: string | undefined;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}) {
  const id = useId();
  if (!reason) return children;
  return (
    <>
      {/* A disabled button ignores pointer events, so the wrapper opens the tooltip; focus still reaches it from the button. */}
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          {cloneElement(children, { 'aria-describedby': id })}
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={id} hidden>
        {reason}
      </span>
    </>
  );
}

/**
 * Why an app can't be connected here, in place of its button: a short label anyone can see, with the full reason
 * in a tooltip on hover or focus and in the label's accessible description.
 */
function Unavailable({ label, reason }: { label: string; reason: string }) {
  const id = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus is how keyboard users reach the reason.
              tabIndex={0}
              aria-describedby={id}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <InfoCircle aria-hidden="true" size={14} />
          {label}
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={id} hidden>
        {reason}
      </span>
    </>
  );
}

/** Opens the app's own page, on the tab where it's set up. */
function Configure({
  slug,
  id,
  name,
  tab,
  label = 'Manage',
  returnChat,
  reason,
  urgent = false,
}: {
  slug: string;
  id: string;
  name: string;
  tab?: Exclude<IntegrationTab, 'overview'> | undefined;
  label?: string;
  returnChat: string | undefined;
  reason?: string | undefined;
  urgent?: boolean;
}) {
  return (
    <Explained reason={reason}>
      <Button
        variant={urgent ? 'secondary' : 'outline'}
        size="sm"
        nativeButton={false}
        aria-label={`${label} ${name}`}
        render={
          <Link
            to="/$workspaceSlug/integrations/$integrationId"
            params={{ workspaceSlug: slug, integrationId: id }}
            search={{ tab, returnChat }}
          />
        }
      >
        {label}
      </Button>
    </Explained>
  );
}

function Start({
  label,
  name,
  busy,
  reason,
  urgent = false,
  onClick,
}: {
  label: string;
  name: string;
  busy: boolean;
  reason?: string | undefined;
  urgent?: boolean;
  onClick: () => void;
}) {
  return (
    <Explained reason={reason}>
      <Button
        variant={urgent ? 'secondary' : 'outline'}
        size="sm"
        disabled={busy}
        aria-busy={busy}
        aria-label={`${label} ${name}`}
        onClick={onClick}
      >
        {busy && <Spinner aria-hidden="true" />}
        {label}
      </Button>
    </Explained>
  );
}

const pageLink = (slug: string, id: string, returnChat: string | undefined) =>
  ({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: id },
    search: { returnChat },
  }) as const;

/** A built-in app. Connect and Reconnect start the same sign-in its own page does. */
function AppRow({
  app,
  status,
  workspaceId,
  slug,
  admin,
  returnChat,
}: {
  app: Integration;
  status: Status | null;
  workspaceId: string;
  slug: string;
  admin: boolean;
  returnChat: string | undefined;
}) {
  const link = useLinkProps(pageLink(slug, app.id, returnChat));
  const changes = useIntegrationChanges();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const start = async () => {
    const run = connector(app, workspaceId);
    if (!run || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await run();
      if (app.provider === 'google' || app.provider === 'slack') await changes.authority(app.provider);
    } catch {
      setFailed(true);
      setBusy(false);
      lock.current = false;
    }
  };
  const action = actionFor(app, status, admin);
  const settings = tabsFor(app, admin).includes('settings') ? ('settings' as const) : undefined;
  const configure = <Configure slug={slug} id={app.id} name={app.name} tab={settings} returnChat={returnChat} />;
  const icon = <AppIcon brand={app.brand} size="lg" />;
  if (app.provider === 'soon')
    return (
      <Row
        icon={icon}
        name={app.name}
        description={app.blurb}
        link={null}
        actions={<Badge variant="secondary">Coming soon</Badge>}
      />
    );
  if (status?.kind === 'loading')
    return (
      <Row
        icon={icon}
        name={app.name}
        description={app.blurb}
        link={link}
        actions={
          <span className="block w-20" role="status" aria-label={`Checking ${app.name}`}>
            <Skeleton shape="action" />
          </span>
        }
      />
    );
  const hint = action.kind === 'none' ? action.hint : undefined;
  // Connect and Reconnect: a sign-in where the app has one, otherwise the tab where it's set up.
  const begin = (label: string, reason?: string) =>
    action.kind === 'connect' ? (
      <Start label={label} name={app.name} busy={busy} reason={reason} urgent={!!reason} onClick={() => void start()} />
    ) : action.kind === 'settings' ? (
      <Configure
        slug={slug}
        id={app.id}
        name={app.name}
        tab={settings}
        label={label}
        returnChat={returnChat}
        reason={reason}
        urgent={!!reason}
      />
    ) : (
      <Unavailable
        label={app.provider === 'slack' ? 'Ask for access' : 'Ask an admin'}
        reason={hint ?? 'You can’t connect it here.'}
      />
    );
  // The subtitle says what the app does, or which account it uses once connected.
  // A failed start replaces it until the next try.
  const account = status?.kind === 'connected' ? status.detail : status?.kind === 'attention' ? status.detail : null;
  const row = (actions: ReactNode, tone: Tone = 'muted') => (
    <Row
      connected={isConnected(status)}
      icon={icon}
      name={app.name}
      description={failed ? `Couldn’t connect ${app.name}. Try again.` : (account ?? app.blurb)}
      tone={failed ? 'error' : tone}
      link={link}
      actions={actions}
    />
  );
  switch (status?.kind) {
    case 'connected':
      return row(
        <Configure slug={slug} id={app.id} name={app.name} tab={settings} returnChat={returnChat} reason={hint} />,
      );
    case 'installed':
      return row(
        <Configure slug={slug} id={app.id} name={app.name} tab={settings} returnChat={returnChat} reason={hint} />,
        'pending',
      );
    case 'attention':
      // One action per row; Configure is on the app's page, which the row opens.
      return row(begin('Reconnect', status.detail), 'warning');
    case 'error':
      return row(
        <Unavailable label="Couldn’t check" reason="Couldn’t check this app. Select Check again at the top." />,
        'error',
      );
    case 'unavailable':
      return row(
        status.detail === notSetUp ? (
          <Unavailable label="Not offered" reason="Not offered here. Your workspace admins can’t turn it on." />
        ) : status.detail === notYet ? (
          <Unavailable label="Unavailable" reason={`${notYet}.`} />
        ) : (
          <Unavailable
            label={app.provider === 'slack' ? 'Ask for access' : 'Unavailable'}
            reason={`${status.detail}.`}
          />
        ),
      );
    case 'off':
      return row(begin('Connect'));
    default:
      // Workflow triggers have no sign-in; they're set up on their page.
      return row(configure);
  }
}

/** An app whose maker runs an official MCP server, before anyone has connected it. */
function CuratedRow({
  app,
  api,
  capabilities,
  slug,
  returnChat,
  refresh,
}: {
  app: McpApp;
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  returnChat: string | undefined;
  refresh: () => Promise<void>;
}) {
  const link = useLinkProps(pageLink(slug, app.id, returnChat));
  // Apps that need an account address or an API key ask for them on their own page.
  const direct = app.auth !== 'api-key' && !app.variables.length;
  const flow = useMcpConnect({
    api,
    name: app.name,
    endpoint: app.endpoint,
    authentication: app.auth === 'none' ? 'none' : 'oauth',
    existing: undefined,
    refresh,
    // Sign-in returns to the page it started from, so start it from the new connection's page.
    opened: result => {
      if (result.kind === 'oauth')
        window.history.replaceState(
          window.history.state,
          '',
          `/${slug}/integrations/${mcpPagePrefix}${result.integration.id}`,
        );
    },
  });
  const choice = useOwnershipChoice(capabilities, flow.connect, app.auth === 'oauth');
  const failed = flow.command.state.kind === 'error' ? flow.command.state.message : null;
  return (
    <>
      <Row
        icon={<AppIcon brand={app.brand} tile={app.tile} logo={app.logo} size="lg" />}
        name={app.name}
        description={failed ? `Couldn’t connect. ${failed}` : app.tagline}
        tone={failed ? 'error' : 'muted'}
        link={link}
        actions={
          !capabilities.integrationsEnabled ? (
            <Unavailable label="Turned off" reason={turnedOff} />
          ) : direct ? (
            <Start label="Connect" name={app.name} busy={flow.command.busy} onClick={choice.start} />
          ) : (
            <Configure slug={slug} id={app.id} name={app.name} label="Connect" returnChat={returnChat} />
          )
        }
      />
      {choice.dialog(app.name)}
    </>
  );
}

/** A connected MCP server, beside built-in apps. */
function ServerRow({
  server,
  api,
  capabilities,
  slug,
  returnChat,
  refresh,
}: {
  server: McpIntegration;
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  returnChat: string | undefined;
  refresh: () => Promise<void>;
}) {
  const brand = brandOf(server);
  const name = brand?.name ?? server.name;
  const id = `${mcpPagePrefix}${server.id}`;
  const link = useLinkProps(pageLink(slug, id, returnChat));
  const flow = useMcpConnect({
    api,
    name,
    endpoint: server.endpoint,
    authentication: 'oauth',
    existing: server,
    refresh,
    opened: result => {
      if (result.kind === 'oauth') window.history.replaceState(window.history.state, '', `/${slug}/integrations/${id}`);
    },
  });
  const attention = mcpNeedsAttention(server);
  const lapsed = server.reauthorizationRequired || server.status === 'disconnected';
  // The same sign-in the server's page offers; a client ID it still needs is asked for there.
  const signIn =
    server.kind === 'remote' &&
    server.authMethod === 'oauth' &&
    server.canManage &&
    (lapsed || ['setup', 'oauth-pending'].includes(server.status));
  const failed = flow.command.state.kind === 'error' ? flow.command.state.message : null;
  const label =
    server.reauthorizationRequired && server.status !== 'review-required'
      ? 'Sign-in expired'
      : mcpStatusLabel[server.status];
  // Once it works, the subtitle says whose account it is and who shares it.
  // Someone else's connection says only that it's shared; their account is theirs to show.
  const about = !server.canManage
    ? 'Shared with you'
    : [
        server.accountLabel ?? (server.package ? packageLabel(server.package) : null),
        server.ownership === 'shared' ? 'Shared with workspace' : 'Only you',
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <Row
      icon={<AppIcon brand={brand?.brand} tile={brand?.tile} logo={brand?.logo} size="lg" />}
      name={name}
      description={failed ? `Couldn’t connect. ${failed}` : attention ? label : about}
      tone={failed ? 'error' : attention ? 'warning' : server.status === 'discovering' ? 'pending' : 'muted'}
      connected={!attention && server.status === 'ready'}
      link={link}
      actions={
        // One action per row, the most pressing first; the rest are on the server's page, which the row opens.
        signIn ? (
          capabilities.integrationsEnabled ? (
            <Start
              label={lapsed ? 'Reconnect' : server.status === 'oauth-pending' ? 'Finish sign-in' : 'Finish setup'}
              name={name}
              busy={flow.command.busy}
              reason={label}
              urgent
              onClick={() => flow.connect(server.ownership)}
            />
          ) : (
            <Unavailable label="Turned off" reason={turnedOff} />
          )
        ) : server.status === 'review-required' ? (
          <Configure
            slug={slug}
            id={id}
            name={name}
            tab="tools"
            label="Review tools"
            returnChat={returnChat}
            reason={label}
            urgent
          />
        ) : (
          <Configure
            slug={slug}
            id={id}
            name={name}
            returnChat={returnChat}
            reason={attention ? label : undefined}
            urgent={attention}
          />
        )
      }
    />
  );
}
