import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge, type BadgeVariant } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useConfirmation } from '@/features/access/confirm';
import { workspaceRoute } from '@/router';
import { appFailureMessage, failureMessage, type AppDetail, type AppOperation } from '../api';
import { AppGate, LoadFailed, Loading } from '../app-page';
import { approvalLabel, canEdit, draftLabels, servingStatus } from '../labels';
import { useAppApi, useAppChanges, useAppChat, useAppOperation, useWatchedApp } from '../queries';
import { AppPageView } from '../pages/page-view';
import { DraftPreview } from './preview';

const AppChat = lazy(() =>
  import('@/features/chat/private-conversations').then(module => ({ default: module.BudConversation })),
);

type Draft = AppDetail['draft'];
// oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
type BuiltDraft = Extract<Draft, { state: 'preview-ready' }>;
// oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
const isBuilt = (draft: Draft): draft is BuiltDraft => draft.state === 'preview-ready';

const draftTones: Record<Draft['state'], BadgeVariant> = {
  empty: 'secondary',
  editing: 'info',
  building: 'info',
  // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
  'preview-ready': 'success',
  live: 'secondary',
  failed: 'destructive',
  saved: 'secondary',
};

function draftNote(draft: Draft, ownChat: string | null, canBuild: boolean) {
  switch (draft.state) {
    case 'empty':
    case 'live':
      return 'Describe what you want in chat. Nothing goes live until you publish it.';
    case 'editing':
      return draft.conversationId === ownChat
        ? 'Changes from your chat appear here after the next build.'
        : 'Another chat is changing this app. You can make changes when it finishes.';
    case 'building':
      return 'Building the latest changes.';
    // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
    case 'preview-ready':
      return 'This is the latest build. Only editors can see it until you publish it.';
    case 'failed':
      return `${appFailureMessage(draft.failure.code)} ${canBuild ? 'Build again, or ask in chat for a fix.' : 'Ask in chat for a fix.'}`;
    case 'saved':
      return 'Changes are saved. Build them to see them here.';
  }
}

const publishing = (operation: AppOperation | null) =>
  operation !== null && (operation.status === 'admitted' || operation.status === 'staging');

function publishOutcome(operation: AppOperation, hasCurrentVersion: boolean) {
  if (operation.status === 'switched')
    return { tone: 'default', text: 'Published. The draft is now the current version.' } as const;
  if (operation.status === 'superseded')
    return { tone: 'default', text: 'A newer change finished first, so this publish wasn’t applied.' } as const;
  return {
    tone: 'destructive',
    text: operation.failure
      ? appFailureMessage(operation.failure.code)
      : hasCurrentVersion
        ? 'Publishing failed. The current version hasn’t changed.'
        : 'Publishing failed. Try publishing again.',
  } as const;
}

export function AppEditPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-6">
      <AppGate>{app => <Editor app={app} />}</AppGate>
    </div>
  );
}

function Editor({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const appLink = (
    <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
  );
  if (!canEdit(app))
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        title="Only editors can change this app"
        description="Ask an editor of this app for edit access."
      >
        <Button variant="outline" nativeButton={false} render={appLink}>
          Back to app
        </Button>
      </StatePanel>
    );
  return app.kind === 'public' ? (
    <PublicEditor app={app} appLink={appLink} />
  ) : (
    <PrivateEditor app={app} appLink={appLink} />
  );
}

function ChatPanel({ appId }: { appId: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const chat = useAppChat(workspace.id, appId);
  return (
    <section
      aria-label="Chat"
      className="flex min-h-96 flex-col overflow-hidden rounded-lg border lg:w-md lg:min-h-0 lg:shrink-0"
    >
      {chat.state.kind === 'ready' ? (
        <Suspense fallback={<Loading label="Opening chat" />}>
          <AppChat workspaceId={workspace.id} chatId={chat.state.data} headerElement={null} visible compact />
        </Suspense>
      ) : chat.state.kind === 'error' || chat.state.kind === 'unavailable' ? (
        <LoadFailed
          title="Could not open chat"
          message={chat.state.kind === 'error' ? chat.state.message : 'You no longer have edit access to this app.'}
          retry={() => void chat.refresh()}
        />
      ) : (
        <Loading label="Opening chat" />
      )}
    </section>
  );
}

// A private draft is a saved definition with no code or builds, so revision 0 is the only sign nothing is saved yet.
const unsaved = (draft: Draft) => draft.revision === 0;

function privateDraftNote(draft: Draft, ownChat: string | null) {
  if (draft.state === 'editing')
    return draft.conversationId === ownChat
      ? 'Chat is changing the draft. It updates here when chat saves it.'
      : draftNote(draft, ownChat, false);
  if (unsaved(draft)) return 'Describe the app you want in chat. Nothing goes live until you publish it.';
  return 'This is the saved draft. People you share the app with still see the published version.';
}

/** A private app's chat beside its draft pages, which run with the editor's own permissions. */
function PrivateEditor({ app, appLink }: { app: AppDetail; appLink: ReactElement }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { page, row } = useSearch({ strict: false }) as { page?: string; row?: string };
  useWatchedApp(workspace.id, app.id);
  const chat = useAppChat(workspace.id, app.id);
  const chatId = chat.state.kind === 'ready' ? chat.state.data : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader titleId="app-edit-heading" title="Edit" parent={{ label: app.title, link: appLink }} />
      <p role="status" className="text-sm text-muted-foreground">
        {privateDraftNote(app.draft, chatId)}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <ChatPanel appId={app.id} />
        <section aria-label="Draft" className="flex min-h-96 min-w-0 flex-1 flex-col overflow-auto">
          {unsaved(app.draft) ? (
            <StatePanel
              kind="empty"
              heading="h2"
              title="No pages yet"
              description="Describe the app you want in chat, and its pages show here."
            />
          ) : (
            <AppPageView app={app} slug={page} row={row} draft revision={app.draft.revision} />
          )}
        </section>
      </div>
    </div>
  );
}

