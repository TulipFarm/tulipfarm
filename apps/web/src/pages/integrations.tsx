import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLinkProps, useLocation, useNavigate } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
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
import { AppIcon } from '@/features/integrations/app-icon';
import {
  categories,
  integrationFromHash,
  integrations,
  type Category,
  type Integration,
} from '@/features/integrations/catalog';
import { mcpAppById, mcpAppForEndpoint, mcpApps, mcpPagePrefix, type McpApp } from '@/features/integrations/mcp-apps';
import { statusOf, useIntegrationStatus, type Status } from '@/features/integrations/status';
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
type View = 'yours' | 'attention' | Category;
const directoryPatience = 800;
const entryKey = (entry: Entry) => (entry.kind === 'server' ? entry.server.id : `${entry.kind}:${entry.app.id}`);
export const viewSlug = (view: View) => view.toLowerCase().replace(/\W+/g, '-');
const viewTitle = (view: View) => (view === 'yours' ? 'Your apps' : view === 'attention' ? 'Needs attention' : view);

function useMcpDirectory(workspaceId: string) {
  const api = useMcpApi(workspaceId);
  const read = useMcpCapabilities(api);
  const capabilities = read.state.kind === 'ready' && read.state.data.enabled ? read.state.data : null;
  const list = useMcpIntegrations(api, !!capabilities);
  const servers = useMemo(() => (list.state.kind === 'ready' ? list.state.data.integrations : []), [list.state]);
  const loading = read.state.kind === 'loading' || (!!capabilities && list.state.kind === 'loading');
  return { api, capabilities, servers, loading };
}

