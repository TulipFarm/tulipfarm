import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { GoogleSelectionForm } from './google-knowledge-selection';
import {
  GoogleKnowledgeError,
  googleConcealKeys,
  googleErrorMessages,
  googleKnowledgeApi,
  googleSourceKeys,
  type GoogleDocument,
  type GoogleKind,
  type GoogleKnowledgeApi,
  type GoogleSource,
  type ManageGoogle,
} from './google-knowledge-api';
import { CommandFeedback, ReadResult, useCommand, useExpired } from './slack-knowledge-shared';
import { KnowledgeSourceFailures } from './knowledge-source-failures';

const statusLabels = {
  queued: 'Queued for import',
  parsing: 'Reading file',
  ready: 'Searchable',
  failed: 'Import failed',
  'ocr-unavailable': 'Scanned file, not searchable',
} as const;
const syncLabels = { queued: 'Queued', syncing: 'Syncing', ready: 'Sync complete', failed: 'Sync failed' };
const sourceFailures: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(googleErrorMessages).map(([code, message]) => [code.replace(/^google-/, ''), message]),
  ),
  'incomplete-search': 'Google returned incomplete coverage. The next sync retries without deleting anything.',
  'invalid-cursor': 'Google reset its listing. The next sync starts a full reconciliation without deleting anything.',
  transient: 'Google was temporarily unavailable. The next sync retries automatically.',
  quota: 'This source exceeds the Knowledge limit. Choose a smaller folder.',
};
const documentFailures: Record<string, string> = {
  unsupported: 'This file type is not supported.',
  'resource-key-required': 'Google requires a resource key for this file, so it cannot be imported.',
  restricted: 'The file owner restricts downloads, so it cannot be imported.',
  'source-changed': 'The file changed during import. The next sync imports the latest version.',
  'ocr-unavailable': 'This looks like a scanned file. Text recognition is not available yet.',
};

function GoogleDocumentRow({ document, refresh }: { document: GoogleDocument; refresh: () => Promise<void> }) {
  const expired = useExpired(document.validUntil);
  if (expired)
    return (
      <li className="py-3">
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="File access check expired"
          description="Content is hidden. Refresh your Google access, then check files again."
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Check files again
          </Button>
        </StatePanel>
      </li>
    );
  return (
    <li aria-label={document.title} className="space-y-2 py-3">
      <h6 className="break-words text-sm font-medium">{document.title}</h6>
      <Badge variant={document.parsing === 'failed' ? 'warning' : 'secondary'}>{statusLabels[document.parsing]}</Badge>
      {document.failure && (
        <Alert variant="destructive">
          <AlertDescription>
            {documentFailures[document.failure] ?? `Import failed: ${document.failure}. Retry the source.`}
          </AlertDescription>
        </Alert>
      )}
    </li>
  );
}

function GoogleSourceDocuments({ api, sourceId }: { api: GoogleKnowledgeApi; sourceId: string }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const read = useFeatureRead({
    key: [...googleSourceKeys, 'documents', sourceId, cursor],
    load: signal => api.documents(sourceId, cursor, signal),
    staleTime: 0,
    pollWhile: data => data.items.some(document => document.parsing === 'queued' || document.parsing === 'parsing'),
    maxChecks: 15,
  });
  return (
    <section aria-label="Google import details" className="space-y-3 border-t pt-3">
      <h5 className="text-sm font-medium">Import details</h5>
      <ReadResult state={read.state} retry={read.refresh} label="Google files">
        {data => (
          <>
            {!data.items.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No authorized files on this page"
                description="Import may still be running. Refresh your Google access to check which files you can read."
              />
            ) : (
              <ul className="divide-y">
                {data.items.map(document => (
                  <GoogleDocumentRow key={document.documentId} document={document} refresh={read.refresh} />
                ))}
              </ul>
            )}
            {(cursors.length > 1 || data.nextCursor) && (
              <nav aria-label="Google file pages" className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  Previous files
                </Button>
                <Button
                  variant="outline"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                  }}
                >
                  Next files
                </Button>
              </nav>
            )}
          </>
        )}
      </ReadResult>
      <Button
        variant="outline"
        disabled={read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing)}
        onClick={() => void read.refresh()}
      >
        Check Google files again
      </Button>
    </section>
  );
}

