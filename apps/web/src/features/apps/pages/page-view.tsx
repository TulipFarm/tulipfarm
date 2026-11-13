import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { A2uiOutgoingMessage } from '@tulipfarm/sprout/a2ui';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Window } from 'reicon-react/icons/Window';
import { workspaceRoute } from '@/router';
import { chosenLabels, optionLabels } from '@/features/chat/layout-labels';
import { TableRequestError } from '@/features/tables/request-state';
import { failureMessage, type AppDetail } from '../api';
import { LoadFailed, Loading } from '../app-page';
import { useAppApi } from '../queries';
import { PageSurface } from './surface';
import { confirming, initialPage, pageLocked, pageReducer, type ActionResult, type Press } from './state';

const statusOf = (error: unknown) => (error instanceof TableRequestError ? error.status : 0);

/**
 * One page of a private app: its content, its sources, and its buttons. `draft` shows the editor's saved draft instead
 * of the live version, and a new `revision` reloads it in place.
 */
export function AppPageView({
  app,
  slug,
  row,
  draft,
  revision,
  actions,
  missing,
}: {
  app: AppDetail;
  slug: string | undefined;
  row: string | undefined;
  draft: boolean;
  revision?: number | undefined;
  actions?: ReactNode;
  /** Shown instead of the not-found message, such as the app's details when it has no published pages. */
  missing?: ReactNode;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const navigate = useNavigate();
  const key = `${draft}:${slug ?? ''}:${row ?? ''}`;
  const [view, dispatch] = useReducer(pageReducer, key, initialPage);
  const [cleared, setCleared] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const opened = useRef(key);
  const loads = useRef(0);
  const sending = useRef(new Set<string>());

  const goTo = (page: string, pageRow?: string) =>
    draft
      ? navigate({
          to: '/$workspaceSlug/apps/$appSlug/edit',
          params: { workspaceSlug: workspace.slug, appSlug: app.slug },
          search: { page, ...(pageRow ? { row: pageRow } : {}) },
        })
      : navigate({
          to: '/$workspaceSlug/apps/$appSlug/$page',
          params: { workspaceSlug: workspace.slug, appSlug: app.slug, page },
          search: pageRow ? { row: pageRow } : {},
        });

  useEffect(() => {
    if (opened.current !== key) {
      opened.current = key;
      dispatch({ type: 'open', key });
    }
    const controller = new AbortController();
    api.page(app.id, slug ?? null, draft, controller.signal).then(
      content => dispatch({ type: 'opened', key, content }),
      error => {
        if (!controller.signal.aborted)
          dispatch({ type: 'open-failed', key, status: statusOf(error), message: failureMessage(error) });
      },
    );
    return () => controller.abort();
  }, [key, revision, attempt]);

  const content = view.kind === 'open' ? view.content : null;
  const pageSlug = content?.page.slug;

  const load = async () => {
    if (!pageSlug) return;
    const load = ++loads.current;
    dispatch({ type: 'load' });
    try {
      const model = await api.pageData(app.id, pageSlug, draft, row);
      if (load !== loads.current) return;
      const sources = Object.fromEntries(
        Object.entries(model.updateDataModel.value).map(([id, { status, loadedAt }]) => [id, { status, loadedAt }]),
      );
      dispatch({ type: 'loaded', model, sources });
    } catch (error) {
      if (load === loads.current) dispatch({ type: 'load-failed', status: statusOf(error) });
    }
  };

  useEffect(() => {
    if (content) void load();
  }, [content]);

  useEffect(() => {
    if (pageSlug) heading.current?.focus();
  }, [key, pageSlug]);

  const settle = (result: ActionResult) => {
    setCleared(count => count + 1);
    if (result.kind === 'open-page') void goTo(result.page, result.row);
    else if (result.kind === 'open-record')
      void navigate({
        to: '/$workspaceSlug/tables/$tableId',
        params: { workspaceSlug: workspace.slug, tableId: result.tableId },
        search: { row: result.recordId },
      });
    else if (result.kind === 'ask-agent')
      void navigate({
        to: '/$workspaceSlug/agent-tasks/$taskId',
        params: { workspaceSlug: workspace.slug, taskId: result.taskId },
      });
    else void load();
  };

  const send = async (press: Press) => {
    if (!pageSlug) return;
    sending.current.add(press.requestId);
    try {
      const result = await api.pageAction(app.id, pageSlug, draft, press.actionId, {
        requestId: press.requestId,
        context: press.context,
        ...(press.labels ? { labels: press.labels } : {}),
        ...(draft ? { confirmed: true as const } : {}),
      });
      dispatch({ type: 'accepted', actionId: press.actionId, result });
      settle(result);
    } catch (error) {
      dispatch({ type: 'refused', actionId: press.actionId, status: statusOf(error), message: failureMessage(error) });
    } finally {
      sending.current.delete(press.requestId);
    }
  };

  useEffect(() => {
    if (view.kind !== 'open') return;
    for (const press of Object.values(view.presses))
      if (press.state === 'sent' && !sending.current.has(press.requestId)) void send(press);
  }, [view]);

  const press = (actionId: string, context: Record<string, unknown>, messages: unknown[]) =>
    dispatch({
      type: 'press',
      actionId,
      context,
      labels: chosenLabels(context, optionLabels(messages)),
      requestId: crypto.randomUUID(),
    });

  if (view.kind === 'ended')
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        icon={Window}
        title="Your access to this app ended"
        description="Ask an editor of this app to share it with you again."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/apps" params={{ workspaceSlug: workspace.slug }} />}
        >
          See all apps
        </Button>
      </StatePanel>
    );
  if (view.kind === 'not-found' && missing) return missing;
  if (view.kind === 'not-found')
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        icon={Window}
        title="Page not found"
        description="This app has no page at this address."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={
            draft ? (
              <Link
                to="/$workspaceSlug/apps/$appSlug/edit"
                params={{ workspaceSlug: workspace.slug, appSlug: app.slug }}
              />
            ) : (
              <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
            )
          }
        >
          Go to the home page
        </Button>
      </StatePanel>
    );
  if (view.kind === 'failed')
    return (
      <LoadFailed
        title="Could not open this page"
        message={view.message}
        retry={() => {
          opened.current = '';
          setAttempt(count => count + 1);
        }}
      />
    );
  if (view.kind === 'opening') return <Loading label="Loading page" />;

  const waiting = confirming(view);
  const { data } = view;
  const page = view.content.page;
  const refresh = (
    <Button
      variant="outline"
      size="sm"
      disabled={data.phase === 'loading'}
      aria-busy={data.phase === 'loading'}
      onClick={() => void load()}
    >
      Refresh
    </Button>
  );
  return (
    <div className="space-y-4">
      {draft ? (
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
          {page.title}
        </h2>
      ) : (
        <PageHeader
          titleRef={heading}
          focusable
          title={page.title}
          parent={{
            label: app.title,
            link: (
              <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
            ),
          }}
          actions={actions}
        />
      )}
      {view.content.navigation.length > 1 && (
        <nav aria-label="App pages" className="flex flex-wrap gap-1 border-b pb-2">
          {view.content.navigation.map(item => (
            <Button
              key={item.slug}
              variant={item.slug === page.slug ? 'secondary' : 'ghost'}
              size="sm"
              nativeButton={false}
              aria-current={item.slug === page.slug ? 'page' : undefined}
              render={
                draft ? (
                  <Link
                    to="/$workspaceSlug/apps/$appSlug/edit"
                    params={{ workspaceSlug: workspace.slug, appSlug: app.slug }}
                    search={{ page: item.slug }}
                  />
                ) : (
                  <Link
                    to="/$workspaceSlug/apps/$appSlug/$page"
                    params={{ workspaceSlug: workspace.slug, appSlug: app.slug, page: item.slug }}
                  />
                )
              }
            >
              {item.title}
            </Button>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {data.phase === 'loading'
            ? 'Loading…'
            : data.phase === 'failed'
              ? 'This page’s data couldn’t load.'
              : data.loadedAt
                ? `Loaded at ${new Date(data.loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refresh to see changes.`
                : null}
        </p>
        {refresh}
      </div>
      {data.phase === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>Check your connection, then refresh.</AlertDescription>
        </Alert>
      )}
      <PageSurface
        key={cleared}
        surface={page.surface}
        row={row}
        locked={pageLocked(view)}
        data={data}
        actions={new Map(page.actions.map(action => [action.id, action]))}
        presses={view.presses}
        retry={actionId => {
          const failed = view.presses[actionId];
          if (failed)
            dispatch({
              type: 'press',
              actionId,
              context: failed.context,
              labels: failed.labels,
              requestId: crypto.randomUUID(),
            });
        }}
        onAction={(action: Extract<A2uiOutgoingMessage, { action: unknown }>['action'], messages) =>
          press(action.name, action.context ?? {}, messages)
        }
      />
      <AlertDialog
        open={waiting !== undefined}
        onOpenChange={open => {
          if (!open && waiting) dispatch({ type: 'cancel', actionId: waiting.actionId });
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            Run “{page.actions.find(action => action.id === waiting?.actionId)?.label ?? 'this action'}” from the draft?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This makes real changes with your own permissions, the same as using the published app.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => waiting && dispatch({ type: 'confirm', actionId: waiting.actionId })}>Run it</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
