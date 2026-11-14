import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLinkProps, useLocation, useNavigate } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { Plug } from 'reicon-react/icons/Plug';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status as StatusMark } from '@tulipfarm/sprout/status';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { AppIcon } from '@/features/integrations/app-icon';
import { categories, integrationFromHash, integrations, type Integration } from '@/features/integrations/catalog';
import { mcpAppById, mcpAppForEndpoint, mcpApps, mcpPagePrefix, type McpApp } from '@/features/integrations/mcp-apps';
import { statusOf, useIntegrationStatus, type Status } from '@/features/integrations/status';
import { WorkspaceRefreshNotice } from '@/features/integrations/workspace-refresh';
import type { McpApi } from '@/features/workspace-mcp/api';
import { useOwnershipChoice } from '@/features/workspace-mcp/app-page';
import { useMcpConnect, type Ownership } from '@/features/workspace-mcp/connect';
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

type Filter = 'all' | 'connected' | 'attention';
const available = integrations.filter(app => app.provider !== 'soon');
// A 'soon' app whose maker now runs an MCP server is listed from the catalog instead.
const upcoming = integrations.filter(app => app.provider === 'soon' && !mcpAppById(app.id));
const isConnected = (status: Status | null) => status?.kind === 'connected' || status?.kind === 'installed';
const needsAttention = (status: Status | null) => status?.kind === 'attention' || status?.kind === 'error';
const mcpNeedsAttention = (server: McpIntegration) =>
  server.status === 'error' ||
  server.status === 'disconnected' ||
  server.status === 'review-required' ||
  !!server.reauthorizationRequired;
const brandOf = (server: McpIntegration) => (server.endpoint ? mcpAppForEndpoint(server.endpoint) : undefined);
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
/** `hidden` counts catalog apps left out until someone asks to see the whole category. */
type Section = { title: string; entries: Entry[]; hidden?: number };
const sectionSize = 5;
const entryKey = (entry: Entry) => (entry.kind === 'server' ? entry.server.id : `${entry.kind}:${entry.app.id}`);

function useMcpDirectory(workspaceId: string) {
  const api = useMcpApi(workspaceId);
  const read = useMcpCapabilities(api);
  const capabilities = read.state.kind === 'ready' && read.state.data.enabled ? read.state.data : null;
  const list = useMcpIntegrations(api, !!capabilities);
  const servers = useMemo(() => (list.state.kind === 'ready' ? list.state.data.integrations : []), [list.state]);
  return { api, capabilities, servers };
}

