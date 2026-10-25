import { useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, MessageSquareIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { Plug } from 'reicon-react/icons/Plug';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { AtlassianIntegrations } from '@/features/atlassian/integrations';
import { GoogleAccount, GoogleApprovals } from '@/features/google/integrations';
import { AtlassianKnowledgeSources } from '@/features/integrations/atlassian-knowledge';
import {
  integrationById,
  makerOf,
  providers,
  type Integration,
  type IntegrationTab,
} from '@/features/integrations/catalog';
import { connector } from '@/features/integrations/connect';
import { DefaultKnowledge, useDefaultKnowledge } from '@/features/integrations/default-knowledge';
import { GitHubIntegrations } from '@/features/integrations/github';
import { GitHubAccounts, GitHubKnowledge } from '@/features/integrations/github-accounts';
import { GoogleKnowledgeSources } from '@/features/integrations/google-knowledge';
import {
  actionFor,
  defaultKnowledgeProducts,
  dependency,
  StatusBadge,
  tabLabels,
  tabsFor,
} from '@/features/integrations/integration-state';
import { KnowledgeMeter } from '@/features/integrations/knowledge-meter';
import { useGoogleIntegration, useIntegrationChanges } from '@/features/integrations/queries';
import { SlackAccount, SlackIntegration, SlackKnowledge } from '@/features/integrations/slack';
import { SlackBotChannels } from '@/features/integrations/slack-channels';
import { statusOf, useIntegrationStatus, type Status } from '@/features/integrations/status';
import { WorkspaceRefreshNotice } from '@/features/integrations/workspace-refresh';
import { useFlag } from '@/lib/feature-flags';
import { integrationDetailRoute, workspaceRoute } from '@/router';

export function IntegrationDetailPage() {
  const { workspace, user, sessionId } = workspaceRoute.useRouteContext();
  const { integrationId } = integrationDetailRoute.useParams();
  const app = integrationById(integrationId);
  if (!app) return <Missing slug={workspace.slug} />;
  return (
    <Detail
      key={`${workspace.id}:${user.id}:${sessionId}:${app.id}`}
      app={app}
      workspaceId={workspace.id}
      slug={workspace.slug}
    />
  );
}

function Missing({ slug }: { slug: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Integration not found"
          parent={{
            label: 'Integrations',
            link: <Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} />,
          }}
        />
        <StatePanel
          kind="empty"
          icon={Plug}
          title="This integration doesn’t exist"
          description="It may have been renamed or removed. Pick it again from the list."
        >
          <Button
            nativeButton={false}
            render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} />}
          >
            All integrations
          </Button>
        </StatePanel>
      </PageContent>
    </div>
  );
}

