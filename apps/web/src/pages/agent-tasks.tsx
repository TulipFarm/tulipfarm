import { DataList, DataListCell, DataListRow, DataListSecondary } from '@/components/data-list';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { workspaceRoute, agentTaskRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { Status } from '@tulipfarm/sprout/status';
import { Disclosure } from '@/components/disclosure';
import { ChevronLeftIcon } from 'lucide-react';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Checklist } from 'reicon-react/icons/Checklist';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { AgentTasksSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import {
  useTaskApi,
  useTasks,
  useTaskDetail,
  useTaskHistory,
  useTaskProposals,
  useTaskProposal,
  useTaskAttachment,
  useTaskSlackActions,
  taskPending as pending,
} from '@/features/tasks/queries';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { formatTableValue } from '@/features/tables/definition-view';
import type { ReadState } from '@/features/tables/request-state';
import {
  taskApi,
  taskCredits,
  taskStatusLabel,
  taskStatusStates,
  taskNextStep,
  type TaskAction,
  type TaskProposal,
  type TaskSummary,
} from '@/features/tasks/api';
import { TaskComposer } from '@/features/tasks/composer';
import { TaskIdentity, taskTime, useTaskIdentity } from '@/features/tasks/identity';
import { conversationApi } from '@/features/chat/conversation-api';
import { agentApi } from '@/features/agents/api';
import { SlackAction } from '@/features/agents/slack-action';
import { useCatalogNavigation } from '@/lib/use-catalog-navigation';
import { McpPrivateContext } from '@/features/workspace-mcp/selection';
import { useMcpAccessLoss } from '@/features/workspace-mcp/state';
import { GitHubTaskSourceCard } from '@/features/chat/github-investigation-card';
import { GitHubBatches } from '@/features/chat/github-batches';
import { apiOrigin } from '@/lib/auth';
import { GitHubChatResponse } from '@/features/chat/github-download';
import { ActivityResultCard } from '@/features/chat/activity-result-card';

function TaskRead<T>({
  state,
  refresh,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  children: (data: T) => ReactNode;
}) {
  return (
    <ReadFeedback
      state={state}
      errorTitle="Could not load task data"
      retry={
        <Button variant="outline" onClick={() => void refresh()}>
          Retry task data
        </Button>
      }
      loading={
        <div role="status" aria-label="Loading task data" className="space-y-3">
          <Skeleton />
          <Skeleton />
        </div>
      }
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title="Task data unavailable"
          description="Only the task owner can view it. Your membership or source permissions may have changed."
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Check access again
          </Button>
        </StatePanel>
      )}
      refreshError={message => (
        <ReadError message={message}>
          <Button variant="outline" onClick={() => void refresh()}>
            Retry refresh
          </Button>
        </ReadError>
      )}
      refreshing={<p role="status">Refreshing task data…</p>}
    >
      {children}
    </ReadFeedback>
  );
}

