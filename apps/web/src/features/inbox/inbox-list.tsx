import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { TableRequestError } from '@/features/tables/request-state';
import { tableApi } from '@/features/tables/api';
import { useRowTitles } from '@/features/tables/hooks';
import { codeSessionApi, type OpenCodeSessionRequestItem } from '@/features/code-sessions/api';
import { useFlag } from '@/lib/feature-flags';
import { CodeSessionRequestCard } from '@/features/code-sessions/CodeSessionRequestCard';
import { markDone, useInbox, type Inbox } from './inbox';

const kindLabels: Record<Inbox['items'][number]['kind'], string> = {
  assigned: 'Assigned to you',
  waiting: 'Waiting for you',
  finished: 'Agent finished',
  mention: 'Mentioned you',
  reminder: 'Reminder',
};

/** Loads the titles of one table's Inbox rows the member can read and reports them by row id. */
function RowTitles({
  workspaceId,
  tableId,
  rowIds,
  report,
}: {
  workspaceId: string;
  tableId: string;
  rowIds: string[];
  report: (titles: Record<string, string>) => void;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useRowTitles(api, tableId, rowIds);
  const titles = read.state.kind === 'ready' ? read.state.data : null;
  useEffect(() => {
    if (titles) report(titles);
  }, [titles, report]);
  return null;
}

/** Rows that need you: assigned to you, waiting for your answer, finished by an agent you sponsor, or mentions. */
export function InboxList({ workspaceId, workspaceSlug }: { workspaceId: string; workspaceSlug: string }) {
  const read = useInbox(workspaceId);
  const codeSessionsEnabled = useFlag('code-sessions');
  const codeApi = useMemo(() => codeSessionApi(workspaceId), [workspaceId]);
  const [codeRequests, setCodeRequests] = useState<OpenCodeSessionRequestItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const report = useCallback((found: Record<string, string>) => setTitles(current => ({ ...current, ...found })), []);
  const refreshCodeRequests = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await codeApi.openRequests(signal);
        setCodeRequests(result.items);
      } catch {
        // Code session requests are additive; keep regular Inbox working if unavailable.
      }
    },
    [codeApi],
  );
  useEffect(() => {
    if (!codeSessionsEnabled) return;
    const controller = new AbortController();
    void refreshCodeRequests(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshCodeRequests(controller.signal);
    }, 4000);
    const onFocus = () => void refreshCodeRequests(controller.signal);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      controller.abort();
    };
  }, [codeSessionsEnabled, refreshCodeRequests]);
  const tables = useMemo(() => {
    const byTable = new Map<string, string[]>();
    if (read.state.kind === 'ready')
      for (const item of read.state.data.items)
        byTable.set(item.tableId, [...new Set([...(byTable.get(item.tableId) ?? []), item.rowId])]);
    return [...byTable].map(([tableId, rowIds]) => ({ tableId, rowIds: rowIds.sort() }));
  }, [read.state]);
  if (read.state.kind === 'error')
    return (
      <StatePanel
        heading="h1"
        kind="error"
        title="Your Inbox could not be loaded"
        description="Check your connection and try again."
      >
        <Button onClick={() => void read.refresh()}>Try again</Button>
      </StatePanel>
    );
  if (read.state.kind !== 'ready') return <p className="p-6 text-sm text-muted-foreground">Loading Inbox…</p>;
  const { items } = read.state.data;
  return (
    <section aria-label="Inbox" className="mx-auto w-full max-w-3xl space-y-4 overflow-auto p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">Tasks assigned to you, agent questions, and mentions.</p>
      </div>
      {tables.map(table => (
        <RowTitles
          key={table.tableId}
          workspaceId={workspaceId}
          tableId={table.tableId}
          rowIds={table.rowIds}
          report={report}
        />
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {codeRequests.length > 0 && (
        <ul className="divide-y rounded-md border">
          {codeRequests.map(item => (
            <CodeSessionRequestCard
              key={item.request.id}
              item={item}
              busy={busy === item.request.id}
              onAnswer={async answer => {
                setBusy(item.request.id);
                setError(null);
                try {
                  await codeApi.answerRequest(
                    item.session.id,
                    item.request.id,
                    answer,
                    item.request.decisionDigest ?? undefined,
                  );
                  await refreshCodeRequests();
                } catch (failure: unknown) {
                  setError(failure instanceof Error ? failure.message : 'Could not submit response.');
                } finally {
                  setBusy(null);
                }
              }}
            />
          ))}
        </ul>
      )}
      {items.length === 0 && codeRequests.length === 0 ? (
        <StatePanel
          kind="empty"
          title="Nothing needs you"
          description="Tasks assigned to you, questions from your agents, and mentions show up here."
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map(item => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={item.kind === 'waiting' ? 'warning' : 'secondary'}>{kindLabels[item.kind]}</Badge>
                  <span className="text-muted-foreground">{item.taskKey ?? item.tableName}</span>
                  <span className="text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                {titles[item.rowId] && <p className="truncate text-sm font-medium">{titles[item.rowId]}</p>}
                {item.summary && <p className="truncate text-sm text-muted-foreground">{item.summary}</p>}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={
                    item.taskKey ? (
                      <Link to="/$workspaceSlug/tasks/$key" params={{ workspaceSlug, key: item.taskKey }} />
                    ) : (
                      <Link
                        to="/$workspaceSlug/tables/$tableId"
                        params={{ workspaceSlug, tableId: item.tableId }}
                        search={{ row: item.rowId }}
                      />
                    )
                  }
                >
                  {item.taskKey ? 'Open task' : 'Open record'}
                </Button>
                {item.taskId && (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link to="/$workspaceSlug/agent-tasks/$taskId" params={{ workspaceSlug, taskId: item.taskId }} />
                    }
                  >
                    Open run
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === item.id}
                  onClick={() => {
                    setBusy(item.id);
                    setError(null);
                    void markDone(workspaceId, item.id)
                      .then(() => read.refresh())
                      .catch((failure: unknown) =>
                        setError(
                          failure instanceof TableRequestError ? failure.message : 'The item could not be marked done.',
                        ),
                      )
                      .finally(() => setBusy(null));
                  }}
                >
                  Mark done
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
