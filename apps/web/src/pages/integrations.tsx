import { useMemo, useState } from 'react';
import { Link, Navigate, useLinkProps, useLocation } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { Plug } from 'reicon-react/icons/Plug';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { IntegrationsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status as StatusMark } from '@tulipfarm/sprout/status';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { categories, integrationFromHash, integrations, type Integration } from '@/features/integrations/catalog';
import { statusOf, useIntegrationStatus, type Status } from '@/features/integrations/status';
import { WorkspaceRefreshNotice } from '@/features/integrations/workspace-refresh';
import { WorkspaceMcpIntegrations } from '@/features/workspace-mcp/integrations';
import { integrationsRoute, workspaceRoute } from '@/router';

type Filter = 'all' | 'connected' | 'attention';
const available = integrations.filter(app => app.provider !== 'soon');
const upcoming = integrations.filter(app => app.provider === 'soon');
const isConnected = (status: Status | null) => status?.kind === 'connected' || status?.kind === 'installed';
const needsAttention = (status: Status | null) => status?.kind === 'attention' || status?.kind === 'error';

export function IntegrationsPage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
  const { returnChat } = integrationsRoute.useSearch();
  const hash = useLocation({ select: location => location.hash });
  // Old links opened a sheet from the hash; send them to the integration's own page.
  const target = integrationFromHash(hash);
  if (target)
    return (
      <Navigate
        to="/$workspaceSlug/integrations/$integrationId"
        params={{ workspaceSlug: workspace.slug, integrationId: target.app.id }}
        search={{ tab: target.tab === 'overview' ? undefined : target.tab, returnChat }}
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

function IntegrationsContent({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { workspaceStale } = workspaceRoute.useRouteContext();
  const { returnChat } = integrationsRoute.useSearch();
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const loading = Object.values(statuses).some(status => status.kind === 'loading');
  const errors = Object.entries(statuses).filter(([, status]) => status.kind === 'error');
  const connected = available.filter(app => isConnected(statusOf(statuses, app)));
  const attention = available.filter(app => needsAttention(statusOf(statuses, app)));

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle)
      return [
        {
          title: 'Results',
          apps: integrations.filter(app => `${app.name} ${app.blurb} ${app.category}`.toLowerCase().includes(needle)),
        },
      ];
    if (filter === 'connected') return [{ title: 'Connected', apps: connected }];
    if (filter === 'attention') return [{ title: 'Needs attention', apps: attention }];
    return [
      { title: 'Recommended', apps: available.filter(app => app.recommended) },
      ...categories
        .map(category => ({
          title: category,
          apps: available.filter(app => app.category === category && !app.recommended),
        }))
        .filter(section => section.apps.length),
    ];
  }, [query, filter, connected, attention]);

  const empty = (title: string) =>
    query.trim() ? (
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
    ) : loading ? (
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
        description="Connect the apps your team already uses, like Slack, Gmail, or GitHub. Agents can then read and act there, always within the access you approve."
        sample={<IntegrationsSample />}
      >
        <Button onClick={() => setFilter('all')}>Browse apps</Button>
      </StatePanel>
    );

  return (
    <PageContent>
      <PageHeader
        title="Integrations"
        description="Connect the apps your agents work in. Open an app to manage accounts, Knowledge, and settings."
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
            <SearchField label="Search apps" value={query} onChange={setQuery} placeholder="Search apps" />
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
                <ToggleGroupItem value="all">
                  All <Count value={available.length} />
                </ToggleGroupItem>
                <ToggleGroupItem value="connected">
                  Connected <Count value={loading ? null : connected.length} />
                </ToggleGroupItem>
                <ToggleGroupItem value="attention">
                  Needs attention <Count value={loading ? null : attention.length} />
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
          {sections.map(section => (
            <section key={section.title} aria-labelledby={`section-${section.title}`} className="space-y-2">
              <h2 id={`section-${section.title}`} className="text-sm font-medium text-muted-foreground">
                {section.title}
              </h2>
              {section.apps.length ? (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {section.apps.map(app => (
                    <li key={app.id}>
                      <Row app={app} status={statusOf(statuses, app)} slug={slug} />
                    </li>
                  ))}
                </ul>
              ) : (
                empty(section.title)
              )}
            </section>
          ))}
          {filter === 'all' && !query.trim() && (
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
        <div className="pt-10">
          <WorkspaceMcpIntegrations workspaceId={workspaceId} />
        </div>
      </fieldset>
    </PageContent>
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
