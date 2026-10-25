import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { SlackSelectionForm } from './slack-knowledge-selection';
import {
  SlackKnowledgeError,
  slackConcealKeys,
  slackErrorMessages,
  slackKnowledgeApi,
  slackSourceKeys,
  type ManageSlack,
  type SlackDocument,
  type SlackKnowledgeApi,
  type SlackSource,
} from './slack-knowledge-api';
import { CommandFeedback, ReadResult, useCommand, useExpired } from './slack-knowledge-shared';
import { KnowledgeSourceFailures } from './knowledge-source-failures';

const statusLabels = {
  queued: 'Queued for import',
  parsing: 'Reading thread',
  ready: 'Searchable',
  failed: 'Import failed',
  'ocr-unavailable': 'Not searchable',
} as const;

const syncLabels = { queued: 'Queued', syncing: 'Syncing', ready: 'Sync complete', failed: 'Sync failed' };
const conversationFailures: Record<string, string> = {
  archived: 'Archived in Slack. Its messages stay hidden until it is unarchived; other conversations keep syncing.',
  'not-member': 'The source owner is no longer a member. Messages stay hidden until membership is restored.',
  forbidden: 'Slack no longer shows this conversation to the source owner. It may have moved or been deleted.',
  'wrong-kind': 'This conversation changed type in Slack and no longer matches the selection.',
};
const sourceFailures: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(slackErrorMessages).map(([code, message]) => [code.replace(/^slack-/, ''), message]),
  ),
  'not-linked': 'The source owner must link Slack again, then retry this source.',
  'invalid-cursor': 'Slack reset its listing. The next sync starts a full reconciliation without deleting anything.',
  transient: 'Slack was temporarily unavailable. The next sync retries automatically.',
};
const documentFailures: Record<string, string> = {
  'thread-too-large': 'This thread exceeds the 1,000-message or 1 MB limit and is not searchable.',
  'source-changed': 'The thread changed during import. The next sync imports the latest version.',
  'resource-limited': 'This thread exceeds the Knowledge limit.',
};