export function AgentTasksPage() {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const api = useTaskApi(workspace.id);
  const pages = useCatalogNavigation(`${user.id}/${workspace.id}/tasks`);
  const { after, search } = pages;
  const read = useTasks(api, after, search);
  return (
    <PageContent>
      <PageHeader title="My agent tasks" description="Private work, history, and row-change reviews." />
      <SearchField
        id="task-search"
        label="Find a task request"
        placeholder="Search tasks"
        maxLength={120}
        value={search}
        onChange={pages.setSearch}
      />
      <TaskRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            {data.tasks.length ? (
              <DataList aria-label="Tasks" columns="three" headings={['Task', 'Status', 'Started']}>
                {data.tasks.map(task => (
                  <DataListRow key={task.id}>
                    <DataListCell>
                      <TaskIdentity workspaceId={workspace.id} slug={workspace.slug} task={task} />
                    </DataListCell>
                    <DataListCell>
                      <div className="space-y-1">
                        <Badge
                          variant={
                            task.status === 'completed'
                              ? 'success'
                              : task.status === 'pending'
                                ? 'secondary'
                                : 'warning'
                          }
                        >
                          <Status state={taskStatusStates[task.status]} size="sm" tooltip={false} aria-hidden="true" />
                          {taskStatusLabel(task)}
                        </Badge>
                        {task.status === 'paused' && (
                          <p className="text-sm text-muted-foreground">{taskNextStep(task)}</p>
                        )}
                      </div>
                    </DataListCell>
                    <DataListSecondary>
                      <time dateTime={task.createdAt}>{taskTime(task.createdAt)}</time>
                    </DataListSecondary>
                  </DataListRow>
                ))}
              </DataList>
            ) : search ? (
              <StatePanel
                kind="empty"
                icon={Checklist}
                title="No matching task requests"
                description="Try another phrase or clear the search. Only requests you can still access are included."
              >
                <Button variant="outline" onClick={() => pages.setSearch('')}>
                  Clear search
                </Button>
              </StatePanel>
            ) : (
              <StatePanel
                kind="empty"
                icon={Checklist}
                title="No agent tasks yet"
                description="Hand a piece of work to an activated agent and follow it here. You review every proposed row change before it runs."
                sample={<AgentTasksSample />}
              >
                <Button
                  nativeButton={false}
                  render={<Link to="/$workspaceSlug/agents" params={{ workspaceSlug: workspace.slug }} />}
                >
                  Choose an agent
                </Button>
              </StatePanel>
            )}
            {(after || data.nextCursor) && (
              <nav aria-label="Task pages" className="flex flex-wrap items-center gap-2">
                {after && (
                  <>
                    <Button variant="outline" onClick={pages.first}>
                      First task page
                    </Button>
                    <Button variant="outline" onClick={pages.previous}>
                      Previous task page
                    </Button>
                  </>
                )}
                <span className="text-sm text-muted-foreground">Page {pages.page}</span>
                {data.nextCursor && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (data.nextCursor) pages.next(data.nextCursor);
                    }}
                  >
                    Next task page
                  </Button>
                )}
              </nav>
            )}
          </>
        )}
      </TaskRead>
    </PageContent>
  );
}

export function AgentTaskPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { taskId } = agentTaskRoute.useParams();
  const denied = useMcpAccessLoss(workspace.id);
  if (denied)
    return (
      <StatePanel
        kind="unavailable"
        title="Private task access changed"
        description="Previously loaded task history, titles, and MCP results have been removed. Start a new task with clean context."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/agents" params={{ workspaceSlug: workspace.slug }} />}
        >
          Choose an agent for a new task
        </Button>
      </StatePanel>
    );
  return <TaskDetail key={`${workspace.id}/${taskId}`} workspace={workspace} taskId={taskId} />;
}

