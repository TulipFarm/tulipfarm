import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { RefreshCwIcon } from 'lucide-react';
import { z } from 'zod';
import {
  statusSchema,
  webhookKeyIssuedSchema,
  workflowSchema,
  type Definition,
  type DisabledReason,
} from '@tulipfarm/workflows/contracts';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Button, jumpTo } from '@tulipfarm/sprout/button';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Label } from '@tulipfarm/sprout/label';
import { WorkflowsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@tulipfarm/sprout/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { Disclosure } from '@/components/disclosure';
import { workspaceRoute, workspaceWorkflowsRoute } from '@/router';
import { apiOrigin } from '@/lib/auth';
import { UnsavedChanges, samePage } from '@/features/tables/feedback';
import { workflowRequest as request, WorkflowRequestError as RequestError } from '@/features/workflows/api';
import type { WorkflowLink } from '@/features/workflows/page-search';
import { useWorkflowEditingSession } from '@/features/workflows/editing-session';
import {
  useWorkflows,
  useArchivedWorkflows,
  useWorkflowRuns,
  useWorkflowChanges,
  type RunStatus,
} from '@/features/workflows/queries';
import { WorkflowDefinition, WorkflowRun } from '@/features/workflows/workflow-detail';
import { WorkflowSlackAction } from '@/features/workflows/slack-step';
import { AgentStepStatus } from '@/features/workflows/agent-step-status';
import { runNote, stepNote } from '@/features/workflows/run-notes';
import { webhookStatus } from '@/features/workflows/webhook-status';
import { WebhookSetup, type IssuedWebhookKey } from '@/features/workflows/webhook-setup';
import { WebhookDeliveries } from '@/features/workflows/webhook-deliveries';
import { RowEventQueue } from '@/features/workflows/row-event-queue';
import { WorkflowSharing, AcceptWorkflowSponsorship, recordSourceDenied } from '@/features/workflows/sharing';
import {
  TriggerIcon,
  WorkflowRow,
  liveTrigger,
  triggerLine,
  type WorkflowState,
} from '@/features/workflows/workflow-summary';

type Workflow = z.infer<typeof workflowSchema>;
type Command = { path: string; method: string; body: unknown };
const WorkflowMock = import.meta.env.DEV ? lazy(() => import('@/features/workflows/workflow-mock')) : null;
export default function WorkflowsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { workflow: legacyWorkflow, ...search } = workspaceWorkflowsRoute.useSearch();
  const { workflowId } = useParams({ strict: false });
  const link: WorkflowLink = { ...search, workflow: workflowId ?? legacyWorkflow };
  const navigate = useNavigate();
  const showLink = useCallback(
    ({ workflow, ...next }: WorkflowLink) =>
      void navigate({
        ...(workflow
          ? {
              to: '/$workspaceSlug/workflows/$workflowId',
              params: { workspaceSlug: workspace.slug, workflowId: workflow },
            }
          : { to: '/$workspaceSlug/workflows', params: { workspaceSlug: workspace.slug } }),
        search: next,
        replace: true,
      }),
    [navigate, workspace.slug],
  );
  useEffect(() => {
    if (legacyWorkflow && !workflowId) showLink(link);
  }, [legacyWorkflow, workflowId]);
  if (WorkflowMock && workspace.slug === 'workflow-mock')
    return (
      <Suspense fallback={<p role="status">Loading workflow mock...</p>}>
        <WorkflowMock />
      </Suspense>
    );
  return <WorkflowPage key={workspace.id} workspaceId={workspace.id} link={link} onLink={showLink} />;
}
function WorkflowPage({
  workspaceId,
  link,
  onLink,
}: {
  workspaceId: string;
  link: WorkflowLink;
  onLink: (link: WorkflowLink) => void;
}) {
  const base = `/workspaces/${workspaceId}/workflows`;
  const {
    workspace: { slug: workspaceSlug },
    user,
  } = workspaceRoute.useRouteContext();
  const navigate = useNavigate(),
    read = useWorkflows(workspaceId),
    changes = useWorkflowChanges();
  const [denied, setDenied] = useState(false),
    [shelf, setShelf] = useState<'current' | 'archived'>('current');
  const [archivedOpened, setArchivedOpened] = useState(true),
    [search, setSearch] = useState('');
  const archivedRead = useArchivedWorkflows(workspaceId, archivedOpened);
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [input, setInput] = useState(''),
    [inputJson, setInputJson] = useState(false);
  const [revision, setRevision] = useState<'saved' | 'active'>('saved');
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null),
    [runPages, setRunPages] = useState(1),
    [runDiagram, setRunDiagram] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Command | null>(null);
  const leaving = useRef(false);
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [focusTarget, setFocusTarget] = useState<'workflow-views' | 'workflow-run-diagram' | 'run-input' | null>(null);
  const [webhookKey, setWebhookKey] = useState<IssuedWebhookKey | null>(null);
  const [testRun, setTestRun] = useState<{ workflowId: string; runId: string } | null>(null);
  const loadMoreStart = useRef<number | null>(null),
    accessVersion = useRef(0);
  const workflows = read.state.kind === 'ready' ? read.state.data : null;
  const archivedWorkflows = archivedRead.state.kind === 'ready' ? archivedRead.state.data : null;
  const filterRuns = (status: RunStatus | null) => {
    setRunStatus(status);
    setRunPages(1);
  };
  const selection = useWorkflowEditingSession({
    initialProvider: false,
    link,
    onLink,
    workflows,
    archivedWorkflows,
    archivedOpened,
    archivedState: archivedRead.state.kind,
    onArchiveLookup: () => setArchivedOpened(true),
    onArchivedLink: () => setShelf('archived'),
    onMessage: setMessage,
    onRun: id => {
      setRunDiagram(id);
      setFocusTarget('workflow-run-diagram');
      filterRuns(null);
    },
    onOpen: () => {
      setError('');
      setMessage('');
      setWebhookKey(null);
      setTestRun(null);
      setRunDiagram(null);
      setRevision('saved');
      setRunFormOpen(false);
      filterRuns(null);
    },
  });
  const { selected, view, choose, openRun, clear } = selection;
  const setView = selection.showView;
  const historyRead = useWorkflowRuns(
    workspaceId,
    view === 'runs' ? (selected?.id ?? null) : null,
    runStatus,
    runPages,
  );
  const runs = historyRead.state.kind === 'ready' ? historyRead.state.data.runs : null;
  const olderRuns = historyRead.state.kind === 'ready' && historyRead.state.data.nextCursor !== null;
  const blocked = busy || pending !== null;
  const deny = useCallback(() => {
    accessVersion.current++;
    setDenied(true);
    setWebhookKey(null);
    setTestRun(null);
    setRunDiagram(null);
    setFocusTarget(null);
    clear();
    setView('list');
    setPending(null);
  }, [clear, setView]);
  const refresh = async () => {
    await read.refresh();
    setDenied(false);
  };
  useEffect(() => {
    const target = focusTarget && document.getElementById(focusTarget);
    if (!target || blocked) return;
    jumpTo((focusTarget === 'workflow-views' && target.querySelector('[aria-pressed="true"]')) || target);
    setFocusTarget(null);
  }, [focusTarget, blocked, view, selected, runDiagram]);
  useEffect(() => {
    if (
      read.state.kind === 'unavailable' ||
      archivedRead.state.kind === 'unavailable' ||
      historyRead.state.kind === 'unavailable'
    )
      deny();
  }, [read.state.kind, archivedRead.state.kind, historyRead.state.kind, deny]);
  useEffect(
    () => () => {
      accessVersion.current++;
    },
    [],
  );
  useEffect(() => {
    if (
      loadMoreStart.current === null ||
      historyRead.state.kind !== 'ready' ||
      historyRead.state.refreshing ||
      olderRuns
    )
      return;
    const first = historyRead.state.data.runs[loadMoreStart.current];
    jumpTo(first ? `workflow-run-${first.id}` : 'workflow-run-history');
    setMessage('You have reached the end of run history.');
    loadMoreStart.current = null;
  }, [historyRead.state, olderRuns]);
  async function execute(command: Command) {
    if (busy) return;
    const access = accessVersion.current;
    leaving.current = false;
    setBusy(true);
    setError('');
    setMessage('');
    setPending(command);
    try {
      const result = await request(command.path, command.method, command.body);
      // The refreshed list drops an archived workflow and returns to the list before this request settles.
      leaving.current = command.path.endsWith('/archive');
      await changes.saved(command.path.slice(base.length + 1).split('/')[0]!);
      if (access !== accessVersion.current) return;
      let notice = 'Workflow updated.';
      if (command.path.endsWith('/webhook-key')) {
        const issued = webhookKeyIssuedSchema.parse(result);
        selection.observed(issued.workflow);
        setWebhookKey({ workflowId: issued.workflow.id, key: issued.key });
        notice =
          issued.workflow.webhookMode === 'stripe' && !issued.key
            ? 'Stripe signing secret saved encrypted.'
            : !issued.key
              ? 'Webhook key replaced by an earlier attempt.'
              : issued.workflow.webhookPrevious
                ? 'Webhook key created. Copy it now. The previous key keeps working until its grace period ends.'
                : 'Webhook key created. Copy it now.';
      } else if (command.path.endsWith('/webhook-test')) {
        const sent = z.object({ runId: z.string() }).parse(result);
        setTestRun({ workflowId: command.path.slice(base.length + 1).split('/')[0]!, runId: sent.runId });
        notice = 'Test event sent. Open its run from the webhook panel.';
      } else if (command.path.endsWith('/revoke-previous')) {
        selection.observed(workflowSchema.parse(result));
        notice = 'Previous webhook key revoked. Only the current key works now.';
      } else if (command.path.endsWith('/activation')) {
        selection.observed(workflowSchema.parse(result));
        notice = 'Workflow activation updated. Check the active revision below.';
      } else if (command.path.endsWith('/cancel')) notice = 'Cancellation requested. Check the run status.';
      else if (command.path.endsWith('/input')) notice = 'Your response was recorded. The run can now resume.';
      else if (command.path.endsWith('/runs')) {
        openRun(z.object({ runId: z.string() }).parse(result).runId);
        notice = 'Run requested. Follow its progress below.';
      } else if (command.path.endsWith('/archive')) {
        selection.archived();
        setShelf('current');
        setWebhookKey(null);
        setFocusTarget('workflow-views');
        notice =
          'Workflow archived. Its schedule, webhook, and connected-app triggers stopped, and unfinished runs were stopped. Run history is kept.';
      }
      setPending(null);
      setMessage(notice);
    } catch (failure) {
      if (access !== accessVersion.current) return;
      if (failure instanceof RequestError && [401, 403, 404].includes(failure.status)) {
        deny();
        return;
      }
      if (failure instanceof RequestError && failure.status < 500) {
        setPending(null);
        setError(commandError(failure));
      } else setError('The result is unconfirmed. Retry the exact request below before making another change.');
    } finally {
      setBusy(false);
    }
  }
  const create = () =>
    void navigate({ to: '/$workspaceSlug', params: { workspaceSlug }, search: { intent: 'create-workflow' } });
  const showShelf = (next: 'current' | 'archived') => {
    if (next !== shelf) setSearch('');
    setShelf(next);
    if (next === 'archived') setArchivedOpened(true);
  };
  const shelfWorkflows = shelf === 'archived' ? archivedWorkflows : workflows;
  const matches = (workflow: Workflow) => workflow.definition.name.toLowerCase().includes(search.trim().toLowerCase());
  const shownWorkflows = shelfWorkflows?.filter(matches);
  const detail = view !== 'list' ? selected : null;
  const listHref = `/${encodeURIComponent(workspaceSlug)}/workflows`;
  const unavailable = denied || read.state.kind === 'unavailable';
  const webhook = selected ? webhookStatus(selected) : null;
  return (
    <PageContent>
      <UnsavedChanges dirty={pending !== null} allowNavigation={leaving} keepsEdits={samePage} />
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogTitle>Archive {selected?.definition.name ?? 'this workflow'}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its schedule, webhook and connected-app triggers stop. Unfinished runs stop. History is kept. This cannot be
            undone.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep workflow</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmArchive(false);
                if (selected)
                  void execute({
                    path: `${base}/${selected.id}/archive`,
                    method: 'POST',
                    body: { commandId: crypto.randomUUID(), expectedGeneration: selected.generation },
                  });
              }}
            >
              Archive workflow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PageHeader
        title={detail ? detail.definition.name : 'Workflows'}
        description={detail ? undefined : 'See how repeatable work runs. Create and edit workflows in chat.'}
        parent={
          detail
            ? {
                label: 'Workflows',
                link: (
                  <a
                    href={listHref}
                    aria-disabled={blocked || undefined}
                    onClick={event => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
                        return;
                      event.preventDefault();
                      if (!blocked) setView('list');
                    }}
                  />
                ),
              }
            : undefined
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh workflows"
              title="Refresh workflows"
              disabled={unavailable || read.state.kind !== 'ready'}
              onClick={() => void (shelf === 'archived' ? archivedRead.refresh() : refresh())}
            >
              <RefreshCwIcon aria-hidden="true" />
            </Button>
            <Button disabled={blocked || unavailable} onClick={create}>
              New workflow
            </Button>
          </>
        }
      />
      {read.state.kind === 'loading' && (
        <StatePanel kind="loading" title="Loading workflows" description="Checking your workspace access." />
      )}
      {(unavailable || read.state.kind === 'error') && (
        <StatePanel
          kind={unavailable ? 'unavailable' : 'error'}
          title={unavailable ? 'Workflow access unavailable' : 'Workflows could not load'}
          description={
            unavailable
              ? 'A workflow manager can share access with you. The previous view has been cleared.'
              : 'Retry to load your workflows.'
          }
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Retry loading
          </Button>
        </StatePanel>
      )}
      {!unavailable && read.state.kind === 'ready' && (
        <div className="space-y-6">
          {read.state.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>Refresh failed. These are your last checked workflows.</AlertDescription>
            </Alert>
          )}
          {(error || message || (pending && !busy)) && (
            <div className="space-y-2">
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {message && (
                <p role="status" className="text-sm text-muted-foreground">
                  {message}
                </p>
              )}
              {pending && !busy && (
                <div id="workflow-retry">
                  <Button variant="outline" onClick={() => void execute(pending)}>
                    Retry exact request
                  </Button>
                </div>
              )}
            </div>
          )}
          {!detail && (
            <section aria-label="Workflow selection" className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {(!!shelfWorkflows?.length || !!search) && (
                  <div className="sm:w-80">
                    <SearchField
                      id="workflow-search"
                      label="Find workflows"
                      placeholder={shelf === 'archived' ? 'Search archived workflows' : 'Search current workflows'}
                      value={search}
                      onChange={setSearch}
                    />
                  </div>
                )}
                <div id="workflow-views" className="shrink-0">
                  <ToggleGroup
                    aria-label="Workflow filter"
                    variant="outline"
                    size="sm"
                    spacing={0}
                    value={[shelf]}
                    onValueChange={value => {
                      const next = value[0];
                      if (next === 'current' || next === 'archived') showShelf(next);
                    }}
                  >
                    <ToggleGroupItem value="current">
                      Current <Count value={workflows?.length} />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="archived">
                      Archived <Count value={archivedWorkflows?.length} />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
              {!!shownWorkflows?.length && (
                <ul
                  aria-label={shelf === 'archived' ? 'Archived workflows' : 'Workflows'}
                  className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
                >
                  {shownWorkflows.map(workflow => (
                    <li key={workflow.id}>
                      <WorkflowRow
                        workflow={workflow}
                        state={workflowState(workflow)}
                        href={`${listHref}/${encodeURIComponent(workflow.id)}`}
                        disabled={blocked}
                        onOpen={() => choose(workflow)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {shelf === 'archived' && archivedRead.state.kind === 'loading' && (
                <StatePanel
                  kind="loading"
                  title="Loading archived workflows"
                  description="Checking which archived workflows you can read."
                />
              )}
              {shelf === 'archived' &&
                (archivedRead.state.kind === 'error' ||
                  (archivedRead.state.kind === 'ready' && archivedRead.state.error)) && (
                  <StatePanel
                    kind="error"
                    title="Archived workflows could not load"
                    description="Your current workflows are unaffected."
                  >
                    <Button variant="outline" onClick={() => void archivedRead.refresh()}>
                      Retry loading archived workflows
                    </Button>
                  </StatePanel>
                )}
              {shelfWorkflows?.length === 0 && (
                <StatePanel
                  kind="empty"
                  icon={BranchDown}
                  title={shelf === 'archived' ? 'No archived workflows' : 'No workflows yet'}
                  description={
                    shelf === 'archived'
                      ? 'Archived workflows keep their run history here.'
                      : 'Describe the work in chat, review its diagram, then save and activate it.'
                  }
                  sample={shelf === 'current' ? <WorkflowsSample /> : undefined}
                >
                  <Button variant="outline" onClick={shelf === 'current' ? create : () => showShelf('current')}>
                    {shelf === 'current' ? 'New workflow' : 'Show current workflows'}
                  </Button>
                </StatePanel>
              )}
              {search && !!shelfWorkflows?.length && !shownWorkflows?.length && (
                <StatePanel
                  kind="empty"
                  title="No matching workflows"
                  description="Try another name or clear your search."
                >
                  <Button variant="outline" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                </StatePanel>
              )}
            </section>
          )}
          {selected && detail && (
            <div className="space-y-6">
              <section aria-label="Workflow summary" className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 items-start gap-4">
                  <TriggerIcon trigger={liveTrigger(selected)} size="lg" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
                      {selected.definition.name}
                    </p>
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Status state={workflowState(selected).mark} size="sm" aria-hidden="true" tooltip={false} />
                      {workflowState(selected).label}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {[
                        `${pendingChanges(selected) ? 'Live: ' : ''}${triggerLine(liveTrigger(selected))}`,
                        workflowState(selected).detail,
                        pendingSchedule(selected) && `Saved: ${pendingSchedule(selected)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </div>
                {!selected.archivedAt && (selected.capabilities.manage || selected.capabilities.invoke) && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {selected.capabilities.invoke && (
                      <Button
                        variant="outline"
                        disabled={blocked || !selected.enabled}
                        onClick={() => {
                          setRunFormOpen(true);
                          setView('runs');
                          setFocusTarget('run-input');
                        }}
                      >
                        Start a run
                      </Button>
                    )}
                    {selected.capabilities.manage && (
                      <Button
                        variant={
                          selected.enabled && selected.activeRevision === selected.revision ? 'outline' : 'default'
                        }
                        disabled={blocked}
                        onClick={() =>
                          void execute({
                            path: `${base}/${selected.id}/activation`,
                            method: 'POST',
                            body: {
                              commandId: crypto.randomUUID(),
                              expectedGeneration: selected.generation,
                              revision: selected.revision,
                              enabled: !selected.enabled || selected.activeRevision !== selected.revision,
                            },
                          })
                        }
                      >
                        {selected.enabled && selected.activeRevision === selected.revision
                          ? 'Disable workflow'
                          : 'Activate saved revision'}
                      </Button>
                    )}
                  </div>
                )}
              </section>
              {selected.archivedAt ? (
                <Alert>
                  <AlertDescription>
                    Archived {formatTime(selected.archivedAt)}. Its definition and run history are read-only.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {!selected.enabled &&
                    (selected.disabledReason ? (
                      <Alert variant="destructive">
                        <AlertDescription>{disabledExplanation(selected)}</AlertDescription>
                      </Alert>
                    ) : (
                      <Alert>
                        <AlertDescription>{disabledExplanation(selected)}</AlertDescription>
                      </Alert>
                    ))}
                  <div className="rounded-xl border border-border bg-card p-4 empty:hidden">
                    <AcceptWorkflowSponsorship
                      workspaceId={workspaceId}
                      workflow={selected}
                      userId={user.id}
                      changed={refresh}
                    />
                  </div>
                </>
              )}
              <Tabs
                value={view}
                onValueChange={value => setView(value === 'runs' || value === 'settings' ? value : 'definition')}
              >
                <div className="max-w-full overflow-x-auto border-b border-border">
                  <TabsList variant="line" aria-label="Workflow views">
                    <TabsTrigger value="definition">Overview</TabsTrigger>
                    <TabsTrigger value="runs">Runs</TabsTrigger>
                    {!selected.archivedAt && <TabsTrigger value="settings">Settings</TabsTrigger>}
                  </TabsList>
                </div>
                <TabsContent value="definition">
                  <section aria-label="Workflow definition" className="min-w-0 pt-6">
                    <WorkflowDefinition
                      workspaceId={workspaceId}
                      workflowId={selected.id}
                      revision={revision}
                      header={false}
                      navigation={
                        selected.activeRevision && selected.activeRevision !== selected.revision ? (
                          <ToggleGroup
                            aria-label="Displayed revision"
                            variant="outline"
                            size="sm"
                            spacing={0}
                            value={[revision]}
                            onValueChange={value => {
                              if (value[0] === 'saved' || value[0] === 'active') setRevision(value[0]);
                            }}
                          >
                            <ToggleGroupItem value="saved">Saved</ToggleGroupItem>
                            <ToggleGroupItem value="active">Active</ToggleGroupItem>
                          </ToggleGroup>
                        ) : undefined
                      }
                    />
                  </section>
                </TabsContent>
                <TabsContent value="runs">
                  <div className="space-y-6 pt-6">
                    {selected.enabled && selected.activeTrigger?.kind === 'record' && (
                      <section aria-label="Upcoming record dates" className="space-y-1">
                        <h3 className="text-sm font-medium">Upcoming record dates</h3>
                        {selected.upcomingRecords === null ? (
                          <Alert>
                            <AlertDescription>
                              Upcoming record dates are hidden because you cannot read this table.
                            </AlertDescription>
                          </Alert>
                        ) : selected.upcomingRecords.length ? (
                          <ul className="space-y-1 text-sm">
                            {selected.upcomingRecords.slice(0, 10).map(item => (
                              <li key={`${item.recordId}/${item.dueAt}`}>
                                Record {item.recordId.slice(0, 8)} / {formatTime(item.dueAt)}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm">No upcoming record dates. Future dates appear after the next sweep.</p>
                        )}
                      </section>
                    )}
                    {runDiagram && (
                      <section
                        id="workflow-run-diagram"
                        tabIndex={-1}
                        aria-label="Selected run diagram"
                        className="space-y-3 rounded-xl border border-border bg-card p-4"
                      >
                        <WorkflowRun
                          key={runDiagram}
                          workspaceId={workspaceId}
                          workflowId={selected.id}
                          runId={runDiagram}
                        />
                        <Button variant="outline" size="sm" onClick={() => setRunDiagram(null)}>
                          Close run diagram
                        </Button>
                      </section>
                    )}
                    {(selected.activeTrigger?.kind === 'row' ||
                      (!!selected.rowQueue &&
                        selected.rowQueue.pending + selected.rowQueue.blocked + selected.rowQueue.cancelled > 0)) && (
                      <RowEventQueue
                        key={selected.id}
                        workspaceId={workspaceId}
                        workflow={selected}
                        onRefresh={refresh}
                      />
                    )}
                    {selected.archivedAt ? (
                      <p className="text-sm text-muted-foreground">
                        Archived {formatTime(selected.archivedAt)}. Its run history is read-only.
                      </p>
                    ) : (
                      runFormOpen &&
                      selected.capabilities.invoke && (
                        <fieldset className="min-w-0">
                          <section
                            aria-label="Run workflow"
                            className="space-y-3 rounded-xl border border-border bg-card p-4"
                          >
                            <h2 className="font-medium">Run manually</h2>
                            <Label htmlFor="run-input">{inputJson ? 'Input JSON' : 'Request to review'}</Label>
                            <Textarea
                              id="run-input"
                              value={input}
                              disabled={blocked}
                              onChange={event => setInput(event.target.value)}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                variant="ghost"
                                disabled={blocked}
                                onClick={() => {
                                  setInput(inputJson ? input : JSON.stringify({ request: input }, null, 2));
                                  setInputJson(!inputJson);
                                }}
                              >
                                {inputJson ? 'Use plain text' : 'Advanced JSON input'}
                              </Button>
                              <Button
                                disabled={blocked || !selected.enabled}
                                onClick={() => {
                                  try {
                                    void execute({
                                      path: `${base}/${selected.id}/runs`,
                                      method: 'POST',
                                      body: {
                                        requestId: crypto.randomUUID(),
                                        input: inputJson ? JSON.parse(input) : { request: input },
                                      },
                                    });
                                  } catch {
                                    setError('Enter valid JSON input.');
                                  }
                                }}
                              >
                                Run workflow
                              </Button>
                              <Button variant="ghost" disabled={blocked} onClick={() => setRunFormOpen(false)}>
                                Close
                              </Button>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Runs continue after you leave. A response resumes the run right away.
                            </p>
                          </section>
                        </fieldset>
                      )
                    )}
                    <section aria-label="Run history" className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 id="workflow-run-history" tabIndex={-1} className="me-auto font-medium">
                          Run history
                        </h2>
                        <p role="status" className="text-xs text-muted-foreground">
                          {historyRead.state.kind === 'ready' && historyRead.state.refreshing
                            ? runStatus
                              ? 'Loading filtered run history...'
                              : 'Refreshing run history...'
                            : ''}
                        </p>
                        <Label htmlFor="workflow-run-status">Show</Label>
                        <Select
                          value={runStatus ?? ''}
                          onValueChange={value => filterRuns(value ? statusSchema.parse(value) : null)}
                        >
                          <SelectTrigger id="workflow-run-status" size="sm">
                            <SelectValue>{runStatus ? runStatusLabel[runStatus] : 'All runs'}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">All runs</SelectItem>
                            {statusSchema.options.map(status => (
                              <SelectItem key={status} value={status}>
                                {runStatusLabel[status]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="outline" size="sm" onClick={() => void historyRead.refresh()}>
                          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                          Check run history
                        </Button>
                      </div>
                      {(historyRead.state.kind === 'error' ||
                        (historyRead.state.kind === 'ready' && historyRead.state.error)) && (
                        <Alert variant="destructive" role="alert">
                          <AlertDescription>
                            Run history could not refresh. Your previous history and input remain available.
                          </AlertDescription>
                        </Alert>
                      )}
                      {runs === null ? (
                        <p role="status" className="text-sm text-muted-foreground">
                          Run history has not loaded.
                        </p>
                      ) : !runs.length && runStatus ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border p-4 text-sm">
                          <p>No runs in your history for this workflow match {runStatusLabel[runStatus]}.</p>
                          <Button variant="outline" size="sm" onClick={() => filterRuns(null)}>
                            Clear filter
                          </Button>
                        </div>
                      ) : !runs.length ? (
                        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                          {selected.archivedAt
                            ? 'No runs in your history for this workflow.'
                            : 'No runs yet. Activate the workflow, then choose Start a run.'}
                        </p>
                      ) : (
                        runs.map(run => (
                          <article
                            key={run.id}
                            id={`workflow-run-${run.id}`}
                            tabIndex={-1}
                            className="space-y-3 rounded-xl border border-border bg-card p-4"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                              <div className="min-w-0 space-y-0.5">
                                <h3 role="status" className="flex items-center gap-1.5 font-medium">
                                  <Status state={runMark[run.status]} size="sm" aria-hidden="true" tooltip={false} />
                                  {runStatusLabel[run.status]}
                                </h3>
                                <p className="ps-4.5 text-xs text-muted-foreground">
                                  {runSourceLabel[run.source]} /{' '}
                                  <time dateTime={run.createdAt}>Created {formatTime(run.createdAt)}</time>
                                  {run.scheduledFor && (
                                    <>
                                      {' '}
                                      /{' '}
                                      <time dateTime={run.scheduledFor}>
                                        Scheduled for {formatTime(run.scheduledFor)}
                                      </time>
                                    </>
                                  )}
                                  {run.startedAt && (
                                    <>
                                      {' '}
                                      / <time dateTime={run.startedAt}>Started {formatTime(run.startedAt)}</time>
                                    </>
                                  )}
                                  {run.finishedAt && (
                                    <>
                                      {' '}
                                      / <time dateTime={run.finishedAt}>Finished {formatTime(run.finishedAt)}</time>
                                    </>
                                  )}
                                  {run.startedAt && run.finishedAt && (
                                    <> / Duration {formatDuration(run.startedAt, run.finishedAt)}</>
                                  )}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {['queued', 'running', 'waiting'].includes(run.status) && !selected.archivedAt && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={blocked || !selected.capabilities.invoke}
                                    onClick={() =>
                                      void execute({
                                        path: `${base}/${selected.id}/runs/${run.id}/cancel`,
                                        method: 'POST',
                                        body: {},
                                      })
                                    }
                                  >
                                    Cancel run
                                  </Button>
                                )}
                                <Button variant="outline" size="sm" onClick={() => openRun(run.id)}>
                                  View run diagram
                                </Button>
                              </div>
                            </div>
                            {runNote(run) && <p className="text-sm">{runNote(run)}</p>}
                            {run.error && run.status !== 'skipped' && (
                              <p role="alert" className="text-sm text-destructive">
                                {run.error}
                              </p>
                            )}
                            {run.steps
                              .filter(step => step.status === 'waiting')
                              .map(step => (
                                <div key={step.stepId} className="space-y-3 rounded-lg bg-muted/50 p-3">
                                  <AgentStepStatus output={step.output} />
                                  {step.prompt && (
                                    <>
                                      <p className="font-medium">{step.prompt}</p>
                                      <HumanResponse
                                        disabled={
                                          blocked ||
                                          !selected.capabilities.invoke ||
                                          run.status !== 'waiting' ||
                                          !!selected.archivedAt
                                        }
                                        submit={output =>
                                          void execute({
                                            path: `${base}/${selected.id}/runs/${run.id}/input`,
                                            method: 'POST',
                                            body: { stepId: step.stepId, responseId: crypto.randomUUID(), output },
                                          })
                                        }
                                      />
                                    </>
                                  )}
                                  {step.dueAt && (
                                    <p className="text-sm text-muted-foreground">
                                      Waiting until {formatTime(step.dueAt)}
                                    </p>
                                  )}
                                </div>
                              ))}
                            <Disclosure title={`${run.steps.length} workflow steps`}>
                              <ol className="space-y-3">
                                {run.steps.map(step => (
                                  <li key={step.stepId}>
                                    <p>
                                      {step.stepId.replaceAll('_', ' ')} /{' '}
                                      {step.status === 'completed' ? 'Completed' : 'Waiting'}
                                    </p>
                                    {stepNote(step.output) && <p>{stepNote(step.output)}</p>}
                                    <pre className="max-h-64 overflow-auto text-xs">
                                      {JSON.stringify(step.output, null, 2)}
                                    </pre>
                                  </li>
                                ))}
                              </ol>
                              <Button
                                role="link"
                                variant="link"
                                size="sm"
                                nativeButton={false}
                                render={
                                  <Link
                                    to="/$workspaceSlug/workflows/$workflowId"
                                    params={{ workspaceSlug, workflowId: selected.id }}
                                    search={{ view: 'runs', run: run.id }}
                                    replace
                                    onClick={() => openRun(run.id)}
                                  />
                                }
                              >
                                Run {run.id}
                              </Button>
                            </Disclosure>
                          </article>
                        ))
                      )}
                      {olderRuns && (
                        <Button
                          variant="outline"
                          disabled={historyRead.older === 'loading'}
                          aria-busy={historyRead.older === 'loading'}
                          onClick={() => {
                            if (historyRead.older === 'failed') void historyRead.retryOlder();
                            else {
                              loadMoreStart.current =
                                historyRead.state.kind === 'ready' ? historyRead.state.data.runs.length : 0;
                              setRunPages(pages => pages + 1);
                            }
                          }}
                        >
                          {historyRead.older === 'loading'
                            ? 'Loading older runs...'
                            : historyRead.older === 'failed'
                              ? 'Retry loading older runs'
                              : 'Load older runs'}
                        </Button>
                      )}
                    </section>
                    {runs?.flatMap(run =>
                      run.steps
                        .filter(
                          step =>
                            step.output &&
                            typeof step.output === 'object' &&
                            'provider' in step.output &&
                            step.output.provider === 'slack' &&
                            'actionId' in step.output,
                        )
                        .map(step => (
                          <section
                            key={`${run.id}:${step.stepId}`}
                            aria-label={`Slack action for run ${run.id}`}
                            className="space-y-2 rounded-xl border border-border bg-card p-4"
                          >
                            <h3 className="font-medium">{step.stepId.replaceAll('_', ' ')} / Slack action</h3>
                            <WorkflowSlackAction
                              workspaceId={workspaceId}
                              output={step.output}
                              refresh={async () => {
                                await historyRead.refresh();
                              }}
                            />
                          </section>
                        )),
                    )}
                    <p className="max-w-prose text-xs text-muted-foreground">
                      Shows your own runs and scheduled runs shared with you. Other people’s runs stay private.
                    </p>
                    {historyRead.delayed && (
                      <div className="space-y-2">
                        <p role="status" className="text-sm">
                          Automatic progress checks stopped. Workflow runs continue on the server.
                        </p>
                        <Button variant="outline" onClick={() => void historyRead.refresh()}>
                          Check run status
                        </Button>
                      </div>
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="settings">
                  {!selected.archivedAt && (
                    <div className="max-w-3xl space-y-6 pt-6">
                      {selected.capabilities.manage && (
                        <div className="rounded-xl border border-border bg-card p-4">
                          <WorkflowSharing
                            key={selected.id}
                            workspaceId={workspaceId}
                            id={selected.id}
                            workflow={selected}
                            changed={refresh}
                          />
                        </div>
                      )}
                      {selected.capabilities.manage && webhook?.visible && (
                        <div className="rounded-xl border border-border bg-card p-4">
                          <WebhookSetup
                            key={selected.id}
                            hidden={false}
                            workflow={selected}
                            url={`${apiOrigin}/v1${base}/${selected.id}/webhook`}
                            blocked={blocked}
                            issued={webhookKey}
                            onRotate={(mode, secret) =>
                              void execute({
                                path: `${base}/${selected.id}/webhook-key`,
                                method: 'PUT',
                                body: {
                                  commandId: crypto.randomUUID(),
                                  expectedGeneration: selected.generation,
                                  mode,
                                  ...(secret ? { secret } : {}),
                                },
                              })
                            }
                            onRevokePrevious={() =>
                              void execute({
                                path: `${base}/${selected.id}/webhook-key/revoke-previous`,
                                method: 'POST',
                                body: { commandId: crypto.randomUUID(), expectedGeneration: selected.generation },
                              })
                            }
                            onCopied={() => setMessage('Webhook key copied. Save it in your sender before leaving.')}
                            onCopyFailed={() => setError('Clipboard access failed. Select and copy the key.')}
                          >
                            <WebhookDeliveries
                              workspaceId={workspaceId}
                              workflow={selected}
                              testRun={testRun?.workflowId === selected.id ? testRun.runId : null}
                              onDenied={deny}
                              onOpenRun={openRun}
                              test={
                                blocked
                                  ? { kind: 'blocked', reason: 'Finish or retry the current request first.' }
                                  : !(selected.enabled && selected.activeTrigger?.kind === 'webhook')
                                    ? { kind: 'blocked', reason: 'Activate the webhook revision to send a test event.' }
                                    : { kind: 'ready' }
                              }
                              onTest={() =>
                                void execute({
                                  path: `${base}/${selected.id}/webhook-test`,
                                  method: 'POST',
                                  body: { requestId: crypto.randomUUID() },
                                })
                              }
                            />
                          </WebhookSetup>
                        </div>
                      )}
                      {selected.capabilities.manage && (
                        <section
                          aria-label="Danger zone"
                          className="flex flex-col gap-4 rounded-xl border border-destructive/40 p-4 sm:flex-row sm:items-center"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <h2 className="font-medium">Archive workflow</h2>
                            <p className="text-sm text-muted-foreground">
                              Stops future runs and keeps its run history read-only.
                            </p>
                          </div>
                          <Button
                            variant="destructive"
                            pendingLabel="Archiving workflow..."
                            state={
                              blocked
                                ? { kind: 'blocked', reason: 'Finish or retry the current request first.' }
                                : { kind: 'ready' }
                            }
                            onClick={() => setConfirmArchive(true)}
                          >
                            Archive workflow
                          </Button>
                        </section>
                      )}
                      {!selected.capabilities.manage && (
                        <p className="text-sm text-muted-foreground">
                          Ask a workflow manager to change sharing, webhooks or archiving.
                        </p>
                      )}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      )}
    </PageContent>
  );
}
function commandError(error: RequestError) {
  const errors: Record<string, string> = {
    'schedule-in-past': 'The scheduled time has passed. Edit the workflow in chat before activating it.',
    'invalid-schedule': 'The schedule is invalid. Check its expression and time zone in chat.',
    'record-trigger-unavailable': 'Record date triggers are unavailable until this workspace finishes updating.',
    'record-field-unavailable': 'The table, fields or filter are no longer available. Edit the trigger in chat.',
    'record-source-denied': recordSourceDenied,
    'code-steps-unavailable': 'Code steps cannot run until an isolated code runner is configured.',
    'workflow-archived': 'This workflow is archived and can no longer change. Refresh workflows.',
    'workflow-archive-unavailable':
      'Archiving is unavailable until the storage update finishes. Disable the workflow to stop it now.',
    'webhook-signing-unavailable':
      'Signed webhook keys are unavailable until the storage update finishes. Create a bearer key for now.',
    'workflow-inactive': 'Activate the webhook revision before sending a test event.',
    'stale-generation': 'This workflow changed. Refresh workflows and try again.',
    'limit-reached': 'A workflow or run limit was reached. Cancel or wait for unfinished runs, or reuse a workflow.',
  };
  return errors[error.code] ?? 'The server rejected this change. Refresh and review your input before retrying.';
}
const runStatusLabel = {
  queued: 'Queued',
  running: 'Running workflow',
  waiting: 'Waiting to continue',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked: 'Access denied',
  skipped: 'Skipped',
} as const;
const runSourceLabel = {
  manual: 'Started manually',
  webhook: 'Started by webhook',
  schedule: 'Started by schedule',
  event: 'Started by event',
  provider: 'Started by connected app',
  record: 'Started by record date',
  row: 'Started by row change',
} as const;
function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function formatDuration(startedAt: string, finishedAt: string) {
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60),
    remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} min ${remainingSeconds} sec`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}
const sponsorSource: Partial<Record<Definition['trigger']['kind'], string>> = {
  record: ' or to read the table its record trigger watches',
  row: ' or to read the table its row trigger watches',
  provider: ' or to use the connected app its trigger polls',
};
const disabledReasons: Record<
  DisabledReason,
  { status: string; explanation: (workflow: Workflow) => string; recovery: string }
> = {
  'sponsor-access-lost': {
    status: 'sponsor lost access',
    explanation: workflow =>
      `its sponsor lost access needed to run it${sponsorSource[(workflow.activeTrigger ?? workflow.definition.trigger).kind] ?? ''}`,
    recovery: 'Restore that access or choose a sponsor who has it, then activate the saved revision.',
  },
  'record-field-unavailable': {
    status: 'record field unavailable',
    explanation: () => 'the table, watched fields, or filter its trigger uses is no longer available',
    recovery: 'Edit the trigger in chat. Once its sponsor accepts the new revision, activate it.',
  },
  'provider-backlog': {
    status: 'connected app backlog',
    explanation: () => 'too many connected-app events waited to start runs',
    recovery: 'Activate the saved revision to discard the waiting events and collect only new ones.',
  },
};
function disabledExplanation(workflow: Workflow) {
  if (!workflow.disabledReason) return 'Disabled. Saving does not activate it.';
  const reason = disabledReasons[workflow.disabledReason];
  return `Disabled automatically because ${reason.explanation(workflow)}. ${workflow.capabilities.manage ? reason.recovery : 'Ask a workflow manager to restore access or update its trigger.'}`;
}
function workflowState(workflow: Workflow): WorkflowState {
  if (workflow.archivedAt) return { mark: 'stopped', label: 'Archived', detail: formatTime(workflow.archivedAt) };
  if (workflow.enabled && workflow.activeRevision !== workflow.revision)
    return { mark: 'warning', label: 'Saved changes not active', detail: nextRun(workflow) };
  if (workflow.enabled) return { mark: 'success', label: 'Active', detail: nextRun(workflow) };
  if (workflow.disabledReason)
    return { mark: 'error', label: `Disabled: ${disabledReasons[workflow.disabledReason].status}` };
  return { mark: 'stopped', label: 'Disabled' };
}
const pendingChanges = (workflow: Workflow) =>
  workflow.enabled && !!workflow.activeRevision && workflow.activeRevision !== workflow.revision;
function pendingSchedule(workflow: Workflow) {
  if (!pendingChanges(workflow) || !workflow.activeTrigger) return undefined;
  const saved = triggerLine(workflow.definition.trigger);
  return saved === triggerLine(workflow.activeTrigger) ? undefined : saved;
}
const nextRun = (workflow: Workflow) => (workflow.nextRunAt ? `Next run ${formatTime(workflow.nextRunAt)}` : undefined);
function Count({ value }: { value: number | undefined }) {
  return <span className="min-w-4 text-muted-foreground tabular-nums">{value ?? ''}</span>;
}
const runMark: Record<RunStatus, StatusState> = {
  queued: 'pending',
  running: 'running',
  waiting: 'paused',
  completed: 'success',
  failed: 'error',
  cancelled: 'stopped',
  blocked: 'error',
  skipped: 'skipped',
};
function HumanResponse({ disabled, submit }: { disabled: boolean; submit: (output: unknown) => void }) {
  const [text, setText] = useState(''),
    [advanced, setAdvanced] = useState(false),
    [error, setError] = useState(false);
  return (
    <div className="space-y-2">
      <Label>
        {advanced ? 'Response JSON' : 'Decision or comment'}
        <Textarea value={text} disabled={disabled} onChange={event => setText(event.target.value)} />
      </Label>
      {error && <p role="alert">Enter a valid JSON response.</p>}
      <div className="flex flex-wrap gap-2">
        {!advanced && (
          <>
            <Button disabled={disabled} onClick={() => submit({ approved: true, comment: text })}>
              Approve request
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => submit({ approved: false, comment: text })}>
              Decline request
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={disabled || !text.trim()}
          onClick={() => {
            try {
              const output: unknown = advanced ? JSON.parse(text) : { response: text };
              setError(false);
              submit(output);
            } catch {
              setError(true);
            }
          }}
        >
          Submit response
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setAdvanced(!advanced);
            setError(false);
          }}
        >
          {advanced ? 'Use ordinary response' : 'Advanced JSON response'}
        </Button>
      </div>
    </div>
  );
}