function Detail({ app, workspaceId, slug }: { app: Integration; workspaceId: string; slug: string }) {
  const { workspaceStale, membership } = workspaceRoute.useRouteContext();
  const search = integrationDetailRoute.useSearch();
  const navigate = useNavigate({ from: integrationDetailRoute.fullPath });
  const admin = membership?.role === 'admin';
  const provider = app.provider === 'soon' || app.provider === 'workflow' ? undefined : app.provider;
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId, provider ?? 'google');
  const status = provider ? statusOf(statuses, app) : null;
  const tabs = tabsFor(app, admin);
  const tab: IntegrationTab = search.tab && tabs.includes(search.tab) ? search.tab : 'overview';
  const setTab = (next: IntegrationTab) =>
    void navigate({
      search: { tab: next === 'overview' ? undefined : next, returnChat: search.returnChat },
      replace: true,
    });

  const changes = useIntegrationChanges();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const lock = useRef(false);
  const start = async (target: Integration = app) => {
    const run = connector(target, workspaceId);
    if (!run || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(false);
    try {
      await run();
      if (app.provider === 'google' || app.provider === 'slack') await changes.authority(app.provider);
    } catch {
      setFailure(true);
      setBusy(false);
      lock.current = false;
    }
  };

  const action = actionFor(app, status, admin);
  const hint = action.kind === 'none' ? action.hint : undefined;
  const accessLost = app.provider === 'google' && status?.kind === 'error' && status.accessLost;
  const primary =
    action.kind === 'connect' ? (
      <Button disabled={busy} aria-busy={busy} aria-label={`${action.label} ${app.name}`} onClick={() => void start()}>
        {busy && <Spinner aria-hidden="true" />}
        {action.label}
      </Button>
    ) : action.kind === 'settings' ? (
      <Button aria-label={`${action.label} ${app.name}`} onClick={() => setTab('settings')}>
        {action.label}
      </Button>
    ) : action.kind === 'workflow' && admin ? (
      <Button
        nativeButton={false}
        render={
          <Link
            to="/$workspaceSlug/workflows"
            params={{ workspaceSlug: slug }}
            search={{ provider: app.workflowProvider }}
            hash="provider-setup"
          />
        }
      >
        Set up workflow
      </Button>
    ) : app.provider === 'soon' ? (
      <Button disabled>Coming soon</Button>
    ) : null;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title={app.name}
          parent={{
            label: 'Integrations',
            link: (
              <Link
                to="/$workspaceSlug/integrations"
                params={{ workspaceSlug: slug }}
                search={{ returnChat: search.returnChat }}
              />
            ),
          }}
        />
        <WorkspaceRefreshNotice />
        <fieldset disabled={workspaceStale} className="min-w-0">
          <div className="max-w-5xl space-y-6">
            <section aria-label={`${app.name} summary`} className="flex flex-wrap items-start gap-4">
              <BrandIcon brand={app.brand} size="xl" />
              <div className="min-w-0 flex-1 basis-56 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-2xl font-semibold tracking-tight">{app.name}</p>
                  <span className="flex h-6 items-center">
                    <StatusBadge status={status} soon={app.provider === 'soon'} />
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  By {makerOf(app)} · {app.category}
                </p>
                <p className="max-w-prose pt-1">{app.blurb}</p>
              </div>
              {primary && <div className="w-full sm:w-auto sm:shrink-0 sm:pt-1">{primary}</div>}
            </section>
            {failure || status?.kind === 'error' ? (
              <div className="space-y-3">
                {failure && (
                  <Alert variant="destructive">
                    <AlertDescription>Could not start {app.name}. Try again.</AlertDescription>
                  </Alert>
                )}
                {status?.kind === 'error' && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span>{status.detail}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={refreshing}
                          aria-busy={refreshing}
                          onClick={() => void refresh()}
                        >
                          {refreshing ? 'Checking…' : 'Check again'}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            ) : null}
            <Tabs value={tab} onValueChange={value => setTab(value as IntegrationTab)}>
              <div className="max-w-full overflow-x-auto pb-1">
                <TabsList variant="line" aria-label={`${app.name} sections`}>
                  {tabs.map(name => (
                    <TabsTrigger key={name} value={name}>
                      {tabLabels[name]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="overview">
                <Pane>
                  <Overview
                    app={app}
                    status={status}
                    workspaceId={workspaceId}
                    busy={busy}
                    hint={hint}
                    onGrant={target => void start(target)}
                    onTab={setTab}
                    tabs={tabs}
                  />
                </Pane>
              </TabsContent>
              {tabs.includes('accounts') && (
                <TabsContent value="accounts">
                  <Pane>
                    {accessLost ? (
                      <AccessLost />
                    ) : (
                      <Accounts
                        app={app}
                        status={status}
                        workspaceId={workspaceId}
                        onChanged={() => void refresh()}
                        primary={primary}
                      />
                    )}
                  </Pane>
                </TabsContent>
              )}
              {tabs.includes('knowledge') && (
                <TabsContent value="knowledge">
                  <Pane>
                    {accessLost ? <AccessLost /> : <KnowledgeTab app={app} status={status} workspaceId={workspaceId} />}
                  </Pane>
                </TabsContent>
              )}
              {tabs.includes('settings') && (
                <TabsContent value="settings">
                  <Pane>
                    <SettingsTab app={app} status={status} workspaceId={workspaceId} onChanged={() => void refresh()} />
                  </Pane>
                </TabsContent>
              )}
              <TabsContent value="advanced">
                <Pane>
                  <Advanced
                    app={app}
                    status={status}
                    admin={admin}
                    slug={slug}
                    refreshing={refreshing}
                    onRefresh={() => void refresh()}
                  />
                </Pane>
              </TabsContent>
            </Tabs>
          </div>
        </fieldset>
      </PageContent>
    </div>
  );
}

function Pane({ children }: { children: ReactNode }) {
  return <div className="pt-6">{children}</div>;
}

function AccessLost() {
  return (
    <StatePanel
      kind="error"
      title="You no longer have access here"
      description="Your workspace membership changed. Reload to see your current access."
    >
      <Button variant="outline" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </StatePanel>
  );
}

function Panel({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Overview({
  app,
  status,
  workspaceId,
  busy,
  hint,
  onGrant,
  onTab,
  tabs,
}: {
  app: Integration;
  status: Status | null;
  workspaceId: string;
  busy: boolean;
  hint: string | undefined;
  onGrant: (target: Integration) => void;
  onTab: (tab: IntegrationTab) => void;
  tabs: IntegrationTab[];
}) {
  const info = app.provider === 'soon' ? null : providers[app.provider];
  const granted = status?.kind === 'connected' || status?.kind === 'off' ? status.granted : undefined;
  const needed =
    status?.kind === 'connected'
      ? [...new Set((app.can ?? []).map(item => dependency(item, granted)).filter(value => value !== undefined))]
      : [];
  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <div className="space-y-8 lg:col-span-2">
        {hint && (
          <Alert>
            <AlertDescription>{hint}</AlertDescription>
          </Alert>
        )}
        {info && (
          <Panel title="What it can do" id="integration-can">
            <ul className="divide-y divide-border rounded-xl border border-border">
              {[...(app.can ?? []), ...info.can].map(item => {
                const needs = dependency(item, granted);
                return (
                  <li key={item.text} className="flex min-h-12 items-center justify-between gap-3 px-4 py-2.5">
                    <span>{item.text}</span>
                    {item.scope && granted && !granted.includes(item.scope) ? (
                      <Badge variant="outline">Not granted</Badge>
                    ) : needs ? (
                      <Badge variant="outline">Needs {needs.name}</Badge>
                    ) : (
                      item.asksFirst && (
                        <Badge variant="info">
                          <ShieldCheckIcon aria-hidden="true" />
                          Asks first
                        </Badge>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
            {needed.map(target => (
              <div
                key={target.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
              >
                <p className="max-w-prose">
                  {target.id === 'google-drive'
                    ? 'Changing spreadsheets also needs Google Drive access. TulipFarm checks the spreadsheet’s Drive version before each change so it never overwrites edits made after your approval.'
                    : `This also needs ${target.name} access.`}
                </p>
                <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => onGrant(target)}>
                  Grant {target.name} access
                </Button>
              </div>
            ))}
          </Panel>
        )}
        {app.prompts.length > 0 && (
          <Panel title="Try asking" id="integration-prompts">
            <ul className="grid gap-2 sm:grid-cols-2">
              {app.prompts.map(prompt => (
                <li key={prompt} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
                  <MessageSquareIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{prompt}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
      <aside aria-labelledby="integration-glance" className="space-y-3">
        <h2 id="integration-glance" className="text-base font-semibold">
          At a glance
        </h2>
        <dl className="divide-y divide-border rounded-xl border border-border text-sm">
          <Fact label="Status">
            <StatusText app={app} status={status} />
          </Fact>
          {tabs.includes('accounts') && (
            <Fact label="Accounts">
              {status?.kind === 'loading' ? (
                <span className="block w-24">
                  <Skeleton />
                </span>
              ) : (
                <a
                  href="?tab=accounts"
                  onClick={event => {
                    event.preventDefault();
                    onTab('accounts');
                  }}
                  className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                >
                  {status?.kind === 'connected' ? (status.detail ?? 'Linked') : 'None linked'}
                  <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                </a>
              )}
            </Fact>
          )}
          {tabs.includes('knowledge') && <KnowledgeFact app={app} workspaceId={workspaceId} onTab={onTab} />}
          {info && (
            <Fact label="Who can use it">
              <span className="flex items-start gap-2">
                <UsersIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                {info.audience}
              </span>
            </Fact>
          )}
          <Fact label="Made by">{makerOf(app)}</Fact>
        </dl>
      </aside>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function StatusText({ app, status }: { app: Integration; status: Status | null }) {
  if (app.provider === 'soon') return 'Coming soon';
  if (app.provider === 'workflow') return 'Starts workflows';
  if (!status || status.kind === 'loading')
    return (
      <span className="block w-24">
        <Skeleton />
      </span>
    );
  switch (status.kind) {
    case 'connected':
      return 'Connected';
    case 'installed':
      return 'Installed, your account isn’t linked yet';
    case 'attention':
      return status.detail;
    case 'off':
      return status.granted ? 'Access not granted yet' : 'Not connected';
    case 'unavailable':
      return status.detail;
    case 'error':
      return 'Couldn’t check';
  }
}

function KnowledgeFact({
  app,
  workspaceId,
  onTab,
}: {
  app: Integration;
  workspaceId: string;
  onTab: (tab: IntegrationTab) => void;
}) {
  const { enabled, read } = useDefaultKnowledge(workspaceId);
  const product = defaultKnowledgeProducts[app.id];
  const items = read.state.kind === 'ready' ? read.state.data.items.filter(intent => intent.product === product) : [];
  const counts = items.reduce(
    (sum, intent) => ({
      total: sum.total + intent.counts.total,
      ready: sum.ready + intent.counts.ready,
      queued: sum.queued + intent.counts.queued,
      failed: sum.failed + intent.counts.failed,
      skipped: sum.skipped + intent.counts.skipped,
      quotaLimited: sum.quotaLimited + intent.counts.quotaLimited,
    }),
    { total: 0, ready: 0, queued: 0, failed: 0, skipped: 0, quotaLimited: 0 },
  );
  const link = (
    <a
      href="?tab=knowledge"
      onClick={event => {
        event.preventDefault();
        onTab('knowledge');
      }}
      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
    >
      Open Knowledge
      <ArrowRightIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
  return (
    <Fact label="Knowledge">
      {enabled && read.state.kind === 'loading' ? (
        <span className="block w-32">
          <Skeleton />
        </span>
      ) : enabled && counts.total > 0 ? (
        <div className="space-y-2 pt-1">
          <KnowledgeMeter counts={counts} compact />
          {link}
        </div>
      ) : (
        <div className="space-y-1">
          <p>Nothing indexed yet.</p>
          {link}
        </div>
      )}
    </Fact>
  );
}

function Accounts({
  app,
  status,
  workspaceId,
  onChanged,
  primary,
}: {
  app: Integration;
  status: Status | null;
  workspaceId: string;
  onChanged: () => void;
  primary: ReactNode;
}) {
  const empty = (status?.kind === 'off' || status?.kind === 'unavailable') && (
    <StatePanel
      kind="empty"
      heading="h2"
      icon={Plug}
      title={`No ${app.name} account linked`}
      description={
        status.kind === 'unavailable' ? status.detail : `Connect ${app.name} to let agents work there with your access.`
      }
    >
      {primary}
    </StatePanel>
  );
  if (app.provider === 'google')
    return (
      <div className="space-y-8">
        {status?.kind === 'off' && !status.granted ? (
          empty
        ) : (
          <Panel title="Your Google account" id="accounts-google">
            <GoogleAccount workspaceId={workspaceId} />
          </Panel>
        )}
        <GoogleApprovals workspaceId={workspaceId} />
      </div>
    );
  if (app.provider === 'slack') return <SlackAccount workspaceId={workspaceId} knowledge={false} />;
  if (app.provider === 'github-personal')
    return <GitHubAccounts workspaceId={workspaceId} onChanged={onChanged} knowledge={false} />;
  if (app.provider === 'atlassian' || app.provider === 'trello')
    return (
      <AtlassianIntegrations
        workspaceId={workspaceId}
        product={app.provider === 'trello' ? 'trello' : app.id === 'confluence' ? 'confluence' : 'jira'}
      />
    );
  return empty || null;
}

const driveKinds = ['drive-folder', 'shared-drive'] as const;
const gmailKinds = ['gmail'] as const;

function KnowledgeTab({ app, status, workspaceId }: { app: Integration; status: Status | null; workspaceId: string }) {
  const product = defaultKnowledgeProducts[app.id]!;
  const granted = status?.kind === 'connected' || status?.kind === 'off' ? status.granted : undefined;
  const connected =
    status?.kind === 'connected' &&
    (app.provider !== 'google' || !app.can?.[0]?.scope || !!granted?.includes(app.can[0].scope));
  return (
    <div className="space-y-10">
      <DefaultKnowledge workspaceId={workspaceId} product={product} connected={connected} />
      {app.provider === 'google' && <GoogleSources workspaceId={workspaceId} gmail={app.id === 'gmail'} />}
      {app.provider === 'slack' && <SlackKnowledge workspaceId={workspaceId} />}
      {app.provider === 'github-personal' && <GitHubKnowledge workspaceId={workspaceId} />}
      {app.provider === 'atlassian' && (app.id === 'jira' || app.id === 'confluence') && (
        <AtlassianKnowledgeSources workspaceId={workspaceId} product={app.id} />
      )}
    </div>
  );
}

function GoogleSources({ workspaceId, gmail }: { workspaceId: string; gmail: boolean }) {
  const read = useGoogleIntegration(workspaceId);
  if (read.data?.status.status !== 'connected') return null;
  return <GoogleKnowledgeSources workspaceId={workspaceId} kinds={gmail ? gmailKinds : driveKinds} />;
}

function SettingsTab({
  app,
  status,
  workspaceId,
  onChanged,
}: {
  app: Integration;
  status: Status | null;
  workspaceId: string;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-10">
      {app.provider === 'slack' && <SlackIntegration workspaceId={workspaceId} />}
      {app.provider === 'slack' && (status?.kind === 'connected' || status?.kind === 'installed') && (
        <SlackBotChannels workspaceId={workspaceId} />
      )}
      {app.provider === 'github' && <GitHubIntegrations workspaceId={workspaceId} onChanged={onChanged} />}
    </div>
  );
}

function Advanced({
  app,
  status,
  admin,
  slug,
  refreshing,
  onRefresh,
}: {
  app: Integration;
  status: Status | null;
  admin: boolean;
  slug: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const automatic = useFlag('default-connection-knowledge');
  const maker = makerOf(app);
  const granted = status?.kind === 'connected' ? status.granted : undefined;
  return (
    <div className="max-w-3xl divide-y divide-border rounded-xl border border-border">
      {app.workflowProvider && admin && (
        <AdvancedRow
          title="Start workflows from this app"
          description={`Run a workflow when something happens in ${app.name}.`}
          action={
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/$workspaceSlug/workflows"
                  params={{ workspaceSlug: slug }}
                  search={{ provider: app.workflowProvider }}
                  hash="provider-setup"
                />
              }
            >
              Set up trigger
            </Button>
          }
        />
      )}
      {app.provider === 'github-personal' && (
        <AdvancedRow
          title="Privacy"
          description={`Your integration is private to you. Workspace admins cannot use it. ${
            automatic
              ? 'New integrations import content only you can search.'
              : 'Importing content into Knowledge is a separate choice in the Knowledge tab.'
          }`}
        />
      )}
      {granted && granted.length > 0 && (
        <AdvancedRow
          title="Granted permissions"
          description={`${granted.length} Google permission${granted.length === 1 ? '' : 's'} granted to TulipFarm. Grant more from Overview when an action needs them.`}
        />
      )}
      {app.provider !== 'soon' && app.provider !== 'workflow' && (
        <AdvancedRow
          title="Status check"
          description="TulipFarm checks this connection when the page opens. Check again after changing access elsewhere."
          action={
            <Button variant="outline" disabled={refreshing} aria-busy={refreshing} onClick={onRefresh}>
              {refreshing && <Spinner aria-hidden="true" />}
              Check status
            </Button>
          }
        />
      )}
      <AdvancedRow
        title={`Remove access at ${maker}`}
        description={`Disconnecting here stops TulipFarm using the account. To revoke every token, also remove TulipFarm from your ${maker} account’s connected apps.`}
      />
    </div>
  );
}

function AdvancedRow({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