function TaskDetail({ workspace, taskId }: { workspace: { id: string; slug: string }; taskId: string }) {
  const api = useTaskApi(workspace.id);
  const read = useTaskDetail(api, taskId);
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState(false);
  return (
    <PageContent>
      <nav className="flex flex-wrap items-center justify-between gap-4">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/agent-tasks" params={{ workspaceSlug: workspace.slug }} />}
        >
          <ChevronLeftIcon data-icon="inline-start" aria-hidden="true" />
          Back to my tasks
        </Button>
      </nav>
      {read.delayed && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            Automatic checks stopped. Work continues on the server.
          </p>
          <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
            Check again
          </Button>
        </div>
      )}
      {read.state.kind !== 'ready' && read.state.kind !== 'loading' && (
        <GitHubTaskSourceCard
          workspaceId={workspace.id}
          chatId={taskId}
          slug={workspace.slug}
          disabled={false}
          picked={() => void read.refresh()}
        />
      )}
      <TaskRead state={read.state} refresh={read.refresh}>
        {task => (
          <>
            <TaskHeading workspaceId={workspace.id} task={task} />
            <McpPrivateContext
              workspaceId={workspace.id}
              origin={{ kind: 'task', id: taskId, agentId: task.agentId }}
            />
            {task.status !== 'completed' && (
              <div>
                <Button
                  variant="outline"
                  disabled={pausing || task.status === 'paused'}
                  onClick={() => {
                    if (pausing) return;
                    setPausing(true);
                    setPauseError(false);
                    void fetch(`${apiOrigin}/v1/workspaces/${workspace.id}/agent-tasks/${taskId}/pause`, {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ expectedGeneration: task.generation }),
                      signal: AbortSignal.timeout(30000),
                    })
                      .then(async response => {
                        if (!response.ok) throw new Error('unconfirmed');
                        await read.refresh();
                      })
                      .catch(() => setPauseError(true))
                      .finally(() => setPausing(false));
                  }}
                >
                  {pausing ? 'Pausing task…' : 'Pause task'}
                </Button>
                {pauseError && <p role="alert">Pause is unconfirmed. Check task status before continuing.</p>}
              </div>
            )}
            <GitHubTaskSourceCard
              workspaceId={workspace.id}
              chatId={taskId}
              slug={workspace.slug}
              requested={task.skills.some(skill => skill.id === 'github-investigation')}
              disabled={!['paused', 'waiting-clarification', 'failed'].includes(task.status)}
              picked={() => void read.refresh()}
            />
            <GitHubBatches
              workspaceId={workspace.id}
              chatId={taskId}
              task
              revision={`${task.status}/${task.toolCalls}/${task.activeMilliseconds}`}
            />
            <TaskHistory
              key={`history/${taskId}`}
              api={api}
              taskId={taskId}
              workspaceId={workspace.id}
              task={task}
              refreshTask={read.refresh}
            />
            <ActivityResultCard id={`task-activity:${taskId}`} items={task.activity} title="Task actions" />
            <TaskProposals
              key={`proposals/${taskId}`}
              api={api}
              taskId={taskId}
              generation={task.generation}
              running={pending(task)}
            />
            <TaskSlackActions workspaceId={workspace.id} taskId={taskId} refresh={read.refresh} />
            <Disclosure title="Usage and technical details">
              <section aria-label="Task accounting" className="space-y-3">
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt>Credits used</dt>
                    <dd>{taskCredits(task.cost.chargedCreditUnits)}</dd>
                  </div>
                  <div>
                    <dt>Credits reserved</dt>
                    <dd>{taskCredits(task.cost.heldCreditUnits)}</dd>
                  </div>
                  <div>
                    <dt>Tool calls</dt>
                    <dd>
                      {task.toolCalls} of {task.limits.toolCalls}
                    </dd>
                  </div>
                  <div>
                    <dt>Active time</dt>
                    <dd>
                      {Number(task.activeMilliseconds) / 1000} seconds of {task.limits.activeMilliseconds / 60000}{' '}
                      minutes
                    </dd>
                  </div>
                </dl>
                <p className="break-all text-sm text-muted-foreground">Task ID: {task.id}</p>
                <p className="break-all text-sm text-muted-foreground">Pinned definition {task.definitionRevision}</p>
              </section>
            </Disclosure>
          </>
        )}
      </TaskRead>
    </PageContent>
  );
}

function TaskSlackActions({
  workspaceId,
  taskId,
  refresh,
}: {
  workspaceId: string;
  taskId: string;
  refresh: () => Promise<void>;
}) {
  const api = useMemo(() => agentApi(workspaceId), [workspaceId]);
  const read = useTaskSlackActions(api, taskId);
  // The route is absent when Slack outbound is off, so a 404 is not task access loss; the task read above owns that feedback.
  if (read.state.kind === 'loading' || read.state.kind === 'unavailable') return null;
  const actions = read.state.kind === 'ready' ? read.state.data.actions : [];
  const failed = read.state.kind === 'error' || !!read.state.error;
  if (!actions.length && !failed) return null;
  return (
    <section aria-label="Task Slack actions" className="space-y-4">
      <h2 className="text-lg font-medium">Slack actions</h2>
      {failed && (
        <ReadError
          message={
            actions.length
              ? 'Slack actions could not refresh. Showing the last loaded actions.'
              : 'Slack actions for this task could not load. The task result is unaffected.'
          }
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry Slack actions
          </Button>
        </ReadError>
      )}
      {actions.map(action => (
        <SlackAction key={action.id} api={api} id={action.id} refresh={refresh} />
      ))}
    </section>
  );
}

