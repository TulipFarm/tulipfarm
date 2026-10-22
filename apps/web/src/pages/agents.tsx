import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { workspaceRoute, agentDetailRoute, newAgentRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { AgentAvatar } from '@/components/agent-avatar';
import {
  DataList,
  DataListActions,
  DataListCell,
  DataListLink,
  DataListRow,
  DataListSecondary,
} from '@/components/data-list';
import { Add } from 'reicon-react/icons/Add';
import { Users } from 'reicon-react/icons/Users';
import { AgentsSample } from '@/components/empty-samples';
import { agentApi, type AgentCommand, type AgentContext, type AgentDetail } from '@/features/agents/api';
import { AgentRead } from '@/features/agents/feedback';
import { KeepsEditsContext, samePage } from '@/features/tables/feedback';
import { AgentEditor } from '@/features/agents/editor';
import { AgentPolicy } from '@/features/agents/policy';
import { AgentSchedules } from '@/features/agents/schedules';
import { AgentChat } from '@/features/agents/chat';
import { AgentDelete } from '@/features/agents/delete';
import { AgentActivations } from '@/features/agents/activations';
import { useAgentApi, useAgents, useAgentDetail, useAgentPage, useAgentPolicy } from '@/features/agents/queries';
import { toolLabels } from '@/features/agents/labels';
import { Disclosure } from '@/components/disclosure';
import { AgentSlackChannel } from '@/features/agents/slack-channel';
import { useCatalogNavigation } from '@/lib/use-catalog-navigation';
import { TaskStart } from '@/features/tasks/composer';
import { AgentSetup } from '@/features/agents/readiness';
import { agentStatus, agentTabs, visibleTabs, type AgentTab, type ExecutionCheck } from '@/features/agents/setup';
import { Badge } from '@tulipfarm/sprout/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { jumpTo } from '@/components/action-button';
import { AgentBuilder } from '@/features/agents/builder';
import { useFeatureRead } from '@/lib/query';
import type { BuilderInitial } from '@/features/agents/builder-draft';
import { conversationApi } from '@/features/chat/conversation-api';
import { TableRequestError } from '@/features/tables/request-state';

export function AgentsPage() {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const api = useAgentApi(workspace.id);
  const pages = useCatalogNavigation(`${user.id}/${workspace.id}/agents`);
  const { after, search, setSearch } = pages;
  const read = useAgents(api, after, search);
  const canCreate = read.state.kind === 'ready';
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Agents"
          description="Private instructions you can share with people and teams."
          actions={
            canCreate && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/$workspaceSlug/agents/new" params={{ workspaceSlug: workspace.slug }} />}
                >
                  Configure manually
                </Button>
                <Button
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug"
                      params={{ workspaceSlug: workspace.slug }}
                      search={{ intent: 'create-agent' }}
                    />
                  }
                >
                  Create in chat
                </Button>
              </div>
            )
          }
        />
        <SearchField
          id="agent-search"
          label="Find agents"
          placeholder="Search agents"
          maxLength={120}
          value={search}
          onChange={setSearch}
        />
        <AgentRead state={read.state} refresh={read.refresh}>
          {({ page }) => (
            <div className="space-y-4">
              {search && page.agents.length > 0 && page.count !== undefined && (
                <p className="text-sm text-muted-foreground">{page.count} matching agents</p>
              )}
              {!page.agents.length ? (
                search ? (
                  <StatePanel
                    kind="empty"
                    icon={Users}
                    title="No matching agents"
                    description="Try a different name or clear your search."
                  >
                    <Button variant="outline" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  </StatePanel>
                ) : (
                  <StatePanel
                    kind="empty"
                    icon={Users}
                    title="No agents yet"
                    description="Describe the agent's job in chat, or configure it manually above. Review its tools and access before activation."
                    sample={<AgentsSample />}
                  >
                    <Button
                      nativeButton={false}
                      render={
                        <Link
                          to="/$workspaceSlug"
                          params={{ workspaceSlug: workspace.slug }}
                          search={{ intent: 'create-agent' }}
                        />
                      }
                    >
                      <Add size={16} aria-hidden="true" />
                      Create in chat
                    </Button>
                  </StatePanel>
                )
              ) : (
                <DataList aria-label="Agents" columns="three" headings={['Name', 'Instructions', 'Status']}>
                  {page.agents.map(agent => (
                    <DataListRow key={agent.id}>
                      <DataListCell>
                        <AgentAvatar agentId={agent.id} name={agent.name} />
                        <DataListLink
                          render={
                            <Link
                              to="/$workspaceSlug/agents/$agentId"
                              params={{ workspaceSlug: workspace.slug, agentId: agent.id }}
                            />
                          }
                        >
                          {agent.name}
                        </DataListLink>
                      </DataListCell>
                      <AgentSummary api={api} id={agent.id} />
                    </DataListRow>
                  ))}
                </DataList>
              )}
              {(after || page.nextCursor) && (
                <nav aria-label="Agent pages" className="flex flex-wrap items-center gap-2 pb-24">
                  <Button
                    variant="outline"
                    disabled={!after || read.state.kind !== 'ready' || read.state.refreshing}
                    onClick={pages.first}
                  >
                    First page
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!after || read.state.kind !== 'ready' || read.state.refreshing}
                    onClick={pages.previous}
                  >
                    Previous page
                  </Button>
                  <span className="text-sm text-muted-foreground">Page {pages.page}</span>
                  <Button
                    variant="outline"
                    disabled={!page.nextCursor || read.state.kind !== 'ready' || read.state.refreshing}
                    onClick={() => {
                      if (page.nextCursor) pages.next(page.nextCursor);
                    }}
                  >
                    Next page
                  </Button>
                </nav>
              )}
            </div>
          )}
        </AgentRead>
      </PageContent>
    </div>
  );
}