function PublicEditor({ app, appLink }: { app: AppDetail; appLink: ReactElement }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const confirm = useConfirmation();
  useWatchedApp(workspace.id, app.id);
  const chat = useAppChat(workspace.id, app.id);
  const chatId = chat.state.kind === 'ready' ? chat.state.data : null;
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useAppOperation(workspace.id, app.id, operationId);
  const outcome = operation.state.kind === 'ready' ? operation.state.data : null;
  const [buildFailure, setBuildFailure] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const draft = app.draft;
  useEffect(() => {
    if (outcome && !publishing(outcome)) void changes.app(app.id);
  }, [outcome?.status]);

  const build = async () => {
    setBuilding(true);
    setBuildFailure(null);
    try {
      await api.build(app.id);
      await changes.app(app.id);
    } catch (error) {
      setBuildFailure(failureMessage(error));
    } finally {
      setBuilding(false);
    }
  };

  const approved = app.approval.state === 'approved';
  const status = publishing(outcome)
    ? { label: 'Publishing', tone: 'info' as const }
    : { label: draftLabels[draft.state], tone: draftTones[draft.state] };
  const canBuild = draft.headCommit !== null && (draft.state === 'saved' || draft.state === 'failed');
  const turnedOff = app.stops.disabledAt !== null;
  const serving = servingStatus(app);
  const stopped = turnedOff || app.stops.budgetPausedAt !== null || app.stops.editorPausedAt !== null;
  const outcomeNotice = outcome && !publishing(outcome) ? publishOutcome(outcome, app.liveRelease !== null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        titleId="app-edit-heading"
        focusable
        title="Edit"
        parent={{ label: app.title, link: appLink }}
        actions={
          <>
            {canBuild && (
              <Button variant="outline" disabled={building} aria-busy={building} onClick={() => void build()}>
                Build
              </Button>
            )}
            {isBuilt(draft) && approved && !turnedOff && (
              <Button
                disabled={publishing(outcome)}
                onClick={() =>
                  confirm.open({
                    title: 'Publish this draft?',
                    description: app.liveRelease
                      ? 'It replaces the current version once it’s ready.'
                      : 'It becomes the current version once it’s ready.',
                    action: 'Publish',
                    destructive: false,
                    run: async () => {
                      try {
                        setOperationId((await api.publish(app.id, draft.buildId)).id);
                        return null;
                      } catch (error) {
                        return failureMessage(error);
                      }
                    },
                  })
                }
              >
                Publish
              </Button>
            )}
          </>
        }
      />
      {confirm.element}
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge variant={status.tone}>{status.label}</Badge>
        {stopped && serving && <Badge variant={serving.tone}>{serving.label}</Badge>}
        <span className="text-muted-foreground">
          {publishing(outcome)
            ? app.liveRelease
              ? 'The current version keeps running until this one is ready.'
              : 'The draft becomes the current version when publishing finishes.'
            : draftNote(draft, chatId, canBuild)}
        </span>
      </div>
      {isBuilt(draft) && !approved && (
        <Alert>
          <AlertTitle>This app needs approval before it can go live</AlertTitle>
          <AlertDescription>
            {app.approval.state === 'not-requested' ? (
              <p>A workspace admin must approve it. Ask for approval in this app’s settings.</p>
            ) : (
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant={approvalLabel(app.approval).tone}>{approvalLabel(app.approval).label}</Badge>
                {app.approval.state === 'rejected'
                  ? 'A workspace admin must approve it. Ask again in this app’s settings.'
                  : 'A workspace admin must approve it.'}
              </p>
            )}
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/apps/$appSlug/settings"
                    params={{ workspaceSlug: workspace.slug, appSlug: app.slug }}
                  />
                }
              >
                Open settings
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {buildFailure && (
        <Alert variant="destructive">
          <AlertDescription>{buildFailure}</AlertDescription>
        </Alert>
      )}
      {outcomeNotice && (
        <Alert variant={outcomeNotice.tone}>
          <AlertDescription>{outcomeNotice.text}</AlertDescription>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <ChatPanel appId={app.id} />
        <div className="flex min-h-96 min-w-0 flex-1 flex-col">
          <DraftPreview api={api} appId={app.id} appTitle={app.title} buildId={draft.previewBuildId} />
        </div>
      </div>
    </div>
  );
}
