import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Link } from '@tanstack/react-router';
import { Pause } from 'reicon-react/icons/Pause';
import { Play } from 'reicon-react/icons/Play';
import { Tasks } from 'reicon-react/icons/Tasks';
import { planListItemSchema, planReceiptSchema, planViewSchema, type PlanView } from '@tulipfarm/agents/plan-contracts';
import { maximumTaskLimits } from '@tulipfarm/agents/contracts';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import {
  PlanOutline,
  type PlanOutlineMark,
  type PlanOutlineTask,
  type PlanOutlineTone,
} from '@tulipfarm/sprout/plan-outline';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { TableRequestError } from '@/features/tables/request-state';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { workspaceRoute } from '@/router';
import { useCanvas, useResultAttention, type CanvasItem } from './canvas-state';
import { conversationKeys } from './queries';
import type { ConversationMessage } from './conversation-api';
import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { resultActivityApps } from './result-activity';

export type PlanSummary = z.infer<typeof planListItemSchema>;
type PlanTask = PlanView['tasks'][number];
type PlanControl =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'resume'; budget?: PlanView['budget'] }
  | { action: 'stop' };

const failures: Record<string, string> = {
  'version-conflict': 'The plan changed while you were deciding. Check its latest state, then try again.',
  'plan-closed': 'This plan has already finished or stopped.',
  'budget-lowered': 'A plan’s budget can only go up.',
  'not-starter': 'Only the person who started this plan can control it.',
};

export function planApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body }),
      signal,
      cache: 'no-store',
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(value).data?.error ?? 'plan-operation-unavailable';
      throw new TableRequestError(
        response.status,
        code,
        failures[code] ??
          (response.status === 404
            ? 'This plan is unavailable to your current membership.'
            : 'The plan could not be reached. Check your connection and try again.'),
      );
    }
    return value;
  }
  return {
    list: async (chatId: string, signal: AbortSignal) =>
      z.object({ plans: z.array(planListItemSchema) }).parse(await request(`/conversations/${chatId}/plans`, signal))
        .plans,
    read: async (planId: string, signal: AbortSignal) =>
      planViewSchema.parse(await request(`/agent-plans/${planId}`, signal)),
    control: async (planId: string, input: PlanControl & { requestId: string; expectedVersion: number }) =>
      planReceiptSchema.parse(await request(`/agent-plans/${planId}/control`, AbortSignal.timeout(15_000), input)),
  };
}
export type PlanApi = ReturnType<typeof planApi>;

const open = (plan: Pick<PlanView, 'lifecycle'>) =>
  plan.lifecycle === 'draft' || plan.lifecycle === 'active' || plan.lifecycle === 'paused';

export function usePlans(api: PlanApi, chatId: string, enabled: boolean) {
  return useFeatureRead({ key: conversationKeys.planList(chatId), load: signal => api.list(chatId, signal), enabled });
}

/** The chat stream announces plan changes; polling slowly backs it up while work can still change. */
export function usePlan(api: PlanApi, chatId: string, planId: string) {
  return useFeatureRead({
    key: conversationKeys.plan(chatId, planId),
    load: signal => api.read(planId, signal),
    pollWhile: open,
    interval: 15_000,
    maxChecks: Infinity,
  });
}

