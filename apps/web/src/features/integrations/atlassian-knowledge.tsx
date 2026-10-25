import { useEffect, useMemo, useRef, useState } from 'react';
import { EllipsisIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Progress, ProgressLabel } from '@tulipfarm/sprout/progress';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { AtlassianSelectionForm } from './atlassian-knowledge-selection';
import {
  AtlassianKnowledgeError,
  atlassianConcealKeys,
  atlassianErrorMessages,
  atlassianKnowledgeApi,
  atlassianSourceKeys,
  type AtlassianDocument,
  type AtlassianKnowledgeApi,
  type AtlassianProduct,
  type AtlassianSource,
  type ManageAtlassian,
} from './atlassian-knowledge-api';
import { CommandFeedback, ReadResult, useCommand, useExpired } from './slack-knowledge-shared';
import { KnowledgeSourceFailures } from './knowledge-source-failures';

const productNames = { confluence: 'Confluence', jira: 'Jira' } as const;
const itemNames = { confluence: ['page', 'pages'], jira: ['issue', 'issues'] } as const;
const statusLabels = {
  queued: 'Queued for import',
  parsing: 'Reading content',
  ready: 'Searchable',
  failed: 'Import failed',
  'ocr-unavailable': 'Not searchable',
} as const;
const syncLabels = { queued: 'Queued', syncing: 'Syncing', ready: 'Sync complete', failed: 'Sync failed' };
const targetKinds = { space: 'Space', page: 'Page', project: 'Project' } as const;
const targetFailures: Record<string, string> = {
  forbidden:
    'The source owner can no longer view this in Atlassian. Its content stays hidden; other selections keep syncing.',
  'not-found':
    'Atlassian no longer shows this to the source owner. It may have moved or been deleted. Other selections keep syncing.',
};
const sourceFailures: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(atlassianErrorMessages).map(([code, message]) => [code.replace(/^atlassian-/, ''), message]),
  ),
  'not-linked': 'The source owner must reconnect their Atlassian account, then retry this source.',
  'invalid-cursor':
    'Atlassian reset its listing. The next sync starts a full reconciliation without deleting anything.',
  transient: 'Atlassian was temporarily unavailable. The next sync retries automatically.',
};
const documentFailures: Record<string, string> = {
  'item-too-large': 'This item exceeds the 1 MB or 1,000-comment limit and is not searchable.',
  'source-changed': 'This item changed during import. The next sync imports the latest version.',
  'resource-limited': 'This item exceeds the Knowledge limit.',
  transient: 'Atlassian was temporarily unavailable for this item. The next sync retries it.',
};

function OriginalDownload({
  api,
  document,
  product,
}: {
  api: AtlassianKnowledgeApi;
  document: AtlassianDocument;
  product: AtlassianProduct;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const controller = useRef<AbortController | null>(null);
  const item = document.historical ? 'earlier version' : itemNames[product][0];
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
          <AlertDescription>
            Could not download the {item}. Refresh your Atlassian access and try again.
          </AlertDescription>
        </Alert>
      )}
      <Button
        variant="outline"
        disabled={state === 'loading'}
        aria-busy={state === 'loading'}
        onClick={() => void download()}
      >
        {state === 'loading'
          ? `Downloading ${item}…`
          : state === 'error'
            ? `Retry ${item} download`
            : `Download ${item}`}
      </Button>
    </div>
  );
}

function DocumentRow({
  api,
  document,
  product,
  refresh,
}: {
  api: AtlassianKnowledgeApi;
  document: AtlassianDocument;
  product: AtlassianProduct;
  refresh: () => Promise<void>;
}) {
  const expired = useExpired(document.validUntil);
  const [item, items] = itemNames[product];
  if (expired)
    return (
      <li className="py-3">
        <StatePanel
          kind="unavailable"
          heading="h3"
          title={`${item[0]?.toUpperCase()}${item.slice(1)} access check expired`}
          description={`Content is hidden. Refresh your Atlassian access, then check ${items} again.`}
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Check {items} again
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
          This {item} changed in {productNames[product]}. Knowledge has not imported the current version, so this
          download is the earlier version.
        </p>
      )}
      <OriginalDownload api={api} document={document} product={product} />
    </li>
  );
}