function IntegrationsContent({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { workspaceStale } = workspaceRoute.useRouteContext();
  const { returnChat, view: viewParam } = integrationsRoute.useSearch();
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId);
  const navigate = useNavigate();
  const mcp = useMcpDirectory(workspaceId);
  const [query, setQuery] = useState('');
  const [setup, setSetup] = useState<Setup>(null);
  const hosted = useFlag('hosted-mcp') && !!mcp.capabilities?.hosted;
  const needle = query.trim().toLowerCase();
  const loading = mcp.loading || Object.values(statuses).some(status => status.kind === 'loading');
  // Hold the apps briefly for every status, so cards don't jump between views as each provider
  // answers, but never let one slow or retrying provider hide the others.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setPatient(false), directoryPatience);
    return () => window.clearTimeout(timer);
  }, []);
  const holding = loading && patient && !needle;
  const view: View =
    viewParam === 'attention'
      ? 'attention'
      : (categories.find(category => viewSlug(category) === viewParam) ?? 'yours');
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

  const views = useMemo(() => {
    const apps = (list: Integration[]) => list.map(app => ({ kind: 'app', app }) as const);
    const listed = (list: McpApp[]) => list.map(app => ({ kind: 'curated', app }) as const);
    const connections = (list: McpIntegration[]) => list.map(server => ({ kind: 'server', server }) as const);
    const linked = new Set([...connected, ...attention]);
    const entries = new Map<View, Entry[]>([
      ['yours', [...apps([...connected, ...attention]), ...connections(servers)]],
      ['attention', [...apps(attention), ...connections(servers.filter(mcpNeedsAttention))]],
    ]);
    for (const category of categories) {
      const own = integrations.filter(app => app.category === category && !linked.has(app));
      entries.set(category, [
        ...apps(own.filter(app => app.provider !== 'soon')),
        ...listed(curated.filter(app => app.category === category)),
        ...apps(own.filter(upcoming)),
      ]);
    }
    return entries;
  }, [connected, attention, servers, curated]);

  const results = useMemo((): Entry[] => {
    if (!needle) return [];
    const match = (text: string) => text.toLowerCase().includes(needle);
    return [
      ...servers
        .filter(server => match(`${server.name} ${brandOf(server)?.name ?? ''}`))
        .map(server => ({ kind: 'server', server }) as const),
      ...integrations
        .filter(app => match(`${app.name} ${app.blurb} ${app.category}`))
        .map(app => ({ kind: 'app', app }) as const),
      ...curated
        .filter(app => match(`${app.name} ${app.blurb} ${app.maker} ${app.category}`))
        .map(app => ({ kind: 'curated', app }) as const),
    ];
  }, [needle, servers, curated]);
  const shown = needle ? results : (views.get(view) ?? []);
  const railViews: View[] = ['yours', 'attention', ...categories.filter(category => views.get(category)?.length)];

  const empty = needle ? null : errors.length && view !== 'attention' && !shown.length ? (
    <StatePanel kind="error" title="App status couldn’t be confirmed" description="Check each app’s status again.">
      <Button variant="outline" onClick={() => void refresh()}>
        Check app status again
      </Button>
    </StatePanel>
  ) : view === 'attention' ? (
    <StatePanel
      kind="empty"
      heading="h3"
      icon={Plug}
      title="Nothing needs attention"
      description="Every connected app is working."
    />
  ) : view === 'yours' ? (
    <StatePanel
      kind="empty"
      heading="h3"
      icon={Plug}
      title="Nothing connected yet"
      description="Connect the apps your team already uses, like Slack, Gmail, or GitHub."
    >
      <Button
        onClick={() =>
          void navigate({
            to: '/$workspaceSlug/integrations',
            params: { workspaceSlug: slug },
            search: { returnChat, view: viewSlug(categories[0]) },
            replace: true,
          })
        }
      >
        Browse apps
      </Button>
    </StatePanel>
  ) : null;

  return (
    <PageContent>
      <PageHeader
        title="Integrations"
        description="Connect the apps your agents work in."
        actions={
          mcp.capabilities ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!mcp.capabilities.integrationsEnabled}
              onClick={() => setSetup({})}
            >
              <Add aria-hidden="true" />
              Add custom app
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
        <div className="max-w-5xl space-y-6">
          <div className="max-w-md">
            <SearchField
              label="Search apps"
              value={query}
              onChange={setQuery}
              placeholder="Search apps, like PostHog or Jira"
            />
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
          <div className="flex flex-col gap-6 md:flex-row">
            <nav aria-label="App categories" className="min-w-0 md:sticky md:top-4 md:w-60 md:shrink-0 md:self-start">
              <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:p-0">
                {railViews.map(item => {
                  const count = views.get(item)?.length ?? 0;
                  const current = !needle && item === view;
                  return (
                    <li key={item} className="shrink-0">
                      <RailLink
                        slug={slug}
                        view={item}
                        returnChat={returnChat}
                        current={current}
                        onClick={() => setQuery('')}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {item === 'attention' && !holding && count > 0 && (
                            <StatusMark state="warning" size="sm" aria-hidden="true" tooltip={false} />
                          )}
                          <span className="truncate">{viewTitle(item)}</span>
                        </span>
                        <span className="w-5 text-end text-xs text-muted-foreground tabular-nums">
                          {holding ? '–' : count}
                        </span>
                      </RailLink>
                      {item === 'attention' && (
                        <div aria-hidden="true" className="my-2 hidden h-px bg-border md:block" />
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>
            <section aria-labelledby="apps-heading" className="min-w-0 flex-1 space-y-3">
              <h2 id="apps-heading" className="text-sm font-medium text-muted-foreground">
                {needle ? 'Results' : viewTitle(view)}
              </h2>
              {holding ? (
                <DirectorySkeleton />
              ) : shown.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map(entry => (
                    <li key={entryKey(entry)}>
                      {entry.kind === 'app' ? (
                        <AppCard app={entry.app} status={statusOf(statuses, entry.app)} slug={slug} />
                      ) : entry.kind === 'curated' ? (
                        <CuratedCard app={entry.app} slug={slug} />
                      ) : (
                        <ServerCard server={entry.server} slug={slug} />
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                empty
              )}
              {holding ? null : mcp.capabilities ? (
                <McpMore
                  api={mcp.api}
                  capabilities={mcp.capabilities}
                  slug={slug}
                  query={needle}
                  found={results.length > 0}
                  clear={() => setQuery('')}
                  setup={setSetup}
                />
              ) : (
                needle &&
                !results.length && (
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
            </section>
          </div>
        </div>
      </fieldset>
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

/** One view in the category rail. Switching views replaces the history entry and keeps the scroll. */
function RailLink({
  slug,
  view,
  returnChat,
  current,
  onClick,
  children,
}: {
  slug: string;
  view: View;
  returnChat: string | undefined;
  current: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const props = useLinkProps({
    to: '/$workspaceSlug/integrations',
    params: { workspaceSlug: slug },
    search: { returnChat, view: view === 'yours' ? undefined : viewSlug(view) },
    replace: true,
    resetScroll: false,
  });
  const ref = useRef<HTMLAnchorElement>(null);
  // On phones the rail is a sideways strip; keep the open view in sight.
  useEffect(() => {
    const strip = ref.current?.closest('ul');
    if (current && ref.current && strip && strip.scrollWidth > strip.clientWidth)
      strip.scrollLeft = ref.current.offsetLeft - strip.offsetLeft - 16;
  }, [current]);
  return (
    <a
      {...props}
      ref={ref}
      onClick={event => {
        onClick();
        props.onClick?.(event);
      }}
      aria-current={current ? 'page' : undefined}
      className={`flex h-9 items-center justify-between gap-3 rounded-lg px-3 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
        current
          ? 'bg-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {children}
    </a>
  );
}

const cardClass =
  'flex h-full sm:min-h-36 flex-col gap-3 rounded-xl border border-border bg-card p-4 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring';

/** One app in the directory: logo and name, what it does, and its status. */
function Card({
  icon,
  name,
  blurb,
  status,
  link,
}: {
  icon: ReactNode;
  name: string;
  blurb: string;
  status: ReactNode;
  link: ReturnType<typeof useLinkProps> | null;
}) {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        {icon}
        <span className="truncate font-medium text-foreground">{name}</span>
      </span>
      <span className="line-clamp-2 text-sm text-muted-foreground" title={blurb}>
        {blurb}
      </span>
      <span className="mt-auto flex min-h-5 items-center">{status}</span>
    </>
  );
  return link ? (
    <a {...link} className={cardClass}>
      {body}
    </a>
  ) : (
    <div className="flex h-full sm:min-h-36 flex-col gap-3 rounded-xl border border-dashed border-border p-4">
      {body}
    </div>
  );
}

function StatusLine({
  mark,
  label,
  detail,
}: {
  mark: 'success' | 'warning' | 'error' | 'pending' | null;
  label: string;
  detail?: string | null;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm">
      {mark && <StatusMark state={mark} size="sm" aria-hidden="true" tooltip={false} />}
      <span className={mark ? 'shrink-0 font-medium text-foreground' : 'shrink-0 text-muted-foreground'}>{label}</span>
      {detail && <span className="truncate text-muted-foreground">· {detail}</span>}
    </span>
  );
}

/** An app whose maker runs an official MCP server, before anyone has connected it. */
function CuratedCard({ app, slug }: { app: McpApp; slug: string }) {
  const link = useLinkProps({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: app.id },
  });
  return (
    <Card
      icon={<AppIcon brand={app.brand} tile={app.tile} logo={app.logo} />}
      name={app.name}
      blurb={app.blurb}
      status={<StatusLine mark={null} label="Not connected" />}
      link={link}
    />
  );
}

function DirectorySkeleton() {
  return (
    <ul role="status" aria-label="Loading apps" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <li
          key={index}
          aria-hidden="true"
          className="flex sm:min-h-36 flex-col gap-3 rounded-xl border border-border bg-card p-4"
        >
          <span className="flex items-center gap-3">
            <Skeleton shape="avatar" />
            <span className="block w-24">
              <Skeleton />
            </span>
          </span>
          <span className="block w-full">
            <Skeleton />
          </span>
          <span className="mt-auto block w-20">
            <Skeleton />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A connected MCP server, beside built-in apps. */
function ServerCard({ server, slug }: { server: McpIntegration; slug: string }) {
  const brand = brandOf(server);
  const link = useLinkProps({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: `${mcpPagePrefix}${server.id}` },
  });
  const attention = mcpNeedsAttention(server);
  const mark =
    server.status === 'ready' ? 'success' : attention ? 'warning' : server.status === 'disabled' ? null : 'pending';
  const blurb = [
    server.accountLabel ?? (server.package ? packageLabel(server.package) : brand?.blurb),
    server.ownership === 'shared' ? 'Shared with everyone' : 'Just you',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card
      icon={<AppIcon brand={brand?.brand} tile={brand?.tile} logo={brand?.logo} />}
      name={brand?.name ?? server.name}
      blurb={blurb}
      status={
        <StatusLine
          mark={mark}
          label={
            server.reauthorizationRequired && server.status !== 'review-required'
              ? 'Sign in again'
              : mcpStatusLabel[server.status]
          }
        />
      }
      link={link}
    />
  );
}

function AppCard({ app, status, slug }: { app: Integration; status: Status | null; slug: string }) {
  const link = useLinkProps({
    to: '/$workspaceSlug/integrations/$integrationId',
    params: { workspaceSlug: slug, integrationId: app.id },
  });
  const mark = status && status.kind in marks ? marks[status.kind as keyof typeof marks] : null;
  return (
    <Card
      icon={<BrandIcon brand={app.brand} size="md" />}
      name={app.name}
      blurb={app.blurb}
      status={
        status?.kind === 'loading' ? (
          <span className="block w-16" role="status" aria-label="Checking status">
            <Skeleton />
          </span>
        ) : (
          <StatusLine
            mark={mark}
            label={statusLabel(app, status)}
            detail={status?.kind === 'connected' ? status.detail : null}
          />
        )
      }
      link={app.provider === 'soon' ? null : link}
    />
  );
}

export const marks = {
  connected: 'success',
  installed: 'pending',
  attention: 'warning',
  error: 'error',
} as const;

export function statusLabel(app: Integration, status: Status | null) {
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