function AgentSummary({ api, id }: { api: ReturnType<typeof agentApi>; id: string }) {
  const read = useAgentDetail(api, id);
  if (read.state.kind === 'loading')
    return (
      <>
        <DataListSecondary>Loading purpose and activation…</DataListSecondary>
        <DataListCell />
      </>
    );
  if (read.state.kind !== 'ready')
    return (
      <>
        <DataListCell />
        <DataListActions>
          <Button size="sm" variant="ghost" onClick={() => void read.refresh()}>
            Retry agent summary
          </Button>
        </DataListActions>
      </>
    );
  const { definition, activations, capabilities } = read.state.data;
  return (
    <>
      <DataListSecondary>{definition.instructions}</DataListSecondary>
      <DataListCell>
        {!activations.length
          ? 'Not activated'
          : !capabilities.includes('invoke')
            ? 'Run permission required'
            : 'Activated'}
      </DataListCell>
    </>
  );
}

export function NewAgentPage() {
  const search = newAgentRoute.useSearch();
  const [freshId] = useState(() => crypto.randomUUID());
  const id = search.setupAgentId ?? freshId;
  return (
    <NewAgentBuilder key={id} id={id} resume={!!search.setupAgentId} chatId={search.chatId} draftId={search.draftId} />
  );
}
function NewAgentBuilder({
  id,
  resume,
  chatId,
  draftId,
}: {
  id: string;
  resume: boolean;
  chatId?: string | undefined;
  draftId?: string | undefined;
}) {
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  const [resuming] = useState(resume);
  const [handoff] = useState(chatId && draftId ? { chatId, draftId } : null);
  const api = useAgentApi(workspace.id);
  const chat = useMemo(() => conversationApi(workspace.id, () => {}), [workspace.id]);
  const navigate = useNavigate();
  const read = useAgentPage(api, id, true);
  const initial = useFeatureRead<BuilderInitial>({
    key: ['agents', 'setup-draft', id, handoff],
    enabled: resuming || !!handoff,
    load: async signal => {
      if (!handoff) return api.setupDraft(id, signal);
      const view = await chat.draft(handoff.chatId, handoff.draftId, signal);
      if (
        view.status !== 'pending' ||
        view.proposal.kind !== 'agent' ||
        !view.proposal.input.setup ||
        view.proposal.targetId !== id
      )
        throw new TableRequestError(
          409,
          'draft-stale',
          'This chat draft is no longer available for editing. Return to chat and request a fresh setup.',
        );
      const input = view.proposal.input;
      let version = 0;
      try {
        version = (await api.setupDraft(id, signal)).version;
      } catch (error) {
        if (!(error instanceof TableRequestError && error.code === 'setup-draft-not-found')) throw error;
      }
      return {
        version,
        expectedSoulRevision: input.expectedSoulRevision,
        expectedSavedRevision: input.expectedSavedRevision,
        expectedPolicyVersion: input.expectedPolicyVersion ?? 0,
        expectedActivationIds: input.expectedActivationIds ?? [],
        setup: { ...view.proposal.input.setup, definition: input.definition, owningTeamId: input.owningTeamId },
      };
    },
  });
  const [context, setContext] = useState<AgentContext | null>(null);
  if (read.state.kind === 'ready' && context !== read.state.data.context) setContext(read.state.data.context);
  const loadingDraft = resuming || !!handoff;
  const builder = context && membershipId && (!loadingDraft || initial.state.kind === 'ready') && (
    <AgentBuilder
      api={api}
      workspaceId={workspace.id}
      slug={workspace.slug}
      id={id}
      membershipId={membershipId}
      context={context}
      initial={loadingDraft && initial.state.kind === 'ready' ? initial.state.data : undefined}
      concealed={read.state.kind !== 'ready' || (loadingDraft && initial.state.kind !== 'ready')}
      refresh={read.refresh}
      onPersisted={() => {
        void navigate({
          to: '/$workspaceSlug/agents/new',
          params: { workspaceSlug: workspace.slug },
          search: { setupAgentId: id },
          replace: true,
          ignoreBlocker: true,
        });
      }}
    />
  );
  return (
    <KeepsEditsContext value={samePage}>
      <div className="min-h-0 flex-1 overflow-auto">
        <PageContent>
          <PageHeader
            title={resuming ? 'Continue agent setup' : 'New agent'}
            description="Give it a role. Choose its access. Review before it starts."
            back={{
              label: 'Back to agents',
              link: <Link to="/$workspaceSlug/agents" params={{ workspaceSlug: workspace.slug }} />,
            }}
            actions={
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug"
                    params={{ workspaceSlug: workspace.slug }}
                    search={{ intent: 'create-agent' }}
                  />
                }
              >
                Create in chat
              </Button>
            }
          />
          {import.meta.env.DEV && workspace.slug === 'agent-builder-mock' && (
            <p role="note" className="rounded-lg border bg-muted p-3 text-sm">
              Local design demo. Models, prices, channels, and replies are illustrative. No live model calls, Slack
              messages, or scheduled jobs.
            </p>
          )}
          <AgentRead state={read.state} refresh={read.refresh}>
            {() => null}
          </AgentRead>
          {loadingDraft && (
            <AgentRead state={initial.state} refresh={initial.refresh}>
              {() => null}
            </AgentRead>
          )}
          {!membershipId && (
            <StatePanel
              kind="unavailable"
              title="Workspace membership unavailable"
              description="Refresh this page to check your current membership before creating an agent."
            />
          )}
          {builder}
        </PageContent>
      </div>
    </KeepsEditsContext>
  );
}
export function AgentDetailPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { agentId } = agentDetailRoute.useParams();
  const tab = agentDetailRoute.useSearch({ select: search => search.tab ?? 'overview' });
  const navigate = useNavigate();
  const showTab = useCallback(
    (next: AgentTab) =>
      navigate({
        to: '/$workspaceSlug/agents/$agentId',
        params: { workspaceSlug: workspace.slug, agentId },
        search: { tab: next === 'overview' ? undefined : next },
        replace: true,
      }),
    [navigate, workspace.slug, agentId],
  );
  return (
    <AgentPage
      key={`${workspace.id}/${agentId}`}
      workspaceId={workspace.id}
      slug={workspace.slug}
      id={agentId}
      creating={false}
      tab={tab}
      onTab={showTab}
    />
  );
}
const statusVariant = { draft: 'secondary', active: 'success', earlier: 'warning', off: 'warning' } as const;