function OriginalDownload({ api, document }: { api: SlackKnowledgeApi; document: SlackDocument }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const controller = useRef<AbortController | null>(null);
  const noun = document.historical ? 'earlier version' : 'thread';
  useEffect(() => () => controller.current?.abort(), []);
  async function download() {
    if (controller.current || Date.parse(document.validUntil) <= Date.now()) return;
    const current = new AbortController();
    controller.current = current;
    setState('loading');
    try {
      const result = await api.original(document.documentId, document.revisionId, current.signal);
      if (current.signal.aborted || Date.parse(document.validUntil) <= Date.now()) return;
      const url = URL.createObjectURL(result.blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState('idle');
    } catch {
      if (!current.signal.aborted) setState('error');
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  return (
    <div className="space-y-2">
      {state === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>Could not download the {noun}. Refresh your Slack access and try again.</AlertDescription>
        </Alert>
      )}
      <Button
        variant="outline"
        disabled={state === 'loading'}
        aria-busy={state === 'loading'}
        onClick={() => void download()}
      >
        {state === 'loading'
          ? `Downloading ${noun}…`
          : state === 'error'
            ? `Retry ${noun} download`
            : `Download ${noun}`}
      </Button>
    </div>
  );
}

function SlackDocumentRow({
  api,
  document,
  refresh,
}: {
  api: SlackKnowledgeApi;
  document: SlackDocument;
  refresh: () => Promise<void>;
}) {
  const expired = useExpired(document.validUntil);
  if (expired)
    return (
      <li className="py-3">
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Thread access check expired"
          description="Content is hidden. Refresh your Slack access, then check threads again."
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Check threads again
          </Button>
        </StatePanel>
      </li>
    );
  return (
    <li aria-label={document.title} className="space-y-3 py-3">
      <h6 className="break-words text-sm font-medium">{document.title}</h6>
      <Badge variant={document.parsing === 'failed' ? 'warning' : 'secondary'}>{statusLabels[document.parsing]}</Badge>
      {document.failure && (
        <Alert variant="destructive">
          <AlertDescription>
            {documentFailures[document.failure] ?? `Import failed: ${document.failure}. Retry the source.`}
          </AlertDescription>
        </Alert>
      )}
      {document.historical && (
        <p className="text-sm text-muted-foreground">
          This thread changed in Slack. Knowledge has not imported the current version, so this download is the earlier
          version.
        </p>
      )}
      <OriginalDownload api={api} document={document} />
    </li>
  );
}

function SlackSourceDocuments({ api, sourceId }: { api: SlackKnowledgeApi; sourceId: string }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const read = useFeatureRead({
    key: [...slackSourceKeys, 'documents', sourceId, cursor],
    load: signal => api.documents(sourceId, cursor, signal),
    staleTime: 0,
    pollWhile: data => data.items.some(document => document.parsing === 'queued' || document.parsing === 'parsing'),
    maxChecks: 15,
  });
  return (
    <section aria-label="Slack import details" className="space-y-3 border-t pt-3">
      <h5 className="text-sm font-medium">Import details</h5>
      <ReadResult state={read.state} retry={read.refresh} label="Slack threads">
        {data => (
          <>
            {!data.items.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No authorized threads on this page"
                description="Import may still be running. Refresh your Slack access to check which threads you can read."
              />
            ) : (
              <ul className="divide-y">
                {data.items.map(document => (
                  <SlackDocumentRow key={document.documentId} api={api} document={document} refresh={read.refresh} />
                ))}
              </ul>
            )}
            {(cursors.length > 1 || data.nextCursor) && (
              <nav aria-label="Slack thread pages" className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  Previous Slack threads
                </Button>
                <Button
                  variant="outline"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                  }}
                >
                  Next Slack threads
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
        Check Slack threads again
      </Button>
    </section>
  );
}

function SlackSourceRow({
  workspaceId,
  api,
  source,
  disabled,
  changed,
  checkStatus,
}: {
  workspaceId: string;
  api: SlackKnowledgeApi;
  source: SlackSource;
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
  const command = useCommand<ManageSlack, SlackSource>(
    (input, signal) => api.manage(source.sourceId, input, signal),
    async () => {
      setConfirmRemove(false);
      await changed();
    },
    slackConcealKeys,
  );
  useEffect(() => () => controller.current?.abort(), []);
  const busy = command.state.kind === 'sending';
  const locked = disabled || command.locked || refresh.kind === 'loading';
  const blocked = source.conversations?.filter(conversation => conversation.state === 'unavailable') ?? [];
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
        if (error instanceof SlackKnowledgeError && [401, 403, 404].includes(error.status))
          await change({ kind: 'conceal', keys: slackConcealKeys });
        else await changed();
      }
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  const manage = (action: ManageSlack['action']) => {
    if (!locked) void command.send({ commandId: crypto.randomUUID(), action });
  };
  return (
    <li aria-label={source.title} className="space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <BrandIcon brand="slack" size="sm" />
        <div className="min-w-0 flex-1 basis-48">
          <h4 className="break-words text-base font-medium">{source.title}</h4>
          {source.selection && (
            <>
              <p className="text-sm text-muted-foreground">
                {source.selection.kind === 'personal' ? 'Direct and group messages' : 'Channels'} · messages after{' '}
                {source.selection.after} UTC
              </p>
              <p className="text-sm text-muted-foreground">
                {source.selection.kind === 'personal'
                  ? 'Private to the source owner'
                  : `${source.memberIds.length} selected ${source.memberIds.length === 1 ? 'member' : 'members'}, including the owner`}
              </p>
            </>
          )}
        </div>
        <Badge
          variant={
            source.syncState === 'failed' || blocked.length > 0 || (source.counts?.failed ?? 0) > 0
              ? 'warning'
              : 'secondary'
          }
        >
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
          {source.counts.ready} ready · {source.counts.failed} failed · {source.counts.total} threads discovered
        </p>
      )}
      {source.conversations && (
        <ul aria-label="Selected conversations" className="space-y-1 text-sm">
          {source.conversations.map(conversation => (
            <li key={conversation.conversationId} className="flex flex-wrap items-center gap-2">
              <span className="break-words">{conversation.title}</span>
              {conversation.state === 'unavailable' ? (
                <Badge variant="warning">Blocked</Badge>
              ) : (
                <Badge variant="secondary">Active</Badge>
              )}
              {conversation.failure && (
                <span className="w-full text-muted-foreground">
                  {conversationFailures[conversation.failure] ??
                    'Permissions for this conversation cannot be verified. Its messages stay hidden.'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(source.failure || (source.counts?.failed ?? 0) > 0) && (
        <Alert variant="destructive">
          <AlertDescription>
            {source.failure
              ? (sourceFailures[source.failure] ??
                'Source processing failed. Coverage may be incomplete. Check the Slack link, then retry the source.')
              : 'Some threads could not be imported. Coverage is incomplete.'}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        Sync readiness does not confirm your own Slack access. Search and evidence require a membership check through
        your own Slack link within the last five minutes.
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
            {(source.syncState === 'failed' || blocked.length > 0 || (source.counts?.failed ?? 0) > 0) && (
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
      {showDocuments && source.state === 'active' && <SlackSourceDocuments api={api} sourceId={source.sourceId} />}
      {showDocuments && source.state === 'active' && source.canManage && (
        <KnowledgeSourceFailures workspaceId={workspaceId} sourceId={source.sourceId} />
      )}
      {busy && <p role="status">Updating source…</p>}
      {refresh.kind === 'done' && (
        <p role="status" className="text-sm">
          Checked {refresh.refreshed + refresh.unavailable} conversations: {refresh.refreshed} confirmed,{' '}
          {refresh.unavailable} unavailable to you. Access stays valid for at most five minutes.
        </p>
      )}
      {refresh.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not refresh your access. No current authorization is confirmed. Check your Slack link and conversation
            membership, then retry.
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
            Remove this selection from Knowledge? Selected readers will lose access to its Knowledge content. The
            messages stay in Slack.
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

export function SlackKnowledgeSources({ workspaceId }: { workspaceId: string }) {
  const api = useMemo(() => slackKnowledgeApi(workspaceId), [workspaceId]);
  const { change } = useFeatureChanges();
  const [selecting, setSelecting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sources = useFeatureRead({
    key: [...slackSourceKeys, 'list'],
    load: api.list,
    staleTime: 0,
    pollWhile: data =>
      data.items.some(source => source.state === 'active' && ['queued', 'syncing'].includes(source.syncState)),
    maxChecks: 15,
  });
  const changed = async () => {
    await Promise.all([
      change({ keys: [[...slackSourceKeys, 'list']] }),
      change({ kind: 'conceal', keys: [[...slackSourceKeys, 'documents']] }),
    ]);
  };
  const visibleSources =
    sources.state.kind === 'ready' ? sources.state.data.items.filter(source => source.state !== 'removed') : [];
  const close = () => {
    setSelecting(false);
    heading.current?.focus();
  };
  return (
    <section aria-label="Slack knowledge sources" className="space-y-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 ref={heading} tabIndex={-1} className="text-base font-medium">
          Slack knowledge sources
        </h3>
        <Button
          variant="outline"
          disabled={selecting}
          onClick={() => {
            setSelecting(true);
            setSaved(null);
          }}
        >
          Select Slack conversations
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Make selected Slack conversations searchable as workspace knowledge. Import uses your own linked Slack account,
        and each reader must still be a member of a conversation in Slack to see it.
      </p>
      {saved && (
        <p role="status" className="text-sm">
          {saved} was saved. Import continues in the background when you leave this page.
        </p>
      )}
      {selecting && (
        <SlackSelectionForm
          api={api}
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
                Retry loading Slack sources
              </Button>
            </div>
          )}
          {!visibleSources.length ? (
            <StatePanel
              kind="empty"
              heading="h3"
              title="No Slack sources selected"
              description="Choose channels or your own direct messages to make their threads searchable."
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {visibleSources.map(source => (
                <SlackSourceRow
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
        <ReadResult state={sources.state} retry={sources.refresh} label="Slack sources">
          {() => null}
        </ReadResult>
      )}
      {sources.delayed && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            Slack import is taking longer. Automatic checks have paused; processing continues in the background.
          </p>
          <Button
            variant="outline"
            disabled={sources.state.kind === 'ready' && sources.state.refreshing}
            onClick={() => void sources.refresh()}
          >
            Check Slack imports again
          </Button>
        </div>
      )}
    </section>
  );
}