function IntegrationsContent({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { workspaceStale } = workspaceRoute.useRouteContext();
  const { returnChat } = integrationsRoute.useSearch();
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId);
  const mcp = useMcpDirectory(workspaceId);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const loading = Object.values(statuses).some(status => status.kind === 'loading');
  const errors = Object.entries(statuses).filter(([, status]) => status.kind === 'error');
  const connected = available.filter(app => isConnected(statusOf(statuses, app)));
  const attention = available.filter(app => needsAttention(statusOf(statuses, app)));
  const servers = mcp.servers;
  const curated = useMemo(() => {
    if (!mcp.capabilities) return [];
    const linked = new Set(
      servers.filter(server => server.canManage || server.canUse).map(server => brandOf(server)?.id),
    );
    return mcpApps.filter(app => !linked.has(app.id));
  }, [mcp.capabilities, servers]);

  const sections = useMemo((): Section[] => {
    const apps = (list: Integration[]) => list.map(app => ({ kind: 'app', app }) as const);
    const listed = (list: McpApp[]) => list.map(app => ({ kind: 'curated', app }) as const);
    const connections = (list: McpIntegration[]) => list.map(server => ({ kind: 'server', server }) as const);
    if (needle) {
      const match = (text: string) => text.toLowerCase().includes(needle);
      return [
        {
          title: 'Results',
          entries: [
            ...connections(servers.filter(server => match(`${server.name} ${brandOf(server)?.name ?? ''}`))),
            ...apps(integrations.filter(app => match(`${app.name} ${app.blurb} ${app.category}`))),
            ...listed(curated.filter(app => match(`${app.name} ${app.blurb} ${app.maker} ${app.category}`))),
          ],
        },
      ];
    }
    if (filter === 'connected')
      return [
        {
          title: 'Connected',
          entries: [...apps(connected), ...connections(servers.filter(server => server.status === 'ready'))],
        },
      ];
    if (filter === 'attention')
      return [
        { title: 'Needs attention', entries: [...apps(attention), ...connections(servers.filter(mcpNeedsAttention))] },
      ];
    const linked = [...apps([...connected, ...attention]), ...connections(servers)];
    const unlinked = available.filter(app => !connected.includes(app) && !attention.includes(app));
    return [
      ...(linked.length ? [{ title: 'Connected', entries: linked }] : []),
      ...categories
        .map(category => {
          const builtIn = apps(unlinked.filter(app => app.category === category));
          const catalog = listed(curated.filter(app => app.category === category));
          const shown = expanded.has(category) ? catalog.length : Math.max(0, sectionSize - builtIn.length);
          return {
            title: category,
            entries: [...builtIn, ...catalog.slice(0, shown)],
            hidden: catalog.length - Math.min(shown, catalog.length),
          };
        })
        .filter(section => section.entries.length),
    ];
  }, [needle, filter, connected, attention, servers, curated, expanded]);

  const empty = (title: string) =>
    needle ? null : loading ? (
      <StatePanel kind="loading" title="Checking your apps" description="Loading each app’s status." />
    ) : errors.length ? (
      <StatePanel kind="error" title="App status couldn’t be confirmed" description="Check each app’s status again.">
        <Button variant="outline" onClick={() => void refresh()}>
          Check app status again
        </Button>
      </StatePanel>
    ) : title === 'Needs attention' ? (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Plug}
        title="Nothing needs attention"
        description="Every connected app is working."
      >
        <Button variant="outline" onClick={() => setFilter('all')}>
          Show all apps
        </Button>
      </StatePanel>
    ) : (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Plug}
        title="Nothing connected yet"
        description="Connect the apps your team already uses, like Slack, Gmail, or GitHub."
      >
        <Button onClick={() => setFilter('all')}>Browse apps</Button>
      </StatePanel>
    );

  return (
    <PageContent>
      <PageHeader
        title="Integrations"
        description="Connect the apps your agents work in."
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
        <div className="max-w-4xl space-y-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchField
              label="Search apps"
              value={query}
              onChange={setQuery}
              placeholder="Search apps, like PostHog or Jira"
            />
            <div className="shrink-0 overflow-x-auto">
              <ToggleGroup
                aria-label="Show apps"
                variant="outline"
                size="sm"
                spacing={0}
                value={[filter]}
                onValueChange={value => {
                  const next = value[0] as Filter | undefined;
                  if (!next) return;
                  setFilter(next);
                  setQuery('');
                }}
              >
                <ToggleGroupItem value="all">All</ToggleGroupItem>
                <ToggleGroupItem value="connected">
                  Connected{' '}
                  <Count
                    value={
                      loading ? null : connected.length + servers.filter(server => server.status === 'ready').length
                    }
                  />
                </ToggleGroupItem>
                <ToggleGroupItem value="attention">
                  Needs attention{' '}
                  <Count value={loading ? null : attention.length + servers.filter(mcpNeedsAttention).length} />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
          {errors.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <ul className="space-y-1">
                    {errors.map(([provider, status]) => (
                      <li key={provider}>
                        Couldn’t check{' '}
                        {available
                          .filter(app => app.provider === provider)
                          .map(app => app.name)
                          .join(', ')}
                        . {status.kind === 'error' && status.detail}
                      </li>
                    ))}
                  </ul>
                  <Button variant="outline" size="sm" disabled={refreshing} aria-busy={refreshing} onClick={refresh}>
                    {refreshing ? 'Checking…' : 'Check again'}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {sections.map(section =>
            section.entries.length || !needle ? (
              <section key={section.title} aria-labelledby={`section-${section.title}`} className="space-y-2">
                <h2 id={`section-${section.title}`} className="text-sm font-medium text-muted-foreground">
                  {section.title}
                </h2>
                {section.entries.length ? (
                  <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {section.entries.map(entry => (
                      <li key={entryKey(entry)}>
                        {entry.kind === 'app' ? (
                          <Row app={entry.app} status={statusOf(statuses, entry.app)} slug={slug} />
                        ) : entry.kind === 'curated' ? (
                          <CuratedRow app={entry.app} slug={slug} />
                        ) : (
                          <ServerRow server={entry.server} slug={slug} />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  empty(section.title)
                )}
                {!!section.hidden && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded(current => new Set(current).add(section.title))}
                  >
                    Show {section.hidden} more
                  </Button>
                )}
              </section>
            ) : null,
          )}
          {mcp.capabilities ? (
            <McpMore
              api={mcp.api}
              capabilities={mcp.capabilities}
              slug={slug}
              query={needle}
              found={sections.some(section => section.entries.length)}
              clear={() => setQuery('')}
            />
          ) : (
            needle &&
            !sections.some(section => section.entries.length) && (
              <StatePanel
                kind="empty"
                heading="h3"
                icon={Plug}
                title={`No apps match “${query.trim()}”`}
                description="Try another name or clear your search."
              >
                <Button variant="outline" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              </StatePanel>
            )
          )}
          {filter === 'all' && !needle && upcoming.length > 0 && (
            <section aria-labelledby="section-soon" className="space-y-3">
              <h2 id="section-soon" className="text-sm font-medium text-muted-foreground">
                Coming soon
              </h2>
              <ul className="flex flex-wrap gap-2">
                {upcoming.map(app => (
                  <li
                    key={app.id}
                    className="flex h-7 items-center gap-2 rounded-lg border border-border px-2.5 text-sm text-muted-foreground"
                  >
                    <BrandIcon brand={app.brand} size="glyph" />
                    {app.name}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </fieldset>
    </PageContent>
  );
}

type Setup = { entry?: CatalogEntry; hosted?: boolean } | null;

/** Registry results while searching, and a way to add any server that isn't listed. */
function McpMore({
  api,
  capabilities,
  slug,
  query,
  found,
  clear,
}: {
  api: McpApi;
  capabilities: Capabilities;
  slug: string;
  query: string;
  found: boolean;
  clear: () => void;
}) {
  const navigate = useNavigate();
  const hosted = useFlag('hosted-mcp') && capabilities.hosted;
  const [setup, setSetup] = useState<Setup>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  const open = (id: string) =>
    void navigate({
      to: '/$workspaceSlug/integrations/$integrationId',
      params: { workspaceSlug: slug, integrationId: `${mcpPagePrefix}${id}` },
    });
  return (
    <div className="space-y-8">
      {search && search === query && (
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
      )}
      <p className="text-sm text-muted-foreground">
        Can’t find an app?{' '}
        <Button variant="link" size="sm" disabled={!capabilities.integrationsEnabled} onClick={() => setSetup({})}>
          Add a server by URL
        </Button>
        {hosted && (
          <>
            {', '}
            <Button
              variant="link"
              size="sm"
              disabled={!capabilities.integrationsEnabled}
              onClick={() => setSetup({ hosted: true })}
            >
              run an MCP package
            </Button>
          </>
        )}{' '}
        or ask in chat.
      </p>
      {setup && (
        <McpSetup
          key={setup.entry?.id ?? (setup.hosted ? 'hosted' : 'manual')}
          api={api}
          capabilities={capabilities}
          entry={setup.entry}
          hosted={setup.hosted}
          close={() => setSetup(null)}
          saved={open}
          // Sign-in comes back to the page that started it, so start it from the new server's page.
          authorizing={id =>
            window.history.replaceState(window.history.state, '', `/${slug}/integrations/${mcpPagePrefix}${id}`)
          }
        />
      )}
    </div>
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
    <section aria-labelledby="section-registry" className="space-y-2">
      <h2 id="section-registry" className="text-sm font-medium text-muted-foreground">
        More from the MCP Registry
      </h2>
      <p className="text-sm text-muted-foreground">
        Made by the community, not the app’s maker. Check before you connect.
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
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
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <AppIcon />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{entry.name}</span>
        <span className="block truncate text-sm text-muted-foreground" title={entry.description}>
          {failed
            ? 'Couldn’t connect. The server may be down, or it may need details only you can add.'
            : entry.description || (entry.package ? packageLabel(entry.package) : entry.endpoint)}
        </span>
      </span>
      {oneClick && !failed ? (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || flow.command.busy}
          aria-busy={flow.command.busy}
          onClick={choice.start}
        >
          {flow.command.busy ? 'Connecting…' : 'Connect'}
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={setUp}>
          Set up
        </Button>
      )}
      {choice.dialog(entry.name)}
    </div>
  );
}

const rowClass =
  'flex min-h-16 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/** An app whose maker runs an official MCP server, before anyone has connected it. */
function CuratedRow({ app, slug }: { app: McpApp; slug: string }) {
  const link = useLinkProps({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: app.id },
  });
  return (
    <a {...link} className={rowClass}>
      <AppIcon brand={app.brand} tile={app.tile} logo={app.logo} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{app.name}</span>
        <span className="block truncate text-sm text-muted-foreground">{app.blurb}</span>
      </span>
      <span className="w-28 shrink-0 text-end text-sm text-muted-foreground sm:w-40">Not connected</span>
      <span className="w-4 shrink-0 text-muted-foreground">
        <ChevronRightIcon aria-hidden="true" className="size-4" />
      </span>
    </a>
  );
}

/** A connected MCP server, in the same list as built-in apps. */
function ServerRow({ server, slug }: { server: McpIntegration; slug: string }) {
  const brand = brandOf(server);
  const link = useLinkProps({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: `${mcpPagePrefix}${server.id}` },
  });
  const attention = mcpNeedsAttention(server);
  const mark =
    server.status === 'ready' ? 'success' : attention ? 'warning' : server.status === 'disabled' ? null : 'pending';
  const sub = [
    server.accountLabel ?? (server.package ? packageLabel(server.package) : null),
    server.ownership === 'shared' ? 'Shared' : 'Just you',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <a {...link} className={rowClass}>
      <AppIcon brand={brand?.brand} tile={brand?.tile} logo={brand?.logo} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{brand?.name ?? server.name}</span>
        <span className="block truncate text-sm text-muted-foreground">{sub}</span>
      </span>
      <span
        className={
          mark
            ? 'flex w-28 shrink-0 items-center justify-end gap-1.5 text-sm font-medium text-foreground sm:w-40'
            : 'w-28 shrink-0 text-end text-sm text-muted-foreground sm:w-40'
        }
      >
        {mark && <StatusMark state={mark} size="sm" aria-hidden="true" tooltip={false} />}
        {server.status === 'ready'
          ? 'Connected'
          : server.status === 'review-required'
            ? 'Tools changed'
            : attention
              ? 'Needs attention'
              : server.status === 'disabled'
                ? 'Turned off'
                : 'Connecting'}
      </span>
      <span className="w-4 shrink-0 text-muted-foreground">
        <ChevronRightIcon aria-hidden="true" className="size-4" />
      </span>
    </a>
  );
}

function Count({ value }: { value: number | null }) {
  return (
    <span className="inline-block w-4 text-end text-muted-foreground tabular-nums">{value === null ? '–' : value}</span>
  );
}

function Row({ app, status, slug }: { app: Integration; status: Status | null; slug: string }) {
  const soon = app.provider === 'soon';
  const link = useLinkProps({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: app.id },
  });
  const body = (
    <>
      <BrandIcon brand={app.brand} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{app.name}</span>
        <span className="block truncate text-sm text-muted-foreground">{app.blurb}</span>
      </span>
      <StatusCell app={app} status={status} />
      <span className="w-4 shrink-0 text-muted-foreground">
        {!soon && <ChevronRightIcon aria-hidden="true" className="size-4" />}
      </span>
    </>
  );
  if (soon) return <div className="flex min-h-16 items-center gap-3 px-4 py-3">{body}</div>;
  return (
    <a
      {...link}
      className="flex min-h-16 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {body}
    </a>
  );
}

const marks = {
  connected: 'success',
  installed: 'pending',
  attention: 'warning',
  error: 'error',
} as const;

/** A fixed-width column so rows don’t move while each app’s status loads. */
function StatusCell({ app, status }: { app: Integration; status: Status | null }) {
  const label = statusLabel(app, status);
  const detail = status?.kind === 'connected' ? status.detail : null;
  const mark = status && status.kind in marks ? marks[status.kind as keyof typeof marks] : null;
  return (
    <span className="flex w-28 shrink-0 flex-col items-end text-end sm:w-40">
      {status?.kind === 'loading' ? (
        <span className="block w-16" role="status" aria-label="Checking status">
          <Skeleton />
        </span>
      ) : (
        <>
          <span
            className={
              mark ? 'flex items-center gap-1.5 text-sm font-medium text-foreground' : 'text-sm text-muted-foreground'
            }
          >
            {mark && <StatusMark state={mark} size="sm" aria-hidden="true" tooltip={false} />}
            {label}
          </span>
          {detail && <span className="block max-w-full truncate text-xs text-muted-foreground">{detail}</span>}
        </>
      )}
    </span>
  );
}

function statusLabel(app: Integration, status: Status | null) {
  if (app.provider === 'soon') return 'Coming soon';
  if (app.provider === 'workflow') return 'Workflow trigger';
  switch (status?.kind) {
    case 'connected':
      return 'Connected';
    case 'installed':
      return 'Installed';
    case 'attention':
      return 'Needs attention';
    case 'error':
      return 'Couldn’t check';
    case 'unavailable':
      return 'Unavailable';
    case 'off':
      return status.granted ? 'Not granted' : 'Not connected';
    default:
      return '';
  }
}
