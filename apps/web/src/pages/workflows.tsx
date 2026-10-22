import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { z } from 'zod';
import {
  statusSchema,
  webhookKeyIssuedSchema,
  workflowSchema,
  type Definition,
  type DisabledReason,
} from '@tulipfarm/workflows/contracts';
import { DataList, DataListCell, DataListRow, DataListSecondary } from '@/components/data-list';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Button } from '@tulipfarm/sprout/button';
import { ActionButton, jumpTo } from '@/components/action-button';
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
import { WorkflowProviders } from './workflow-providers';

type Workflow = z.infer<typeof workflowSchema>;
type Command = { path: string; method: string; body: unknown };
const WorkflowMock = import.meta.env.DEV ? lazy(() => import('@/features/workflows/workflow-mock')) : null;
export default function WorkflowsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { provider, ...link } = workspaceWorkflowsRoute.useSearch();
  const navigate = useNavigate();
  const showLink = useCallback(
    (next: WorkflowLink) =>
      void navigate({
        to: '/$workspaceSlug/workflows',
        params: { workspaceSlug: workspace.slug },
        search: current => ({ provider: current.provider, ...next }),
        replace: true,
      }),
    [navigate, workspace.slug],
  );
  if (WorkflowMock && workspace.slug === 'workflow-mock')
    return (
      <Suspense fallback={<p role="status">Loading workflow mock...</p>}>
        <WorkflowMock />
      </Suspense>
    );
  return (
    <WorkflowPage
      key={workspace.id}
      workspaceId={workspace.id}
      initialProvider={provider}
      link={link}
      onLink={showLink}
    />
  );
}
function WorkflowPage({
  workspaceId,
  initialProvider,
  link,
  onLink,
}: {
  workspaceId: string;
  initialProvider?: Parameters<typeof WorkflowProviders>[0]['initialProvider'];
  link: WorkflowLink;
  onLink: (link: WorkflowLink) => void;
}) {
  const base = `/workspaces/${workspaceId}/workflows`;
  const { slug: workspaceSlug } = workspaceRoute.useRouteContext().workspace;
  const navigate = useNavigate(),
    read = useWorkflows(workspaceId),
    changes = useWorkflowChanges();
  const [denied, setDenied] = useState(false),
    [shelf, setShelf] = useState<'current' | 'archived'>('current');
  const [archivedOpened, setArchivedOpened] = useState(false),
    [search, setSearch] = useState('');
  const archivedRead = useArchivedWorkflows(workspaceId, archivedOpened);
  const [input, setInput] = useState(''),
    [inputJson, setInputJson] = useState(false);
  const [providerSetup, setProviderSetup] = useState(!!initialProvider);
  const [revision, setRevision] = useState<'saved' | 'active'>('saved');
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null),
    [runPages, setRunPages] = useState(1),
    [runDiagram, setRunDiagram] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Command | null>(null);
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [focusTarget, setFocusTarget] = useState<'workflow-views' | 'workflow-run-diagram' | null>(null);
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
    initialProvider: !!initialProvider,
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
    if (!focusTarget || blocked) return;
    jumpTo(focusTarget);
    setFocusTarget(null);
  }, [focusTarget, blocked]);
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
    setBusy(true);
    setError('');
    setMessage('');
    setPending(command);
    try {
      const result = await request(command.path, command.method, command.body);
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
  const unavailable = denied || read.state.kind === 'unavailable';
  const webhook = selected ? webhookStatus(selected) : null;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <UnsavedChanges dirty={pending !== null} keepsEdits={samePage} />
        <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
          <AlertDialogContent>
            <AlertDialogTitle>Archive {selected?.definition.name ?? 'this workflow'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its schedule, webhook and connected-app triggers stop. Unfinished runs stop. History is kept. This cannot
              be undone.
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
          title="Workflows"
          description="See how repeatable work runs. Create and edit workflows in chat."
          actions={
            <Button disabled={blocked || unavailable} onClick={create}>
              New workflow
            </Button>
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
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void (shelf === 'archived' ? archivedRead.refresh() : refresh())}
              >
                Refresh workflows
              </Button>
              <Button variant="ghost" onClick={() => setProviderSetup(value => !value)}>
                {providerSetup ? 'Close integration setup' : 'Integration setup'}
              </Button>
            </div>
            {read.state.error && <p role="alert">Refresh failed. These are your last checked workflows.</p>}
            <nav id="workflow-views" aria-label="Workflow views" className="flex flex-wrap gap-2">
              <Button
                variant={view === 'list' ? 'secondary' : 'ghost'}
                disabled={blocked}
                onClick={() => setView('list')}
              >
                All workflows
              </Button>
              {selected && (
                <>
                  <Button variant={view === 'definition' ? 'secondary' : 'ghost'} onClick={() => setView('definition')}>
                    Definition and activation
                  </Button>
                  <Button variant={view === 'runs' ? 'secondary' : 'ghost'} onClick={() => setView('runs')}>
                    Runs
                  </Button>
                </>
              )}
            </nav>
            {providerSetup && (
              <WorkflowProviders
                workspaceId={workspaceId}
                workflowId={selected?.id ?? null}
                initialProvider={initialProvider}
                trigger={selected?.definition.trigger ?? { kind: 'manual' }}
                disabled={blocked}
                onDenied={deny}
              />
            )}
            {view === 'list' && (
              <section aria-label="Workflow selection" className="space-y-3">
                <div role="group" aria-label="Workflow filter" className="flex flex-wrap gap-2">
                  <Button
                    variant={shelf === 'current' ? 'secondary' : 'ghost'}
                    aria-pressed={shelf === 'current'}
                    onClick={() => showShelf('current')}
                  >
                    Current workflows
                  </Button>
                  <Button
                    variant={shelf === 'archived' ? 'secondary' : 'ghost'}
                    aria-pressed={shelf === 'archived'}
                    onClick={() => showShelf('archived')}
                  >
                    Archived workflows
                  </Button>
                </div>
                {(!!shelfWorkflows?.length || !!search) && (
                  <SearchField
                    id="workflow-search"
                    label="Find workflows"
                    placeholder={shelf === 'archived' ? 'Search archived workflows' : 'Search current workflows'}
                    value={search}
                    onChange={setSearch}
                  />
                )}
                {!!shelfWorkflows?.length && (
                  <DataList
                    aria-label={shelf === 'archived' ? 'Archived workflows' : 'Workflows'}
                    columns="three"
                    headings={['Name', 'Trigger', shelf === 'archived' ? 'Archived' : 'Status']}
                  >
                    {shelfWorkflows.filter(matches).map(workflow => (
                      <DataListRow key={workflow.id}>
                        <DataListCell>
                          <Button variant="link" size="md" disabled={blocked} onClick={() => choose(workflow)}>
                            {workflow.definition.name}
                          </Button>
                        </DataListCell>
                        <DataListSecondary>{triggerSummary(workflow)}</DataListSecondary>
                        <DataListCell>
                          {workflow.archivedAt
                            ? `Archived ${formatTime(workflow.archivedAt)}`
                            : workflow.enabled
                              ? workflow.activeRevision === workflow.revision
                                ? 'Active'
                                : 'Saved changes not active'
                              : workflow.disabledReason
                                ? `Disabled: ${disabledReasons[workflow.disabledReason].status}`
                                : 'Disabled'}
                        </DataListCell>
                      </DataListRow>
                    ))}
                  </DataList>
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
                {search && !!shelfWorkflows?.length && !shelfWorkflows.some(matches) && (
                  <StatePanel
                    kind="empty"
                    title="No matching workflows"
                    description="Try another name or clear your search."
                  />
                )}
                {search && (
                  <Button variant="ghost" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                )}
              </section>
            )}
            {selected && view === 'definition' && (
              <section aria-label="Workflow definition" className="space-y-4">
                {selected.activeRevision && selected.activeRevision !== selected.revision && (
                  <div role="group" aria-label="Displayed revision" className="flex gap-2">
                    <Button
                      variant={revision === 'saved' ? 'secondary' : 'ghost'}
                      aria-pressed={revision === 'saved'}
                      onClick={() => setRevision('saved')}
                    >
                      Saved revision
                    </Button>
                    <Button
                      variant={revision === 'active' ? 'secondary' : 'ghost'}
                      aria-pressed={revision === 'active'}
                      onClick={() => setRevision('active')}
                    >
                      Active revision
                    </Button>
                  </div>
                )}
                <WorkflowDefinition workspaceId={workspaceId} workflowId={selected.id} revision={revision} />
                <p className="text-sm text-muted-foreground">
                  {selected.archivedAt
                    ? `Archived ${formatTime(selected.archivedAt)}.`
                    : selected.enabled
                      ? `Active.${selected.nextRunAt ? ` Next scheduled run ${formatTime(selected.nextRunAt)}.` : ''}`
                      : disabledExplanation(selected)}
                </p>
                {selected.capabilities.manage && !selected.archivedAt && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
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
                      <ActionButton
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
                      </ActionButton>
                    </div>
                    <WorkflowSharing
                      key={selected.id}
                      workspaceId={workspaceId}
                      id={selected.id}
                      workflow={selected}
                      changed={refresh}
                    />
                  </>
                )}
                {!selected.archivedAt && (
                  <AcceptWorkflowSponsorship workspaceId={workspaceId} workflow={selected} changed={refresh} />
                )}
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
                {selected.capabilities.manage && !selected.archivedAt && webhook?.visible && (
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
                )}
              </section>
            )}
            {selected && view === 'runs' && (
              <div className="space-y-6">
                <div>
                  <Button variant="outline" onClick={() => void historyRead.refresh()}>
                    Check run history
                  </Button>
                  {(historyRead.state.kind === 'error' ||
                    (historyRead.state.kind === 'ready' && historyRead.state.error)) && (
                    <p role="alert">Run history could not refresh. Your previous history and input remain available.</p>
                  )}
                </div>
                {runDiagram && (
                  <section id="workflow-run-diagram" tabIndex={-1} aria-label="Selected run diagram">
                    <WorkflowRun
                      key={runDiagram}
                      workspaceId={workspaceId}
                      workflowId={selected.id}
                      runId={runDiagram}
                    />
                    <Button variant="ghost" onClick={() => setRunDiagram(null)}>
                      Close run diagram
                    </Button>
                  </section>
                )}
                {(selected.activeTrigger?.kind === 'row' ||
                  (!!selected.rowQueue &&
                    selected.rowQueue.pending + selected.rowQueue.blocked + selected.rowQueue.cancelled > 0)) && (
                  <RowEventQueue key={selected.id} workspaceId={workspaceId} workflow={selected} onRefresh={refresh} />
                )}
                {selected.archivedAt ? (
                  <p className="text-sm text-muted-foreground">
                    Archived {formatTime(selected.archivedAt)}. Its run history is read-only.
                  </p>
                ) : (
                  <fieldset disabled={!selected.capabilities.invoke} className="min-w-0">
                    <section aria-label="Run workflow" className="max-w-3xl space-y-3">
                      <h2 className="text-lg font-medium">Run manually</h2>
                      {!selected.capabilities.invoke && (
                        <p className="text-sm">Ask a manager for run permission to start runs or respond to steps.</p>
                      )}
                      <Label htmlFor="run-input">{inputJson ? 'Input JSON' : 'Request to review'}</Label>
                      <Textarea
                        id="run-input"
                        value={input}
                        disabled={blocked}
                        onChange={event => setInput(event.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
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
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Runs continue after you leave. A response resumes the run right away.
                      </p>
                    </section>
                  </fieldset>
                )}
                <section aria-label="Run history" className="space-y-4">
                  <h2 id="workflow-run-history" tabIndex={-1} className="text-sm font-medium">
                    Run history
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
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
                    {historyRead.state.kind === 'ready' && historyRead.state.refreshing && (
                      <p role="status">{runStatus ? 'Loading filtered run history...' : 'Refreshing run history...'}</p>
                    )}
                  </div>
                  {runs === null ? (
                    <p role="status">Run history has not loaded.</p>
                  ) : !runs.length && runStatus ? (
                    <div className="space-y-2">
                      <p>No runs in your history for this workflow match {runStatusLabel[runStatus]}.</p>
                      <Button variant="outline" onClick={() => filterRuns(null)}>
                        Clear filter
                      </Button>
                    </div>
                  ) : !runs.length ? (
                    <p>
                      {selected.archivedAt
                        ? 'No runs in your history for this workflow.'
                        : 'No runs yet. Activate the saved revision, and run it above.'}
                    </p>
                  ) : (
                    runs.map(run => (
                      <article
                        key={run.id}
                        id={`workflow-run-${run.id}`}
                        tabIndex={-1}
                        className="space-y-3 rounded-lg border p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 role="status" className="font-medium">
                            {runStatusLabel[run.status]}
                          </h3>
                          <Button variant="outline" size="sm" onClick={() => openRun(run.id)}>
                            View run diagram
                          </Button>
                        </div>
                        <p className="text-xs">
                          {runSourceLabel[run.source]} /{' '}
                          <time dateTime={run.createdAt}>Created {formatTime(run.createdAt)}</time>
                          {run.scheduledFor && (
                            <>
                              {' '}
                              / <time dateTime={run.scheduledFor}>Scheduled for {formatTime(run.scheduledFor)}</time>
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
                        {runNote(run) && <p className="text-sm">{runNote(run)}</p>}
                        {run.error && run.status !== 'skipped' && <p role="alert">{run.error}</p>}
                        {run.steps
                          .filter(step => step.status === 'waiting')
                          .map(step => (
                            <div key={step.stepId} className="space-y-2">
                              <AgentStepStatus output={step.output} />
                              {step.prompt && (
                                <>
                                  <p>{step.prompt}</p>
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
                              {step.dueAt && <p className="text-sm">Waiting until {formatTime(step.dueAt)}</p>}
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
                                to="/$workspaceSlug/workflows"
                                params={{ workspaceSlug }}
                                search={{ workflow: selected.id, view: 'runs', run: run.id }}
                                replace
                                onClick={() => openRun(run.id)}
                              />
                            }
                          >
                            Run {run.id}
                          </Button>
                        </Disclosure>
                        {['queued', 'running', 'waiting'].includes(run.status) && !selected.archivedAt && (
                          <Button
                            variant="outline"
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
                        className="space-y-2 rounded-lg border p-4"
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
                <p className="text-sm text-muted-foreground">
                  History includes your private manual runs and unattended runs explicitly shared with you. Definition
                  managers cannot see other requesters' histories. Unfinished runs appear first, followed by finished
                  runs, newest first, 50 at a time. Choose Skipped to review occurrences that did not start.
                </p>
                {historyRead.delayed && (
                  <div className="space-y-2">
                    <p role="status">Automatic progress checks stopped. Workflow runs continue on the server.</p>
                    <Button variant="outline" onClick={() => void historyRead.refresh()}>
                      Check run status
                    </Button>
                  </div>
                )}
              </div>
            )}
            {error && <p role="alert">{error}</p>}
            {message && <p role="status">{message}</p>}
            {pending && !busy && (
              <div id="workflow-retry">
                <Button variant="outline" onClick={() => void execute(pending)}>
                  Retry exact request
                </Button>
              </div>
            )}
          </>
        )}
      </PageContent>
    </div>
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
function triggerSummary(workflow: Workflow) {
  const trigger = workflow.enabled
    ? (workflow.activeTrigger ?? workflow.definition.trigger)
    : workflow.definition.trigger;
  return `${trigger.kind} trigger${workflow.enabled && workflow.activeRevision !== workflow.revision ? ' (active revision)' : ''}${workflow.enabled && workflow.nextRunAt ? ` / next run ${formatTime(workflow.nextRunAt)}` : ''}`;
}
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
