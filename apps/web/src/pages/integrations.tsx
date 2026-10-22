import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { Plug } from 'reicon-react/icons/Plug';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { GlassBanner, GlassChip } from '@tulipfarm/sprout/glass-banner';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemOverlayButton,
  ItemTitle,
} from '@/components/item';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { IntegrationsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  categories,
  integrationFromHash,
  integrations,
  type Category,
  type Integration,
} from '@/features/integrations/catalog';
import { actionFor, IntegrationSheet, StatusBadge, type Tab } from '@/features/integrations/integration-sheet';
import { statusOf, useIntegrationStatus, type Statuses } from '@/features/integrations/status';
import { workspaceRoute, integrationsRoute } from '@/router';
import { WorkspaceRefreshNotice } from '@/features/integrations/workspace-refresh';
import { WorkspaceMcpIntegrations } from '@/features/workspace-mcp/integrations';

type Filter = 'all' | 'connected' | Category;
const examples: { brand: Brand; text: string }[] = [
  { brand: 'gmail', text: 'Drafted 3 follow-ups' },
  { brand: 'slack', text: 'Answered in #support' },
  { brand: 'jira', text: 'Triaged 5 new issues' },
];

export function IntegrationsPage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
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
  const hash = useLocation({ select: location => location.hash });
  const navigate = useNavigate();
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const target = integrationFromHash(hash);
  const [chosen, setChosen] = useState<{ hash: string; tab: Tab } | null>(null);
  const tab = chosen?.hash === hash ? chosen.tab : (target?.tab ?? 'overview');

  const go = (id: string) =>
    void navigate({
      to: '/$workspaceSlug/integrations',
      params: { workspaceSlug: slug },
      search: { returnChat },
      hash: id,
      replace: true,
      resetScroll: false,
    });
  const open = (app: Integration, next: Tab = 'overview') => {
    setChosen({ hash: app.id, tab: next });
    go(app.id);
  };

  const connected = integrations.filter(app => statusOf(statuses, app)?.kind === 'connected');
  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle)
      return [
        {
          title: 'Results',
          apps: integrations.filter(app => `${app.name} ${app.blurb}`.toLowerCase().includes(needle)),
        },
      ];
    if (filter === 'connected') return [{ title: 'Connected', apps: connected }];
    if (filter !== 'all') return [{ title: filter, apps: integrations.filter(app => app.category === filter) }];
    return [
      { title: 'Recommended', apps: integrations.filter(app => app.recommended) },
      ...categories
        .map(category => ({
          title: category,
          apps: integrations.filter(app => app.category === category && !app.recommended),
        }))
        .filter(section => section.apps.length),
    ];
  }, [query, filter, connected]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        {returnChat && (
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/chat/$chatId" params={{ workspaceSlug: slug, chatId: returnChat }} />}
          >
            Back to chat
          </Button>
        )}
        <PageHeader title="Integrations" description="Connect the apps your agents work in." />
        <WorkspaceRefreshNotice />
        <fieldset disabled={workspaceStale} className="min-w-0 space-y-6">
          <SearchField label="Search apps" value={query} onChange={setQuery} placeholder="Search apps" />
          {Object.values(statuses).some(status => status.kind === 'error') && (
            <section aria-label="App status errors" className="space-y-3">
              <Alert variant="destructive">
                <AlertDescription>
                  <ul className="space-y-2">
                    {Object.entries(statuses).map(
                      ([provider, status]) =>
                        status.kind === 'error' && (
                          <li key={provider}>
                            Could not check{' '}
                            {integrations
                              .filter(app => app.provider === provider)
                              .map(app => app.name)
                              .join(', ')}
                            . {status.detail}
                          </li>
                        ),
                    )}
                  </ul>
                </AlertDescription>
              </Alert>
              <Button variant="outline" disabled={refreshing} aria-busy={refreshing} onClick={refresh}>
                {refreshing ? 'Checking app status…' : 'Check app status again'}
              </Button>
            </section>
          )}
          <div className="flex flex-col gap-6 md:flex-row">
            <nav
              aria-label="Filter apps"
              className="-mx-4 flex gap-1 overflow-x-auto px-4 md:sticky md:top-0 md:mx-0 md:w-44 md:shrink-0 md:flex-col md:self-start md:px-0"
            >
              <Rail
                label="All"
                count={integrations.length}
                active={filter === 'all' && !query}
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
              />
              <Rail
                label="Connected"
                count={connected.length}
                active={filter === 'connected' && !query}
                onClick={() => {
                  setFilter('connected');
                  setQuery('');
                }}
              />
              <p className="hidden px-2.5 pt-4 pb-1 text-xs font-medium text-muted-foreground md:block">Categories</p>
              {categories.map(category => (
                <Rail
                  key={category}
                  label={category}
                  active={filter === category && !query}
                  onClick={() => {
                    setFilter(category);
                    setQuery('');
                  }}
                />
              ))}
            </nav>
            <div className="min-w-0 flex-1 space-y-8">
              {filter === 'all' && !query && (
                <GlassBanner title="Connect once. Your agents work there." caption="Example activity">
                  {examples.map(item => (
                    <GlassChip key={item.text} icon={<BrandIcon brand={item.brand} size="glyph" />}>
                      {item.text}
                    </GlassChip>
                  ))}
                </GlassBanner>
              )}
              {sections.map(section => (
                <section key={section.title} aria-labelledby={`section-${section.title}`} className="space-y-3">
                  <h2 id={`section-${section.title}`} className="text-sm font-medium text-muted-foreground">
                    {section.title}
                  </h2>
                  {section.apps.length ? (
                    <ul className="grid auto-rows-fr gap-2 lg:grid-cols-2">
                      {section.apps.map(app => (
                        <li key={app.id} className="grid">
                          <Row app={app} statuses={statuses} onOpen={() => open(app)} />
                        </li>
                      ))}
                    </ul>
                  ) : query ? (
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
                  ) : Object.values(statuses).some(status => status.kind === 'loading') ? (
                    <StatePanel kind="loading" title="Checking connected apps" description="Loading provider status." />
                  ) : Object.values(statuses).some(status => status.kind === 'error') ? (
                    <StatePanel
                      kind="error"
                      title="Connected apps could not be confirmed"
                      description="Retry the provider status check."
                    >
                      <Button variant="outline" onClick={() => void refresh()}>
                        Check connected apps
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
                      <Button onClick={() => setFilter('all')}>
                        <Add size={16} aria-hidden="true" />
                        Browse apps
                      </Button>
                    </StatePanel>
                  )}
                </section>
              ))}
            </div>
          </div>
          <WorkspaceMcpIntegrations workspaceId={workspaceId} />
        </fieldset>
        <IntegrationSheet
          app={target?.app ?? null}
          status={target ? statusOf(statuses, target.app) : null}
          tab={tab}
          workspaceId={workspaceId}
          slug={slug}
          onClose={() => go('')}
          onChanged={refresh}
        />
      </PageContent>
    </div>
  );
}

function Rail({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="md"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {count !== undefined && <span className="pl-2 text-muted-foreground tabular-nums">{count}</span>}
    </Button>
  );
}

function Row({ app, statuses, onOpen }: { app: Integration; statuses: Statuses; onOpen: () => void }) {
  const status = statusOf(statuses, app);
  const { membership } = workspaceRoute.useRouteContext();
  const action = actionFor(app, status, membership?.role === 'admin');
  const label =
    action.kind === 'connect' || action.kind === 'settings'
      ? action.label
      : action.kind === 'workflow'
        ? 'Set up'
        : null;
  return (
    <Item variant="interactive">
      <ItemMedia>
        <BrandIcon brand={app.brand} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <ItemOverlayButton onClick={onOpen}>{app.name}</ItemOverlayButton>
        </ItemTitle>
        <ItemDescription>{app.blurb}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <StatusBadge status={status} soon={app.provider === 'soon'} />
        {label && (
          <Button variant="outline" size="sm" aria-label={`${label} ${app.name}`} onClick={onOpen}>
            {label}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