function AgentPage({
  workspaceId,
  slug,
  id,
  creating,
  tab,
  onTab,
}: {
  workspaceId: string;
  slug: string;
  id: string;
  creating: boolean;
  tab: AgentTab;
  onTab: (next: AgentTab) => Promise<void>;
}) {
  const api = useAgentApi(workspaceId);
  const [snapshot, setSnapshot] = useState<{ context: AgentContext; detail: AgentDetail | null } | null>(null);
  const [receipt, setReceipt] = useState<AgentCommand | null>(null);
  const [deleted, setDeleted] = useState(false);
  const read = useAgentPage(api, id, creating);
  if (
    read.state.kind === 'ready' &&
    (snapshot?.context !== read.state.data.context || snapshot?.detail !== read.state.data.detail)
  )
    setSnapshot(read.state.data);
  const refresh = read.refresh;
  const ready = read.state.kind === 'ready';
  const detail = creating ? null : (snapshot?.detail ?? null);
  const can = (capability: string) => !!detail?.capabilities.includes(capability);
  const concealed = !ready || (!!detail && !can('edit'));
  const tabs = detail ? visibleTabs(detail.capabilities) : [];
  const active = tabs.some(item => item.value === tab) ? tab : 'overview';
  const open = (next: AgentTab, target: string) => {
    void onTab(next).then(() =>
      requestAnimationFrame(() => {
        if (document.getElementById(target)) jumpTo(target);
        else document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
      }),
    );
  };
  const policy = useAgentPolicy(api, id, ready && can('manage'));
  const execution: ExecutionCheck = !can('manage')
    ? 'hidden'
    : policy.state.kind === 'ready'
      ? policy.state.data.enabled
        ? 'on'
        : 'off'
      : policy.state.kind === 'loading'
        ? 'checking'
        : 'error';
  const status = detail && ready && !deleted ? agentStatus(detail, execution) : null;
  const panel = (value: AgentTab, children: ReactNode) => (
    <TabsContent key={value} value={value} keepMounted>
      <div className="grid gap-4 pt-2">
        <p className="text-sm text-muted-foreground">{agentTabs.find(item => item.value === value)?.description}</p>
        {children}
      </div>
    </TabsContent>
  );
  return (
    <KeepsEditsContext value={samePage}>
      <div className="min-h-0 flex-1 overflow-auto">
        <PageContent>
          <PageHeader
            back={{
              label: 'Back to agents',
              link: <Link to="/$workspaceSlug/agents" params={{ workspaceSlug: slug }} />,
            }}
            title={
              creating && !receipt ? 'New agent' : ready && snapshot?.detail ? snapshot.detail.name : 'Saved agent'
            }
            description={
              creating && !receipt && !deleted
                ? 'Describe the job and choose what this agent may use.'
                : detail && !deleted
                  ? 'Start tasks with this agent. Managers set up how it runs and who can use it.'
                  : undefined
            }
            actions={status && <Badge variant={statusVariant[status.kind]}>{status.label}</Badge>}
          />
          {deleted ? (
            <StatePanel
              kind="success"
              title="Agent deleted"
              description="Its activations are revoked. Return to agents to see your remaining accessible definitions."
            />
          ) : receipt ? (
            <section aria-label="Agent creation receipt" className="space-y-4">
              <h2 tabIndex={-1} ref={node => node?.focus()} className="text-lg font-medium">
                Agent saved.
              </h2>
              <p>
                This agent is private to you. Next, turn on execution and activate its instructions. Then add a trigger
                or run it now with a private task.
              </p>
              <p className="break-all text-sm">Saved revision {receipt.savedRevision}</p>
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/$workspaceSlug/agents/$agentId" params={{ workspaceSlug: slug, agentId: id }} />}
              >
                Open saved agent
              </Button>
            </section>
          ) : (
            <>
              <AgentRead state={read.state} refresh={read.refresh}>
                {() => null}
              </AgentRead>
              {snapshot && creating && (
                <AgentEditor
                  api={api}
                  workspaceId={workspaceId}
                  slug={slug}
                  id={id}
                  context={snapshot.context}
                  detail={null}
                  concealed={concealed}
                  refresh={refresh}
                  onAccepted={setReceipt}
                />
              )}
              {snapshot && detail && (
                <div hidden={!ready}>
                  <Tabs
                    value={active}
                    onValueChange={value => {
                      const next = tabs.find(item => item.value === value);
                      if (next) void onTab(next.value);
                    }}
                  >
                    <div className="max-w-full overflow-x-auto pb-1">
                      <TabsList variant="line" aria-label="Agent sections">
                        {tabs.map(item => (
                          <TabsTrigger key={item.value} value={item.value}>
                            {item.label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </div>
                    {can('manage') && (
                      <AgentPolicy
                        api={api}
                        id={id}
                        workspaceId={workspaceId}
                        slug={slug}
                        teams={snapshot.context.teams}
                        concealed={!ready}
                        refresh={refresh}
                      >
                        {parts => (
                          <>
                            {parts.notice}
                            {panel('access', parts.access)}
                            {panel(
                              'execution',
                              <>
                                {parts.execution}
                                <AgentActivations
                                  api={api}
                                  detail={detail}
                                  workspaceId={workspaceId}
                                  concealed={!ready}
                                  refresh={refresh}
                                />
                              </>,
                            )}
                          </>
                        )}
                      </AgentPolicy>
                    )}
                    {panel(
                      'overview',
                      <>
                        {can('edit') && <ContinueAgentSetup api={api} id={id} slug={slug} />}
                        {ready && (
                          <AgentSetup
                            detail={detail}
                            execution={execution}
                            workspaceId={workspaceId}
                            slug={slug}
                            open={open}
                          />
                        )}
                        <TaskStart
                          workspaceId={workspaceId}
                          slug={slug}
                          detail={detail}
                          concealed={!ready || !can('invoke')}
                          setup={{ kind: 'jump', label: 'See setup steps', target: 'agent-setup' }}
                        />
                        <section aria-labelledby="agent-triggers-title" className="grid gap-3">
                          <div className="grid gap-1">
                            <h2 id="agent-triggers-title" className="text-sm font-medium text-foreground">
                              Triggers
                            </h2>
                            <p className="text-sm text-muted-foreground">Choose how this agent starts work.</p>
                          </div>
                          <ul className="grid gap-3">
                            <li className="grid gap-1 rounded-lg border p-3">
                              <p className="text-sm font-medium text-foreground">Manual run</p>
                              <p className="text-sm text-muted-foreground">
                                {can('invoke')
                                  ? 'Start a private task above to run this agent with your prompt.'
                                  : 'An agent manager must grant you run access before you can start a private task.'}
                              </p>
                            </li>
                            <li className="grid gap-1 rounded-lg border p-3">
                              <p className="text-sm font-medium text-foreground">Slack message</p>
                              <p className="text-sm text-muted-foreground">
                                {detail.definition.responseRule === 'every-message'
                                  ? 'Starts for every new message in attached Slack channels.'
                                  : 'Starts when someone tags the agent in an attached Slack channel.'}
                              </p>
                              {can('edit') && (
                                <div>
                                  <Button
                                    variant="link"
                                    size="xs"
                                    onClick={() => open('instructions', 'agent-slack-response')}
                                  >
                                    Edit Slack trigger
                                  </Button>
                                </div>
                              )}
                            </li>
                            {can('manage') && (
                              <li className="grid gap-2 rounded-lg border p-3">
                                <div className="grid gap-1">
                                  <p className="text-sm font-medium text-foreground">Scheduled run</p>
                                  <p className="text-sm text-muted-foreground">
                                    Run a saved prompt or inspect a table on a repeating interval.
                                  </p>
                                </div>
                                <div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => open('schedules', 'agent-schedules')}
                                  >
                                    Add schedule
                                  </Button>
                                </div>
                              </li>
                            )}
                          </ul>
                        </section>
                        <section aria-labelledby="agent-about-title" className="grid gap-2">
                          <h2 id="agent-about-title" className="text-sm font-medium text-foreground">
                            About this agent
                          </h2>
                          <p className="whitespace-pre-wrap break-words text-base">{detail.definition.instructions}</p>
                          <p className="text-sm text-muted-foreground">
                            Actions:{' '}
                            {detail.definition.tools.map(tool => toolLabels[tool]).join(', ') || 'None configured'}.
                          </p>
                        </section>
                        <Disclosure title="Single-step request">
                          <AgentChat api={api} detail={detail} concealed={!ready || !can('invoke')} />
                        </Disclosure>
                      </>,
                    )}
                    {panel(
                      'instructions',
                      <AgentEditor
                        api={api}
                        workspaceId={workspaceId}
                        slug={slug}
                        id={id}
                        context={snapshot.context}
                        detail={detail}
                        concealed={concealed}
                        refresh={refresh}
                      />,
                    )}
                    {can('invoke') &&
                      panel(
                        'slack',
                        <>
                          {ready && <AgentSlackChannel workspaceId={workspaceId} agentId={id} />}
                          {can('manage') && (
                            <p className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
                              Channels this agent may post to are set in Execution.
                              <Button
                                variant="link"
                                size="xs"
                                onClick={() => open('execution', 'agent-slack-destinations')}
                              >
                                Go to Slack destinations
                              </Button>
                            </p>
                          )}
                        </>,
                      )}
                    {can('manage') &&
                      panel(
                        'schedules',
                        <AgentSchedules
                          api={api}
                          detail={detail}
                          workspaceId={workspaceId}
                          slug={slug}
                          teams={snapshot.context.teams}
                          concealed={!ready}
                          refresh={refresh}
                        />,
                      )}
                    {panel(
                      'settings',
                      <>
                        <Disclosure title="Revision details">
                          <dl className="space-y-2 break-all text-sm">
                            <dt>Saved revision</dt>
                            <dd>{detail.savedRevision}</dd>
                            <dt>Definition revision</dt>
                            <dd>{detail.definitionRevision}</dd>
                          </dl>
                        </Disclosure>
                        <AgentDelete
                          api={api}
                          id={id}
                          concealed={!ready || !can('delete')}
                          onDeleted={() => setDeleted(true)}
                          refresh={refresh}
                        />
                      </>,
                    )}
                  </Tabs>
                </div>
              )}
            </>
          )}
        </PageContent>
      </div>
    </KeepsEditsContext>
  );
}

function ContinueAgentSetup({ api, id, slug }: { api: ReturnType<typeof agentApi>; id: string; slug: string }) {
  const read = useFeatureRead({
    key: ['agents', 'setup-draft', id],
    load: async signal => {
      try {
        return await api.setupDraft(id, signal);
      } catch (error) {
        if (error instanceof TableRequestError && error.code === 'setup-draft-not-found') return null;
        throw error;
      }
    },
  });
  return (
    <AgentRead state={read.state} refresh={read.refresh}>
      {draft =>
        draft && (
          <div>
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/$workspaceSlug/agents/new" params={{ workspaceSlug: slug }} search={{ setupAgentId: id }} />
              }
            >
              Continue setup
            </Button>
          </div>
        )
      }
    </AgentRead>
  );
}