function GoogleSourceRow({
  workspaceId,
  api,
  source,
  disabled,
  changed,
  checkStatus,
}: {
  workspaceId: string;
  api: GoogleKnowledgeApi;
  source: GoogleSource;
  disabled: boolean;
  changed: () => Promise<void>;
  checkStatus: () => Promise<void>;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);
  const { change } = useFeatureChanges();
  const [refresh, setRefresh] = useState<
    { kind: 'idle' | 'loading' } | { kind: 'done'; refreshed: number; unavailable: number } | { kind: 'error' }
  >({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const command = useCommand<ManageGoogle, GoogleSource>(
    (input, signal) => api.manage(source.sourceId, input, signal),
    async () => {
      setConfirmRemove(false);
      await changed();
    },
    googleConcealKeys,
  );
  useEffect(() => () => controller.current?.abort(), []);
  const busy = command.state.kind === 'sending';
  const locked = disabled || command.locked || refresh.kind === 'loading';
  async function refreshAccess() {
    if (controller.current || locked) return;
    const current = new AbortController();
    controller.current = current;
    setRefresh({ kind: 'loading' });
    try {
      const result = await api.refresh(source.sourceId, current.signal);
      if (current.signal.aborted) return;
      setRefresh({ kind: 'done', refreshed: result.refreshed, unavailable: result.unavailable });
      await changed();
    } catch (error) {
      if (!current.signal.aborted) {
        setRefresh({ kind: 'error' });
        if (error instanceof GoogleKnowledgeError && [401, 403, 404].includes(error.status))
          await change({ kind: 'conceal', keys: googleConcealKeys });
        else await changed();
      }
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  const manage = (action: ManageGoogle['action']) => {
    if (!locked) void command.send({ commandId: crypto.randomUUID(), action });
  };
  const scope = source.selection
    ? source.selection.kind === 'gmail'
      ? `Gmail · ${source.selection.after} to ${source.selection.before} UTC`
      : source.selection.kind === 'shared-drive'
        ? 'Shared drive'
        : source.selection.kind === 'drive-all'
          ? 'All Drive files'
          : 'Drive folder'
    : null;
  return (
    <li aria-label={source.title} className="space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <BrandIcon brand={source.selection?.kind === 'gmail' ? 'gmail' : 'google-drive'} size="sm" />
        <div className="min-w-0 flex-1 basis-48">
          <h4 className="break-words text-base font-medium">{source.title}</h4>
          {scope && (
            <p className="text-sm text-muted-foreground">
              {scope} ·{' '}
              {source.selection?.kind === 'gmail'
                ? 'Private to you'
                : `${source.memberIds.length} ${source.memberIds.length === 1 ? 'reader' : 'readers'}, including the owner`}
            </p>
          )}
        </div>
        <Badge variant={source.syncState === 'failed' || (source.counts?.failed ?? 0) > 0 ? 'warning' : 'secondary'}>
          {syncLabels[source.syncState]}
        </Badge>
        {source.state !== 'active' && (
          <Badge variant="outline">
            {source.state === 'paused' ? 'Paused' : source.state === 'disconnected' ? 'Disconnected' : 'Removed'}
          </Badge>
        )}
      </div>
      {source.counts && (
        <p className="text-sm tabular-nums">
          {source.counts.ready} searchable · {source.counts.failed} failed · {source.counts.total} discovered
        </p>
      )}
      {(source.failure || (source.counts?.failed ?? 0) > 0) && (
        <Alert variant="destructive">
          <AlertDescription>
            {source.failure
              ? (sourceFailures[source.failure] ??
                'Source processing failed. Coverage may be incomplete. Check the Google integration, then retry the source.')
              : 'Some files could not be imported. Coverage is incomplete.'}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        Search and chat only use files your own Google account confirmed in the last five minutes. Sync refreshes this
        automatically for the owner.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={disabled || source.state !== 'active'}
          onClick={() => setShowDocuments(value => !value)}
        >
          {showDocuments ? 'Hide import details' : 'View import details'}
        </Button>
        <Button
          variant="outline"
          disabled={locked || source.state !== 'active'}
          aria-busy={refresh.kind === 'loading'}
          onClick={() => void refreshAccess()}
        >
          {refresh.kind === 'loading'
            ? 'Refreshing my access…'
            : refresh.kind === 'error'
              ? 'Retry access refresh'
              : 'Refresh my access'}
        </Button>
        {source.canManage && (
          <>
            {source.state === 'active' && (
              <Button variant="outline" disabled={locked} onClick={() => manage('pause')}>
                Pause source
              </Button>
            )}
            {source.state === 'paused' && (
              <Button variant="outline" disabled={locked} onClick={() => manage('resume')}>
                Resume source
              </Button>
            )}
            {(source.syncState === 'failed' || (source.counts?.failed ?? 0) > 0) && (
              <Button variant="outline" disabled={locked} onClick={() => manage('retry')}>
                Retry source
              </Button>
            )}
            <Button variant="ghost" disabled={locked} onClick={() => setConfirmRemove(true)}>
              Remove source
            </Button>
          </>
        )}
      </div>
      {!source.canManage && (
        <p className="text-sm text-muted-foreground">Only the source owner can pause, resume, retry, or remove it.</p>
      )}
      {showDocuments && source.state === 'active' && <GoogleSourceDocuments api={api} sourceId={source.sourceId} />}
      {showDocuments && source.state === 'active' && source.canManage && (
        <KnowledgeSourceFailures workspaceId={workspaceId} sourceId={source.sourceId} />
      )}
      {busy && <p role="status">Updating source…</p>}
      {refresh.kind === 'done' && (
        <p role="status" className="text-sm">
          Checked {refresh.refreshed + refresh.unavailable} files: {refresh.refreshed} confirmed, {refresh.unavailable}{' '}
          unavailable to you. Access stays valid for at most five minutes.
        </p>
      )}
      {refresh.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not refresh your access. No current authorization is confirmed. Check your Google integration, then
            retry.
          </AlertDescription>
        </Alert>
      )}
      <CommandFeedback state={command.state} retry={command.retry} />
      {(command.state.kind === 'uncertain' || command.state.kind === 'rejected') && (
        <Button variant="outline" disabled={disabled} onClick={() => void checkStatus()}>
          Check source status
        </Button>
      )}
      {confirmRemove && (
        <div className="space-y-2">
          <p>
            Remove this selection from Knowledge? Readers lose access to its Knowledge content. The files stay in
            Google.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" disabled={locked} onClick={() => manage('remove')}>
              Confirm remove source
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => setConfirmRemove(false)}>
              Keep source
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function GoogleKnowledgeSources({ workspaceId, kinds }: { workspaceId: string; kinds: readonly GoogleKind[] }) {
  const api = useMemo(() => googleKnowledgeApi(workspaceId), [workspaceId]);
  const { change } = useFeatureChanges();
  const [selecting, setSelecting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const gmail = kinds.includes('gmail');
  const sources = useFeatureRead({
    key: [...googleSourceKeys, 'list'],
    load: api.list,
    staleTime: 0,
    pollWhile: data =>
      data.items.some(source => source.state === 'active' && ['queued', 'syncing'].includes(source.syncState)),
    maxChecks: 15,
  });
  const changed = async () => {
    await Promise.all([
      change({ keys: [[...googleSourceKeys, 'list']] }),
      change({ kind: 'conceal', keys: [[...googleSourceKeys, 'documents']] }),
    ]);
  };
  const visibleSources =
    sources.state.kind === 'ready'
      ? sources.state.data.items.filter(
          source => source.state !== 'removed' && (source.selection === null || kinds.includes(source.selection.kind)),
        )
      : [];
  const close = () => {
    setSelecting(false);
    heading.current?.focus();
  };
  const noun = gmail ? 'Gmail' : 'Google Drive';
  return (
    <section aria-label={`${noun} knowledge sources`} className="space-y-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 ref={heading} tabIndex={-1} className="text-base font-medium">
          {noun} knowledge
        </h3>
        <Button
          variant="outline"
          disabled={selecting}
          onClick={() => {
            setSelecting(true);
            setSaved(null);
          }}
        >
          {gmail ? 'Index Gmail' : 'Index Google Drive'}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {gmail
          ? 'Make selected mail searchable in chat. Gmail knowledge stays private to you.'
          : 'Make your Drive files searchable in chat. Import uses your own Google account, and each reader must still have Google access to a file to see it.'}
      </p>
      {saved && (
        <p role="status" className="text-sm">
          {saved} was saved. Import continues in the background, then you can ask about it in chat.
        </p>
      )}
      {selecting && (
        <GoogleSelectionForm
          api={api}
          kinds={kinds}
          onClose={close}
          onSaved={async source => {
            setSaved(source.title);
            close();
            await changed();
          }}
        />
      )}
      {sources.state.kind === 'ready' ? (
        <>
          {sources.state.error && (
            <div className="space-y-2">
              <Alert variant="destructive">
                <AlertDescription>
                  Could not update source status. The last confirmed list is shown; management is paused until status is
                  checked.
                </AlertDescription>
              </Alert>
              <Button variant="outline" disabled={sources.state.refreshing} onClick={() => void sources.refresh()}>
                Retry loading Google sources
              </Button>
            </div>
          )}
          {sources.state.refreshing && (
            <p role="status" className="text-sm text-muted-foreground">
              Checking Google source status…
            </p>
          )}
          {!visibleSources.length ? (
            <StatePanel
              kind="empty"
              heading="h3"
              title={`No ${noun} sources yet`}
              description={
                gmail
                  ? 'Choose a label or date range to make your mail searchable.'
                  : 'Choose My Drive, a folder, or a shared drive to make its files searchable.'
              }
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {visibleSources.map(source => (
                <GoogleSourceRow
                  key={source.sourceId}
                  workspaceId={workspaceId}
                  api={api}
                  source={source}
                  disabled={sources.state.kind !== 'ready' || !!sources.state.error || sources.state.refreshing}
                  changed={changed}
                  checkStatus={sources.refresh}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <ReadResult state={sources.state} retry={sources.refresh} label="Google sources">
          {() => null}
        </ReadResult>
      )}
      {sources.delayed && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            Google import is taking longer. Automatic checks have paused; processing continues in the background.
          </p>
          <Button
            variant="outline"
            disabled={sources.state.kind === 'ready' && sources.state.refreshing}
            onClick={() => void sources.refresh()}
          >
            Check Google imports again
          </Button>
        </div>
      )}
    </section>
  );
}
