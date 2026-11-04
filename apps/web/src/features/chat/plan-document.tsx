import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Share } from 'reicon-react/icons/Share';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { useCanvas } from './canvas-state';
import { conversationKeys } from './queries';
import type { PlanApi, PlanDetail } from './plans';

// Matches the policy the API sends with the page; the frame also runs without scripts or same-origin access.
const framePolicy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** Pins the page to the frame policy and opens its links in a new tab, since a sandboxed frame can't leave itself. */
function framed(html: string) {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const policy = page.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = framePolicy;
  const base = page.createElement('base');
  base.target = '_blank';
  page.head.prepend(policy, base);
  return `<!doctype html>${page.documentElement.outerHTML}`;
}

function approvedAt(approval: NonNullable<PlanDetail['approval']>) {
  const date = new Date(approval.approvedAt);
  if (Number.isNaN(date.getTime())) return approval.approvedAt;
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return date.toLocaleString(undefined, { ...options, timeZone: approval.timeZone });
  } catch {
    return date.toLocaleString(undefined, options);
  }
}

/** The stamp the PDF carries for the shown revision. */
function stamp(view: PlanDetail, revision: number) {
  const approval = view.approval;
  if (!approval || revision < approval.revision) return { text: 'Draft, not approved', variant: 'outline' as const };
  if (revision === approval.revision)
    return {
      text: `Approved by ${approval.approvedBy ?? 'a former member'}, ${approvedAt(approval)}, revision ${revision}`,
      variant: 'success' as const,
    };
  return {
    text: `Changed since approval: revision ${revision}, approved revision ${approval.revision}`,
    variant: 'warning' as const,
  };
}

/** The Document view: the latest produced revision as a page, with its PDF in Files. */
export function PlanDocument({
  api,
  workspaceSlug,
  chatId,
  view,
}: {
  api: PlanApi;
  workspaceSlug: string;
  chatId: string;
  view: PlanDetail;
}) {
  const render = view.documentRender ?? null;
  const [ready, setReady] = useState<number | null>(null);
  if (render?.status === 'ready' && render.revision !== ready) setReady(render.revision);
  // Before a revision has been seen ready, an in-progress or failed one has its predecessor behind it.
  const shown =
    render?.status === 'ready'
      ? render.revision
      : (ready ?? (render && render.revision > 1 ? render.revision - 1 : null));
  const updating =
    !!render &&
    (render.status === 'pending' ||
      render.status === 'rendering' ||
      (render.status === 'ready' && render.revision < view.contentRevision));
  const failed = render?.status === 'failed';
  const detached = render?.error === 'file-detached';
  const tooLarge = render?.error === 'pdf-too-large';
  const quota = render?.error === 'quota';
  const fileId = detached ? null : (render?.fileId ?? null);

  const { change } = useFeatureChanges();
  const [busy, setBusy] = useState<'retry' | 'recreate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'retry' | 'recreate') => {
    setBusy(action);
    setError(null);
    try {
      await (action === 'retry' ? api.retryDocument(view.id) : api.recreateDocument(view.id));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The plan could not be reached. Check your connection and try again.',
      );
    } finally {
      setBusy(null);
      await change({ keys: [conversationKeys.plan(chatId, view.id)] });
    }
  };

  // Sharing goes through chat so the agent proposes the share and checks who can see the plan's sources.
  const { requestComposer } = useCanvas();
  const canShare = view.canControl && !!fileId;

  const notes = (
    <>
      {updating && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating the document…
        </p>
      )}
      {failed && !detached && (
        <Alert>
          <AlertTitle>This document is out of date</AlertTitle>
          <AlertDescription>
            {quota
              ? `Your Files storage is full, so revision ${render.revision} couldn’t be saved.`
              : `Revision ${render.revision} couldn’t be produced.`}
            {shown ? ` This shows revision ${shown}.` : ''}
          </AlertDescription>
          {view.canControl && (
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                aria-busy={busy === 'retry'}
                onClick={() => void act('retry')}
              >
                {busy === 'retry' ? 'Trying again…' : 'Try again'}
              </Button>
            </div>
          )}
        </Alert>
      )}
      {detached && (
        <Alert>
          <AlertTitle>The PDF was removed from Files</AlertTitle>
          <AlertDescription>TulipFarm won’t save this plan’s PDF again unless you ask.</AlertDescription>
          {view.canControl && (
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                aria-busy={busy === 'recreate'}
                onClick={() => void act('recreate')}
              >
                {busy === 'recreate' ? 'Saving…' : 'Save a new PDF'}
              </Button>
            </div>
          )}
        </Alert>
      )}
      {tooLarge && !failed && (
        <p className="text-xs text-muted-foreground">The PDF is larger than 10 MB, so it wasn’t saved to Files.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );

  if (shown === null)
    return (
      <div className="flex flex-col gap-3">
        {notes}
        {!updating && !failed && (
          <StatePanel
            kind="empty"
            heading="h3"
            title="No document yet"
            description={
              view.document
                ? 'The document appears here once it’s ready.'
                : 'Ask in chat to write a summary for this plan, and its document appears here.'
            }
          />
        )}
      </div>
    );

  const { text, variant } = stamp(view, shown);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={variant}>{text}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {fileId && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/$workspaceSlug/files/$fileId"
                  params={{ workspaceSlug, fileId }}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              Open PDF
            </Button>
          )}
          {canShare && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => requestComposer('Share this plan with ', [], { caretAtPrompt: true })}
            >
              <Share size={14} aria-hidden="true" />
              Share
            </Button>
          )}
        </div>
      </div>
      {notes}
      <DocumentFrame api={api} chatId={chatId} planId={view.id} title={view.title} revision={shown} />
    </div>
  );
}

function DocumentFrame({
  api,
  chatId,
  planId,
  title,
  revision,
}: {
  api: PlanApi;
  chatId: string;
  planId: string;
  title: string;
  revision: number;
}) {
  const read = useFeatureRead({
    key: [...conversationKeys.plan(chatId, planId), 'document', revision],
    staleTime: Infinity,
    load: signal => api.document(planId, revision, signal),
  });
  const state = read.state;
  const page = useMemo(() => (state.kind === 'ready' ? framed(state.data) : null), [state]);
  if (state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading the document" className="flex flex-col gap-3">
        <Skeleton shape="title" />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  if (state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title={state.status === 403 ? 'This document hasn’t been shared with you' : 'Document unavailable'}
        description={
          state.status === 403
            ? 'You can still follow the plan in Outline.'
            : 'It may have been removed, or your access changed. The plan is unaffected.'
        }
      />
    );
  if (state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load the document"
        description="The plan is unaffected. Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Load document again
        </Button>
      </StatePanel>
    );
  return (
    <iframe
      title={`${title}, revision ${revision}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={page ?? ''}
      className="h-160 max-h-screen min-h-96 w-full rounded-md border bg-white"
    />
  );
}