function SourceDocuments({
  api,
  sourceId,
  product,
}: {
  api: AtlassianKnowledgeApi;
  sourceId: string;
  product: AtlassianProduct;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const items = itemNames[product][1];
  const read = useFeatureRead({
    key: [...atlassianSourceKeys, 'documents', sourceId, cursor],
    load: signal => api.documents(sourceId, cursor, signal),
    staleTime: 0,
    pollWhile: data => data.items.some(document => document.parsing === 'queued' || document.parsing === 'parsing'),
    maxChecks: 15,
  });
  return (
    <section aria-label={`${productNames[product]} import details`} className="space-y-3 border-t pt-3">
      <h5 className="text-sm font-medium">Import details</h5>
      <ReadResult state={read.state} retry={read.refresh} label={`${productNames[product]} ${items}`}>
        {data => (
          <>
            {!data.items.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title={`No authorized ${items} on this page`}
                description={`Import may still be running. Refresh your Atlassian access to check which ${items} you can read.`}
              />
            ) : (
              <ul className="divide-y">
                {data.items.map(document => (
                  <DocumentRow
                    key={document.documentId}
                    api={api}
                    document={document}
                    product={product}
                    refresh={read.refresh}
                  />
                ))}
              </ul>
            )}
            {(cursors.length > 1 || data.nextCursor) && (
              <nav aria-label={`${productNames[product]} ${items} pages`} className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  Previous {items}
                </Button>
                <Button
                  variant="outline"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                  }}
                >
                  Next {items}
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
        Check {items} again
      </Button>
    </section>
  );
}

function SourceRow({
  workspaceId,
  api,
  source,
  disabled,
  changed,
  checkStatus,
}: {
  workspaceId: string;
  api: AtlassianKnowledgeApi;
  source: AtlassianSource;
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
  const command = useCommand<ManageAtlassian, AtlassianSource>(
    (input, signal) => api.manage(source.sourceId, input, signal),
    async () => {
      setConfirmRemove(false);
      await changed();
    },
    atlassianConcealKeys,
  );
  useEffect(() => () => controller.current?.abort(), []);
  const busy = command.state.kind === 'sending';
  const locked = disabled || command.locked || refresh.kind === 'loading';
  const blocked = source.targets?.filter(target => target.state === 'unavailable') ?? [];
  const items = itemNames[source.product][1];
  const attention = blocked.length > 0 || (source.counts?.failed ?? 0) > 0;
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
        if (error instanceof AtlassianKnowledgeError && [401, 403, 404].includes(error.status))
          await change({ kind: 'conceal', keys: atlassianConcealKeys });
        else await changed();
      }
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  const manage = (action: ManageAtlassian['action']) => {
    if (!locked) void command.send({ commandId: crypto.randomUUID(), action });
  };
  return (
    <li aria-label={source.title} className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <BrandIcon brand={source.product} size="sm" />
          <div className="min-w-0">
            <h4 className="break-words text-sm font-medium">{source.title}</h4>
            <p className="text-xs text-muted-foreground">
              {[
                source.targets
                  ?.map(
                    target =>
                      `${target.key ?? targetKinds[target.kind]}${target.descendants ? ' and child pages' : ''}`,
                  )
                  .join(', '),
                source.selection &&
                  (source.memberIds.length === 1
                    ? 'Only the owner can search'
                    : `${source.memberIds.length} people can search, including the owner`),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <div className="w-full sm:w-48">
          {source.counts && source.counts.total > 0 ? (
            <div>
              <Progress
                value={Math.floor((source.counts.ready / source.counts.total) * 100)}
                aria-label={`${source.title} ${items} ready`}
                getAriaValueText={() => `${source.counts?.ready} of ${source.counts?.total} ${items} ready`}
              >
                <ProgressLabel>
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {source.counts.ready.toLocaleString()} of {source.counts.total.toLocaleString()} {items}
                    {source.counts.failed > 0 && (
                      <span className="text-destructive"> · {source.counts.failed.toLocaleString()} failed</span>
                    )}
                  </span>
                </ProgressLabel>
              </Progress>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No {items} counted yet</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex sm:w-32 sm:justify-end">
            {source.state !== 'active' ? (
              <Badge variant="outline">
                {source.state === 'paused' ? 'Paused' : source.state === 'disconnected' ? 'Disconnected' : 'Removed'}
              </Badge>
            ) : (
              <Badge variant={source.syncState === 'failed' || attention ? 'warning' : 'secondary'}>
                {source.syncState === 'ready' && attention ? 'Needs attention' : syncLabels[source.syncState]}
              </Badge>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={showDocuments}
            disabled={disabled || source.state !== 'active'}
            onClick={() => setShowDocuments(value => !value)}
          >
            {showDocuments ? `Hide ${items}` : `View ${items}`}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`More actions for ${source.title}`}
                  disabled={locked && refresh.kind !== 'loading'}
                />
              }
            >
              <EllipsisIcon aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={locked || source.state !== 'active'} onClick={() => void refreshAccess()}>
                  {refresh.kind === 'error' ? 'Retry access refresh' : 'Refresh my access'}
                </DropdownMenuItem>
                {source.canManage && source.state === 'active' && (
                  <DropdownMenuItem disabled={locked} onClick={() => manage('pause')}>
                    Pause source
                  </DropdownMenuItem>
                )}
                {source.canManage && source.state === 'paused' && (
                  <DropdownMenuItem disabled={locked} onClick={() => manage('resume')}>
                    Resume source
                  </DropdownMenuItem>
                )}
                {source.canManage && (source.syncState === 'failed' || attention) && (
                  <DropdownMenuItem disabled={locked} onClick={() => manage('retry')}>
                    Retry source
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              {source.canManage && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" disabled={locked} onClick={() => setConfirmRemove(true)}>
                    Remove source
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {blocked.map(target => (
        <p key={`${target.kind}:${target.id}`} className="text-sm text-warning">
          {targetKinds[target.kind]} {target.key ?? target.title} is blocked.{' '}
          {target.failure
            ? (targetFailures[target.failure] ??
              'Permissions for this selection cannot be verified. Its content stays hidden.')
            : ''}
        </p>
      ))}
      {(source.failure || (source.counts?.failed ?? 0) > 0) && (
        <Alert variant="destructive">
          <AlertDescription>
            {source.failure
              ? (sourceFailures[source.failure] ??
                'Source processing failed. Coverage may be incomplete. Check the Atlassian account, then retry the source.')
              : `Some ${items} could not be imported. Coverage is incomplete.`}
          </AlertDescription>
        </Alert>
      )}
      {!source.canManage && (
        <p className="text-sm text-muted-foreground">Only the source owner can pause, resume, retry, or remove it.</p>
      )}
      {refresh.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing your access…
        </p>
      )}
      {showDocuments && source.state === 'active' && (
        <SourceDocuments api={api} sourceId={source.sourceId} product={source.product} />
      )}
      {showDocuments && source.state === 'active' && source.canManage && (
        <KnowledgeSourceFailures workspaceId={workspaceId} sourceId={source.sourceId} />
      )}
      {busy && <p role="status">Updating source…</p>}
      {refresh.kind === 'done' && (
        <p role="status" className="text-sm">
          Checked {refresh.refreshed + refresh.unavailable} {items}: {refresh.refreshed} confirmed,{' '}
          {refresh.unavailable} unavailable to you. Access stays valid for at most five minutes.
        </p>
      )}
      {refresh.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not refresh your access. No current authorization is confirmed. Check your Atlassian account, then
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
            Remove this selection from Knowledge? Selected readers will lose access to its Knowledge content. The
            content stays in {productNames[source.product]}.
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

export function AtlassianKnowledgeSources({
  workspaceId,
  product,
}: {
  workspaceId: string;
  product: AtlassianProduct;
}) {
  const api = useMemo(() => atlassianKnowledgeApi(workspaceId), [workspaceId]);
  const { change } = useFeatureChanges();
  const [selecting, setSelecting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const name = productNames[product];
  const sources = useFeatureRead({
    key: [...atlassianSourceKeys, 'list'],
    load: api.list,
    staleTime: 0,
    pollWhile: data =>
      data.items.some(source => source.state === 'active' && ['queued', 'syncing'].includes(source.syncState)),
    maxChecks: 15,
  });
  const changed = async () => {
    await Promise.all([
      change({ keys: [[...atlassianSourceKeys, 'list']] }),
      change({ kind: 'conceal', keys: [[...atlassianSourceKeys, 'documents']] }),
    ]);
  };
  const visibleSources =
    sources.state.kind === 'ready'
      ? sources.state.data.items.filter(source => source.state !== 'removed' && source.product === product)
      : [];
  const close = () => {
    setSelecting(false);
    heading.current?.focus();
  };
  return (
    <section aria-label={`${name} knowledge sources`} className="space-y-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 ref={heading} tabIndex={-1} className="text-base font-medium">
          {name} knowledge sources
        </h3>
        <Button
          variant="outline"
          disabled={selecting}
          onClick={() => {
            setSelecting(true);
            setSaved(null);
          }}
        >
          Select {name} content
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Make selected {product === 'jira' ? 'Jira projects' : 'Confluence spaces and pages'} searchable as workspace
        knowledge. Import uses your own Atlassian account, and each reader must still be able to view an{' '}
        {itemNames[product][0]} in {name} to see it. Search checks each {itemNames[product][0]} against your own
        Atlassian access, at most five minutes old, before showing it.
      </p>
      {saved && (
        <p role="status" className="text-sm">
          {saved} was saved. Import continues in the background when you leave this page.
        </p>
      )}
      {selecting && (
        <AtlassianSelectionForm
          api={api}
          product={product}
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
                Retry loading {name} sources
              </Button>
            </div>
          )}
          {sources.state.refreshing && (
            <p role="status" className="text-sm text-muted-foreground">
              Checking {name} source status…
            </p>
          )}
          {!visibleSources.length ? (
            <StatePanel
              kind="empty"
              heading="h3"
              title={`No ${name} sources selected`}
              description={
                product === 'jira'
                  ? 'Choose projects to make their issues searchable.'
                  : 'Choose spaces or pages to make them searchable.'
              }
            />
          ) : (
            <ul aria-label={`${name} sources`} className="divide-y rounded-lg border">
              {visibleSources.map(source => (
                <SourceRow
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
        <ReadResult state={sources.state} retry={sources.refresh} label={`${name} sources`}>
          {() => null}
        </ReadResult>
      )}
      {sources.delayed && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {name} import is taking longer. Automatic checks have paused; processing continues in the background.
          </p>
          <Button
            variant="outline"
            disabled={sources.state.kind === 'ready' && sources.state.refreshing}
            onClick={() => void sources.refresh()}
          >
            Check {name} imports again
          </Button>
        </div>
      )}
    </section>
  );
}