function TaskHeading({ workspaceId, task }: { workspaceId: string; task: TaskSummary }) {
  const identity = useTaskIdentity(workspaceId, task.id, task.agentId);
  return (
    <header className="space-y-3">
      <h1 className="break-words text-2xl font-medium">
        {identity.state.kind === 'ready' ? identity.state.data.title : 'Private agent task'}
      </h1>
      {identity.state.kind === 'ready' && (
        <p className="break-words text-sm text-muted-foreground">
          {identity.state.data.agent} · Started {taskTime(task.createdAt)} · Private to you
        </p>
      )}
      {identity.state.kind === 'error' && (
        <div>
          <p role="alert">The task subject could not load.</p>
          <Button variant="outline" onClick={() => void identity.refresh()}>
            Retry task identity
          </Button>
        </div>
      )}
      <p role="status" className="font-medium">
        {taskStatusLabel(task)}
      </p>
      <p>{taskNextStep(task)}</p>
    </header>
  );
}

function TaskHistory({
  api,
  taskId,
  workspaceId,
  task,
  refreshTask,
}: {
  api: ReturnType<typeof taskApi>;
  taskId: string;
  workspaceId: string;
  task: TaskSummary;
  refreshTask: () => Promise<void>;
}) {
  const [fileError, setFileError] = useState('');
  const [downloading, setDownloading] = useState(false);
  async function download(id: string, filename: string) {
    if (downloading) return;
    setDownloading(true);
    setFileError('');
    try {
      const blob = await api.download(taskId, id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setFileError('The retained file could not be downloaded. Check access and try again.');
    } finally {
      setDownloading(false);
    }
  }
  const read = useTaskHistory(api, taskId, task);
  return (
    <section aria-label="Task history" className="space-y-4">
      <TaskRead state={read.state} refresh={read.refresh}>
        {messages => (
          <>
            {messages.some(message => message.role === 'agent' && message.generation === task.generation) ? (
              <section aria-label="Latest task update" className="space-y-2">
                <h2 className="text-lg font-medium">{task.status === 'completed' ? 'Result' : 'Latest update'}</h2>
                <GitHubChatResponse workspaceId={workspaceId} chatId={taskId} task>
                  {messages.filter(message => message.role === 'agent' && message.generation === task.generation).at(-1)
                    ?.text ?? ''}
                </GitHubChatResponse>
              </section>
            ) : (
              <p>No agent update for this request yet.</p>
            )}
            <Disclosure title="Request and history">
              {messages.length ? (
                <ol className="space-y-4">
                  {messages.map(message => (
                    <li key={message.sequence} className="space-y-1 break-words">
                      <h3 className="font-medium">{message.role === 'owner' ? 'You' : 'Agent'}</h3>
                      <GitHubChatResponse workspaceId={workspaceId} chatId={taskId} task>
                        {message.text}
                      </GitHubChatResponse>
                      {message.sources.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                          {message.sources.length} explicit source references. Access is checked on each read.
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No messages yet.</p>
              )}
            </Disclosure>
            <section aria-label="Retained files" className="space-y-2">
              {[
                ...new Map(
                  messages.flatMap(message =>
                    message.sources.flatMap(source =>
                      source.kind === 'attachment' ? [[source.attachmentId, source] as const] : [],
                    ),
                  ),
                ).values(),
              ].map(source => (
                <RetainedFile
                  key={source.attachmentId}
                  workspaceId={workspaceId}
                  conversationId={source.conversationId}
                  id={source.attachmentId}
                  disabled={downloading}
                  download={filename => void download(source.attachmentId, filename)}
                />
              ))}
              {fileError && <p role="alert">{fileError}</p>}
            </section>
          </>
        )}
      </TaskRead>
      <TaskComposer
        api={api}
        workspaceId={workspaceId}
        concealed={read.state.kind !== 'ready'}
        enabled={
          read.state.kind === 'ready' &&
          !read.state.error &&
          !read.state.refreshing &&
          ['waiting-clarification', 'paused', 'failed', 'completed'].includes(task.status)
        }
        mode={{
          kind: 'reply',
          task,
          sequence: read.state.kind === 'ready' ? (read.state.data.at(-1)?.sequence ?? 0) : 0,
        }}
        accepted={() => {
          void refreshTask();
          void read.refresh();
        }}
      />
    </section>
  );
}

function RetainedFile({
  workspaceId,
  conversationId,
  id,
  disabled,
  download,
}: {
  workspaceId: string;
  conversationId: string;
  id: string;
  disabled: boolean;
  download: (filename: string) => void;
}) {
  const api = useMemo(() => conversationApi(workspaceId, () => {}), [workspaceId]);
  const read = useTaskAttachment(api, conversationId, id);
  if (read.state.kind === 'loading') return <p role="status">Loading retained file…</p>;
  if (read.state.kind !== 'ready')
    return (
      <div>
        <p>Retained file unavailable. Check source access.</p>
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry file details
        </Button>
      </div>
    );
  const filename = read.state.data.filename;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p className="min-w-0 break-all text-sm">{filename}</p>
      <Button
        variant="outline"
        disabled={disabled}
        aria-label={`Download ${filename}`}
        onClick={() => download(filename)}
      >
        Download file
      </Button>
    </div>
  );
}

function TaskProposals({
  api,
  taskId,
  generation,
  running,
}: {
  api: ReturnType<typeof taskApi>;
  taskId: string;
  generation: number;
  running: boolean;
}) {
  const [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const read = useTaskProposals(api, taskId, after, running);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Proposed row changes</h2>
      <TaskRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            {data.proposals.length ? (
              <ul className="space-y-3">
                {data.proposals.map(proposal => (
                  <li key={proposal.id} className="space-y-2 break-all">
                    <p>
                      {proposal.actions.length} changes ·{' '}
                      {proposal.superseded
                        ? 'Superseded'
                        : proposal.decision === 'approve'
                          ? 'Approved'
                          : proposal.decision === 'reject'
                            ? 'Rejected'
                            : 'Needs your review'}
                    </p>
                    <p>
                      {proposal.actions.filter(action => action.status === 'completed').length} completed ·{' '}
                      {proposal.actions.filter(action => action.status === 'failed').length} failed ·{' '}
                      {proposal.actions.filter(action => action.status === 'unattempted').length} unattempted
                    </p>
                    <Button variant="outline" onClick={() => setSelected(proposal.id)}>
                      Review batch {proposal.id.slice(0, 8)}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No changes have been proposed. No row writes are authorized.</p>
            )}
            <nav className="flex gap-2">
              {after && (
                <Button variant="outline" onClick={() => setAfter(undefined)}>
                  First proposal page
                </Button>
              )}
              {data.nextCursor && (
                <Button variant="outline" onClick={() => setAfter(data.nextCursor ?? undefined)}>
                  Next proposal page
                </Button>
              )}
            </nav>
          </>
        )}
      </TaskRead>
      {selected && (
        <BatchReview
          key={selected}
          api={api}
          taskId={taskId}
          proposalId={selected}
          generation={generation}
          changed={read.refresh}
          recovered={id => {
            setSelected(id);
            void read.refresh();
          }}
        />
      )}
    </section>
  );
}

function BatchReview({
  api,
  taskId,
  proposalId,
  generation,
  changed,
  recovered,
}: {
  api: ReturnType<typeof taskApi>;
  taskId: string;
  proposalId: string;
  generation: number;
  changed: () => Promise<void>;
  recovered: (id: string) => void;
}) {
  const read = useTaskProposal(api, taskId, proposalId);
  const [notice, setNotice] = useState('');
  const write = useTableWrite(
    (command: TaskAction) => api.action(taskId, proposalId, command),
    result => {
      setNotice('Operation confirmed. Review the current action outcomes below.');
      void changed();
      if (result.kind === 'recovered') recovered(result.proposal.id);
      else void read.refresh();
    },
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  return (
    <section aria-label="Exact batch review" className="space-y-4 border-t pt-6">
      <TaskRead state={read.state} refresh={read.refresh}>
        {proposal => {
          const blocked = busy || read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error;
          const undecided = proposal.status.decision === null && !proposal.status.superseded;
          const next = proposal.status.actions.find(action => action.status !== 'completed');
          return (
            <>
              <h3 className="text-base font-medium">Review exact changes</h3>
              <p>
                Only you can approve this batch. Approval grants no additional permissions. Row changes invalidate this
                proposal.
              </p>
              <ol className="space-y-5">
                {proposal.actions.map(action => (
                  <li key={action.id} className="space-y-2 break-all">
                    <h4 className="font-medium">
                      {action.call.tool} · {action.tableName}
                    </h4>
                    <p className="text-sm">Record {action.recordId}</p>
                    <dl className="space-y-2">
                      {action.fields.map(field => (
                        <div key={field.id}>
                          <dt className="font-medium">{field.label}</dt>
                          <dd className="grid gap-2 sm:grid-cols-2">
                            <div>
                              Before
                              <pre className="whitespace-pre-wrap break-all">
                                {displayValue(action, 'before', field.id)}
                              </pre>
                            </div>
                            <div>
                              After
                              <pre className="whitespace-pre-wrap break-all">
                                {displayValue(action, 'after', field.id)}
                              </pre>
                            </div>
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p>
                      Status: {proposal.status.actions.find(status => status.id === action.id)?.status ?? 'unattempted'}
                    </p>
                  </li>
                ))}
              </ol>
              {proposal.status.superseded ? (
                <p>This proposal was superseded. It cannot authorize further writes.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {undecided && (
                    <>
                      <Button
                        disabled={blocked}
                        onClick={() =>
                          void write.submit({ kind: 'decision', digest: proposal.digest, decision: 'approve' })
                        }
                      >
                        Approve exact batch
                      </Button>
                      <Button
                        variant="outline"
                        disabled={blocked}
                        onClick={() =>
                          void write.submit({ kind: 'decision', digest: proposal.digest, decision: 'reject' })
                        }
                      >
                        Reject batch
                      </Button>
                    </>
                  )}
                  {proposal.status.decision === 'approve' && next?.status === 'unattempted' && (
                    <Button
                      disabled={blocked}
                      onClick={() => void write.submit({ kind: 'execute', actionId: next.id })}
                    >
                      Execute next approved change
                    </Button>
                  )}
                  {next && proposal.status.decision !== 'reject' && (
                    <Button
                      variant="outline"
                      disabled={blocked}
                      onClick={() => void write.submit({ kind: 'recover', requestId: crypto.randomUUID(), generation })}
                    >
                      Refresh unfinished changes
                    </Button>
                  )}
                </div>
              )}
              {!next && <p role="status">All changes in this batch are completed.</p>}
            </>
          );
        }}
      </TaskRead>
      {notice && <p role="status">{notice}</p>}
      <WriteFeedback
        state={write.state}
        checkStatus={() => void read.refresh()}
        retry={command => void write.submit(command)}
      />
    </section>
  );
}
function displayValue(action: TaskProposal['actions'][number], side: 'before' | 'after', fieldId: string) {
  const record = action[side];
  return record === null ? 'No row' : formatTableValue(record.values[fieldId], action, fieldId);
}
