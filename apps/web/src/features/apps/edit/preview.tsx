import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Window } from 'reicon-react/icons/Window';
import { failureMessage, type AppApi } from '../api';

/* oxlint-disable tulipfarm/product-copy -- Message types the preview host posts to this page, shared with the server. */
const blockedMessage = 'preview-blocked';
const expiredMessage = 'preview-expired';
/* oxlint-enable tulipfarm/product-copy */

type Preview =
  | { kind: 'opening' }
  | { kind: 'shown' }
  | { kind: 'blocked' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

/** Signs the browser into the preview host by posting a one-time ticket into the window named `target`. */
async function enter(api: AppApi, appId: string, target: string) {
  const { ticket, entryUrl } = await api.previewTicket(appId);
  const form = document.createElement('form');
  form.method = 'post';
  form.action = entryUrl;
  form.target = target;
  form.hidden = true;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'ticket';
  field.value = ticket;
  form.append(field);
  document.body.append(form);
  form.submit();
  form.remove();
  return new URL(entryUrl).origin;
}

/** Opens the draft in its own tab, where the preview cookie is first-party. */
async function openInTab(api: AppApi, appId: string) {
  const name = `tulipfarm-draft-${appId}`;
  // The tab opens before the ticket arrives so the browser still treats it as a response to the click.
  const tab = window.open('', name);
  if (!tab) return 'Your browser blocked the new tab. Allow pop-ups for TulipFarm and try again.';
  tab.opener = null;
  try {
    await enter(api, appId, name);
    return null;
  } catch (error) {
    tab.close();
    return failureMessage(error);
  }
}

export function DraftPreview({
  api,
  appId,
  appTitle,
  buildId,
}: {
  api: AppApi;
  appId: string;
  appTitle: string;
  /** The build to show, or null when the draft has never been built. */
  buildId: string | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = useRef<string | null>(null);
  const frameName = `tulipfarm-draft-frame-${appId}`;
  const [preview, setPreview] = useState<Preview>({ kind: 'opening' });
  const [tabFailure, setTabFailure] = useState<string | null>(null);

  const open = useCallback(() => {
    origin.current = null;
    setPreview({ kind: 'opening' });
    enter(api, appId, frameName).then(
      opened => {
        origin.current = opened;
      },
      (error: unknown) => setPreview({ kind: 'failed', message: failureMessage(error) }),
    );
  }, [api, appId, frameName]);

  useEffect(() => {
    if (buildId) open();
  }, [buildId, open]);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin !== origin.current || event.source !== frame.current?.contentWindow) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === blockedMessage) setPreview({ kind: 'blocked' });
      else if (type === expiredMessage) setPreview({ kind: 'expired' });
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);

  const newTab = async () => {
    setTabFailure(null);
    setTabFailure(await openInTab(api, appId));
  };

  if (!buildId)
    return (
      <StatePanel
        kind="empty"
        heading="h2"
        icon={Window}
        title="Nothing built yet"
        description="The draft appears here after its first build."
      />
    );

  const notice =
    preview.kind === 'blocked'
      ? {
          title: 'Your browser can’t show the draft here',
          body: 'Your browser blocks the sign-in the draft needs inside this page. Open it in a new tab instead. Only people who can edit this app can open it.',
        }
      : preview.kind === 'expired'
        ? { title: 'Your sign-in to the draft expired', body: 'Reload to sign in again.' }
        : preview.kind === 'failed'
          ? { title: 'Could not open the draft', body: preview.message }
          : null;

  return (
    <section aria-labelledby="app-draft-heading" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="app-draft-heading" className="text-sm font-medium">
          Draft
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={open} disabled={preview.kind === 'opening'}>
            Reload
          </Button>
          <Button variant="outline" size="sm" onClick={() => void newTab()}>
            Open in new tab
          </Button>
        </div>
      </div>
      {tabFailure && (
        <Alert variant="destructive">
          <AlertDescription>{tabFailure}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert variant={preview.kind === 'failed' ? 'destructive' : 'default'}>
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>
            <p>{notice.body}</p>
            <div className="mt-3">
              {preview.kind === 'blocked' ? (
                <Button size="sm" onClick={() => void newTab()}>
                  Open in new tab
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={open}>
                  Reload
                </Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background" hidden={notice !== null}>
        {preview.kind === 'opening' && (
          <p role="status" className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            Opening draft…
          </p>
        )}
        <iframe
          ref={frame}
          name={frameName}
          title={`Draft of ${appTitle}`}
          src="about:blank"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          className="size-full"
          onLoad={() =>
            setPreview(current => (current.kind === 'opening' && origin.current ? { kind: 'shown' } : current))
          }
        />
      </div>
    </section>
  );
}