function taskLabel(task: Pick<PlanTask, 'state' | 'dependsOn'>, starter: boolean) {
  switch (task.state) {
    case 'pending':
      return task.dependsOn.length ? 'Waiting on earlier tasks' : 'Not started';
    case 'ready':
      return 'Up next';
    case 'running':
      return 'Working';
    case 'verifying':
      return 'Needs verification';
    case 'waiting-input':
      return starter ? 'Needs your answer' : 'Waiting for an answer';
    case 'waiting-approval':
      return starter ? 'Needs your review' : 'Waiting for a review';
    case 'blocked':
      return 'Blocked';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}
const taskMarks: Record<PlanTask['state'], PlanOutlineMark> = {
  pending: 'pending',
  ready: 'pending',
  running: 'running',
  verifying: 'attention',
  'waiting-input': 'attention',
  'waiting-approval': 'attention',
  blocked: 'blocked',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};
const groupMarks: Record<NonNullable<PlanTask['summary']>['outcome'], PlanOutlineMark> = {
  empty: 'pending',
  active: 'running',
  waiting: 'attention',
  completed: 'done',
  failed: 'failed',
};

function assignee(task: PlanTask) {
  if (!task.assignee) return undefined;
  if (task.assignee.kind === 'coordinator') return 'Main agent';
  return task.assignee.kind === 'agent'
    ? (task.assignee.name ?? 'Saved agent')
    : `${task.assignee.name} · created for this plan`;
}

/** Turns the server's flat projection into nested rows ordered by position. */
export function planOutline(view: PlanView, slug: string): PlanOutlineTask[] {
  const byKey = new Map(view.tasks.map(task => [task.key, task]));
  const children = new Map<string | null, PlanTask[]>();
  for (const task of view.tasks) children.set(task.parent, [...(children.get(task.parent) ?? []), task]);
  const row = (task: PlanTask): PlanOutlineTask => {
    if (task.kind === 'group') {
      const counts = task.summary?.counts;
      const mark = task.summary
        ? task.summary.outcome === 'active' && !counts?.running
          ? 'pending'
          : groupMarks[task.summary.outcome]
        : 'pending';
      return {
        id: task.id,
        title: task.title,
        mark,
        label: counts?.total ? `${counts.completed} of ${counts.total} done` : 'No tasks yet',
        brief: task.brief || undefined,
        children: (children.get(task.key) ?? []).sort((a, b) => a.position - b.position).map(row),
      };
    }
    return {
      id: task.id,
      title: task.title,
      mark: taskMarks[task.state],
      label:
        task.state === 'completed' && task.report?.outcome === 'passed' ? 'Verified' : taskLabel(task, view.canControl),
      assignee: assignee(task),
      brief: task.brief || undefined,
      criteria: task.criteria,
      reason: task.reason ?? undefined,
      dependencies: task.dependsOn.flatMap(key => {
        const dependency = byKey.get(key);
        return dependency
          ? [
              {
                id: dependency.id,
                title: dependency.title,
                label: dependency.kind === 'group' ? 'Group' : taskLabel(dependency, view.canControl),
              },
            ]
          : [];
      }),
      action:
        task.waitingTaskId || task.report ? (
          <>
            {task.waitingTaskId && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/agent-tasks/$taskId"
                    params={{ workspaceSlug: slug, taskId: task.waitingTaskId }}
                  />
                }
              >
                {task.state === 'waiting-approval' ? 'Review in task' : 'Answer in task'}
              </Button>
            )}
            {task.report && (
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>{task.report.summary}</p>
                <Collapsible>
                  <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                    Verification details
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="mt-2 space-y-2">
                      {task.report.checks.map(check => (
                        <li key={check.criterion}>
                          <p>
                            {task.criteria[check.criterion]}: {check.outcome}
                          </p>
                          {check.evidence.map(item => (
                            <p key={item.callId}>
                              {item.summary} <code className="break-all">{item.callId}</code>
                            </p>
                          ))}
                        </li>
                      ))}
                      {task.report.requirements.map(check => (
                        <li key={check.key}>
                          <p>
                            {view.planning?.requirements.find(item => item.key === check.key)?.description ?? check.key}
                            : {check.outcome}
                          </p>
                          {check.evidence.map(item => (
                            <p key={item.callId}>
                              {item.summary} <code className="break-all">{item.callId}</code>
                            </p>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </>
        ) : undefined,
    };
  };
  return (children.get(null) ?? []).sort((a, b) => a.position - b.position).map(row);
}

export function planStatus(
  view: Pick<PlanView, 'lifecycle' | 'outcome' | 'counts' | 'pause'> & Partial<Pick<PlanView, 'planning' | 'tasks'>>,
): { status: string; tone: PlanOutlineTone } {
  switch (view.lifecycle) {
    case 'draft':
      return { status: 'Ready to review', tone: 'neutral' };
    case 'active':
      return view.outcome === 'waiting'
        ? { status: 'Waiting', tone: 'attention' }
        : { status: 'Running', tone: 'active' };
    case 'paused':
      return { status: 'Paused', tone: 'attention' };
    case 'stopped':
      return { status: 'Stopped', tone: 'neutral' };
    case 'completed':
      return {
        status: view.tasks?.some(
          task => task.key === view.planning?.verificationTask && task.report?.outcome === 'passed',
        )
          ? 'Plan verified'
          : 'Plan complete',
        tone: 'done',
      };
    case 'failed':
      return { status: 'Failed', tone: 'failed' };
  }
}

export function planProgress(counts: PlanView['counts']) {
  if (counts.total === 0) return 'No tasks yet';
  const parts = [`${counts.completed} of ${counts.total} done`];
  if (counts.running) parts.push(`${counts.running} working`);
  if (counts.verifying) parts.push(`${counts.verifying} need verification`);
  const waiting = counts['waiting-input'] + counts['waiting-approval'];
  if (waiting) parts.push(`${waiting} waiting for input`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(' · ');
}

function PlanNotice({ view }: { view: PlanView }) {
  const waiting = view.tasks.filter(task => task.waitingTaskId).length;
  const notice =
    view.lifecycle === 'paused'
      ? view.pause === 'budget'
        ? {
            title: 'Paused at its budget',
            body: `The plan used its budget of ${view.budget.credits.toLocaleString()} credits. Nothing new starts until ${view.canControl ? 'you add budget and resume it' : 'the person who started it resumes it'}.`,
          }
        : view.pause === 'starter-access'
          ? {
              title: 'Paused after an access change',
              body: 'The person who started this plan can no longer use this chat, so no new work starts.',
            }
          : view.pause === 'progress'
            ? {
                title: 'Needs attention',
                body: 'Work stopped before all requirements were verified. Check the task details and existing action results before resuming.',
              }
            : {
                title: 'Paused',
                body: `Running specialists stopped and will start again on resume. Saved agents finish their current task. Nothing new starts until ${view.canControl ? 'you resume it' : 'the person who started it resumes it'}.`,
              }
      : view.lifecycle === 'draft'
        ? {
            title: 'Plan only',
            body: 'Research and the plan are saved. No setup work has started. Start this plan when you want to act; each business action still needs its own permission or review.',
          }
        : view.lifecycle === 'stopped'
          ? { title: 'Stopped', body: 'Unfinished tasks were cancelled. Finished work is kept.' }
          : view.lifecycle === 'failed'
            ? { title: 'Some tasks failed', body: 'Tasks that depended on them did not run. Other tasks continued.' }
            : waiting && view.lifecycle === 'active'
              ? {
                  title: waiting === 1 ? 'A task needs your input' : `${waiting} tasks need your input`,
                  body: 'Open the task from the list to answer or review it. Other tasks keep running.',
                }
              : null;
  if (!notice) return null;
  return (
    <Alert variant={view.lifecycle === 'failed' ? 'destructive' : 'default'}>
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>{notice.body}</AlertDescription>
    </Alert>
  );
}

/** The plan as it appears in the right-side canvas. */
export function PlanCanvas({
  workspaceId,
  chatId,
  planId,
  title,
}: {
  workspaceId: string;
  chatId: string;
  planId: string;
  title: string;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const api = useMemo(() => planApi(workspaceId), [workspaceId]);
  const read = usePlan(api, chatId, planId);
  const state = read.state;
  if (state.kind === 'loading')
    return (
      <CanvasSection>
        <div role="status" aria-label={`Loading ${title}`} className="flex flex-col gap-4">
          <Skeleton shape="title" />
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      </CanvasSection>
    );
  if (state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h3"
        icon={Tasks}
        title="Plan unavailable"
        description="This plan was removed or your access to its chat changed. Nothing from it is shown here."
      />
    );
  if (state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load this plan"
        description="The plan keeps running on the server. Your chat is unchanged."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Load plan again
        </Button>
      </StatePanel>
    );
  const view = state.data;
  const { status, tone } = planStatus(view);
  const verification = view.tasks.find(task => task.key === view.planning?.verificationTask)?.report;
  const checks = view.planning && (
    <div className="space-y-4">
      <section aria-label="Original requirements">
        <h3 className="text-sm font-medium text-foreground">What this plan must achieve</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {view.planning.requirements.map(item => {
            const checked = verification?.requirements.find(check => check.key === item.key);
            return (
              <li key={item.key}>
                {item.description}
                {checked && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {checked.outcome === 'passed' ? 'Verified' : checked.outcome}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {view.planning.prerequisites.length > 0 && (
        <section aria-label="Prerequisite checks">
          <h3 className="text-sm font-medium text-foreground">Before work starts</h3>
          <ul className="mt-2 space-y-2">
            {view.planning.prerequisites.map(check => (
              <li key={check.key}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{check.title}</span>
                  <Badge variant={check.status === 'verified' ? 'success' : 'warning'}>
                    {check.status === 'verified' ? 'Checked' : check.status === 'unknown' ? 'Not checked' : 'Blocked'}
                  </Badge>
                </div>
                {check.reason && check.status !== 'verified' && (
                  <p className="mt-1 text-sm text-muted-foreground">{check.reason}</p>
                )}
                {check.evidence.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    <Collapsible>
                      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Details</CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul className="mt-1 space-y-1">
                          {check.evidence.map(item => (
                            <li key={item.callId}>
                              {item.summary} <code className="break-all">{item.callId}</code>
                            </li>
                          ))}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
  return (
    <CanvasSection>
      <PlanOutline
        title={view.title}
        brief={view.brief}
        status={status}
        tone={tone}
        progress={planProgress(view.counts)}
        notice={
          <>
            <PlanNotice view={view} />
            {checks}
          </>
        }
        tasks={planOutline(view, workspaceSlug)}
        stale={
          state.error && (
            <Alert>
              <AlertTitle>Showing the last loaded plan</AlertTitle>
              <AlertDescription>Newer progress couldn’t be loaded.</AlertDescription>
              <div className="mt-2">
                <Button variant="outline" size="sm" disabled={state.refreshing} onClick={() => void read.refresh()}>
                  {state.refreshing ? 'Checking…' : 'Check again'}
                </Button>
              </div>
            </Alert>
          )
        }
      />
    </CanvasSection>
  );
}

export function planCanvasItem(
  workspaceId: string,
  chatId: string,
  plan: Pick<PlanSummary, 'id' | 'title'>,
): CanvasItem {
  return { id: `plan:${plan.id}`, title: plan.title, content: { kind: 'plan', workspaceId, chatId, planId: plan.id } };
}

/** Refresh on saved-turn changes even when the live stream is unavailable. */
export function ChatPlans({
  workspaceId,
  chatId,
  revision,
  foreground,
  tools = [],
}: {
  workspaceId: string;
  chatId: string;
  revision: string;
  foreground: boolean;
  tools?: ConversationMessage['tools'];
}) {
  const api = useMemo(() => planApi(workspaceId), [workspaceId]);
  const read = usePlans(api, chatId, true);
  const seen = useRef(revision);
  const { refresh } = read;
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    void refresh();
  }, [revision, refresh]);
  const plans = read.state.kind === 'ready' ? read.state.data : null;
  const canvas = useCanvas();
  const observed = useRef<{ chatId: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!plans) return;
    const previous = observed.current;
    if (!previous || previous.chatId !== chatId) {
      observed.current = { chatId, ids: new Set(plans.map(plan => plan.id)) };
      return;
    }
    const added = plans.find(plan => !previous.ids.has(plan.id));
    for (const plan of plans) previous.ids.add(plan.id);
    if (added && foreground && !canvas.activeId && window.matchMedia('(min-width: 768px)').matches)
      canvas.show(planCanvasItem(workspaceId, chatId, added));
  }, [plans, chatId, workspaceId, foreground, canvas.activeId, canvas.show]);
  if (read.state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading plans" className="mt-4">
        <Skeleton />
      </div>
    );
  if (read.state.kind === 'error')
    return (
      <Alert>
        <AlertTitle>Couldn’t load plans</AlertTitle>
        <AlertDescription>Your chat is still available.</AlertDescription>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Load plans again
        </Button>
      </Alert>
    );
  if (!plans?.length) return null;
  return (
    <ul aria-label="Plans in this chat" className="mt-8 flex flex-col gap-2">
      {[...plans]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(plan => (
          <li key={plan.id}>
            <PlanReference api={api} workspaceId={workspaceId} chatId={chatId} plan={plan} tools={tools} />
          </li>
        ))}
    </ul>
  );
}

function PlanReference({
  api,
  workspaceId,
  chatId,
  plan,
  tools,
}: {
  api: PlanApi;
  workspaceId: string;
  chatId: string;
  plan: PlanSummary;
  tools: ConversationMessage['tools'];
}) {
  const canvas = useCanvas();
  const read = usePlan(api, chatId, plan.id);
  const view = read.state.kind === 'ready' ? read.state.data : null;
  const current = view ?? plan;
  const { status, tone } = planStatus({ ...current, pause: view?.pause ?? null });
  useResultAttention(`plan:${plan.id}`, tone === 'attention', 'A plan needs your attention');
  const evidence = new Set(
    view?.tasks.flatMap(task =>
      task.report
        ? [...task.report.checks, ...task.report.requirements].flatMap(check => check.evidence.map(item => item.callId))
        : [],
    ),
  );
  const apps = resultActivityApps(
    tools
      .filter(tool => evidence.has(tool.id))
      .map(tool => ({
        id: tool.id,
        tool: tool.tool,
        status: tool.activityStatus ?? tool.status,
        presentation: tool.presentation ?? toolPresentation(tool.tool, undefined, tool.activity),
      })),
  );
  return (
    <ResultCard
      title={current.title}
      kind="Plan"
      apps={apps}
      icon={<Tasks size={18} />}
      status={status}
      state={tone === 'done' ? 'success' : tone === 'failed' ? 'error' : tone === 'active' ? 'running' : 'default'}
      action={{ label: 'Open plan', onClick: () => canvas.show(planCanvasItem(workspaceId, chatId, current)) }}
    >
      <p className="text-xs text-muted-foreground tabular-nums">{planProgress(current.counts)}</p>
      {view?.canControl && open(view) && <PlanControls api={api} chatId={chatId} view={view} />}
    </ResultCard>
  );
}

function raised(budget: PlanView['budget']): PlanView['budget'] {
  return {
    toolCalls: Math.min(budget.toolCalls * 2, maximumTaskLimits.toolCalls),
    activeMilliseconds: Math.min(budget.activeMilliseconds * 2, maximumTaskLimits.activeMilliseconds),
    credits: Math.min(budget.credits * 2, maximumTaskLimits.credits),
  };
}

/** Starter-only controls. They live beside the reference in chat, never inside the read-only outline. */
function PlanControls({ api, chatId, view }: { api: PlanApi; chatId: string; view: PlanView }) {
  const { change } = useFeatureChanges();
  const [busy, setBusy] = useState<PlanControl['action'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const budget = view.pause === 'budget' ? raised(view.budget) : undefined;
  const atMaximum =
    !!budget &&
    budget.credits === view.budget.credits &&
    budget.toolCalls === view.budget.toolCalls &&
    budget.activeMilliseconds === view.budget.activeMilliseconds;
  const run = async (control: PlanControl) => {
    const key = `${control.action}:${view.version}`;
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    setBusy(control.action);
    setError(null);
    try {
      await api.control(view.id, { ...control, requestId: request.current.id, expectedVersion: view.version });
      request.current = null;
      setConfirmStop(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The plan could not be reached. Check your connection and try again.',
      );
      if (failure instanceof TableRequestError) request.current = null;
    } finally {
      setBusy(null);
      await change({ keys: [conversationKeys.plans(chatId)] });
    }
  };
  const paused = view.lifecycle === 'paused';
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      {paused && budget && (
        <p className="text-xs text-muted-foreground">
          {atMaximum
            ? 'This plan already has the largest budget allowed.'
            : `Resuming raises the budget to ${budget.credits.toLocaleString()} credits.`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {view.lifecycle === 'draft' ? (
          <Button
            size="sm"
            disabled={!!busy}
            aria-busy={busy === 'start'}
            onClick={() => void run({ action: 'start' })}
          >
            <Play size={14} aria-hidden="true" />
            {busy === 'start' ? 'Starting…' : 'Start plan'}
          </Button>
        ) : paused ? (
          <Button
            size="sm"
            disabled={!!busy || atMaximum || view.pause === 'starter-access'}
            aria-busy={busy === 'resume'}
            onClick={() => void run(budget ? { action: 'resume', budget } : { action: 'resume' })}
          >
            <Play size={14} aria-hidden="true" />
            {busy === 'resume' ? 'Resuming…' : budget ? 'Add budget and resume' : 'Resume plan'}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            aria-busy={busy === 'pause'}
            onClick={() => void run({ action: 'pause' })}
          >
            <Pause size={14} aria-hidden="true" />
            {busy === 'pause' ? 'Pausing…' : 'Pause plan'}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmStop(true)}>
          Stop plan
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirmStop}
        onOpenChange={value => {
          if (!busy) setConfirmStop(value);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Stop this plan?</AlertDialogTitle>
          <AlertDialogDescription>
            Unfinished tasks are cancelled and saved agents pause. Finished work is kept. A stopped plan can’t be
            resumed; ask in chat to start a new plan.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Keep running</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!busy}
              aria-busy={busy === 'stop'}
              onClick={() => void run({ action: 'stop' })}
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop plan'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
