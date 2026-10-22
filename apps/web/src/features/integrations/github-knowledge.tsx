import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardContent } from '@tulipfarm/sprout/card';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFlag } from '@/lib/feature-flags';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { useGitHubAccounts } from './queries';
import { GitHubSelectionForm } from './github-knowledge-selection';
import {
  GitHubKnowledgeError,
  githubConcealKeys,
  githubKnowledgeErrorMessages,
  githubKnowledgeApi,
  githubSourceKeys,
  type ManageGitHub,
  type GitHubDocument,
  type GitHubKnowledgeApi,
  type GitHubSource,
} from './github-knowledge-api';
import { CommandFeedback, ReadResult, useCommand, useExpired } from './slack-knowledge-shared';

const statusLabels = {
  queued: 'Queued for import',
  parsing: 'Reading item',
  ready: 'Searchable',
  failed: 'Import failed',
  'ocr-unavailable': 'Not searchable',
} as const;

const kindNames = {
  code: 'Code',
  docs: 'Docs',
  issues: 'Issues',
  pulls: 'Pull requests',
  discussions: 'Discussions',
} as const;
const syncLabels = { queued: 'Queued', syncing: 'Syncing', ready: 'Sync complete', failed: 'Sync failed' };
const repositoryFailures: Record<string, string> = {
  forbidden:
    'The source owner can no longer read this repository in GitHub. It may have been made private, transferred or deleted. Its content stays hidden; other repositories keep syncing.',
};
const sourceFailures: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(githubKnowledgeErrorMessages).map(([code, message]) => [code.replace(/^github-/, ''), message]),
  ),
  'not-linked': 'The source owner must reconnect the same GitHub account, then retry this source.',
  'invalid-cursor': 'GitHub changed the listing. The next sync starts a full reconciliation without deleting anything.',
  transient: 'GitHub was temporarily unavailable. The next sync retries automatically.',
};
const documentFailures: Record<string, string> = {
  'too-large': 'This item exceeds the 256 KB file, 500-comment or 1 MB limit and is not searchable.',
  unsupported: 'This file is not UTF-8 text and is not searchable.',
  'source-changed': 'The item changed during import. The next sync imports the latest version.',
  'resource-limited': 'This item exceeds the Knowledge limit.',
};

function OriginalDownload({ api, document }: { api: GitHubKnowledgeApi; document: GitHubDocument }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const controller = useRef<AbortController | null>(null);
  const noun = document.historical ? 'earlier version' : 'item';
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
          <AlertDescription>Could not download the {noun}. Refresh your GitHub access and try again.</AlertDescription>
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

function GitHubDocumentRow({
  api,
  document,
  refresh,
}: {
  api: GitHubKnowledgeApi;
  document: GitHubDocument;
  refresh: () => Promise<void>;
}) {
  const expired = useExpired(document.validUntil);
  if (expired)
    return (
      <li className="py-3">
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Item access check expired"
          description="Content is hidden. Refresh your GitHub access, then check items again."
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Check items again
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
          This item changed in GitHub. Knowledge has not imported the current version, so this download is the earlier
          version.
        </p>
      )}
      <OriginalDownload api={api} document={document} />
    </li>
  );
}

function GitHubSourceDocuments({ api, sourceId }: { api: GitHubKnowledgeApi; sourceId: string }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const read = useFeatureRead({
    key: [...githubSourceKeys, 'documents', sourceId, cursor],
    load: signal => api.documents(sourceId, cursor, signal),
    staleTime: 0,
    pollWhile: data => data.items.some(document => document.parsing === 'queued' || document.parsing === 'parsing'),
    maxChecks: 15,
  });
  return (
    <section aria-label="GitHub import details" className="space-y-3 border-t pt-3">
      <h5 className="text-sm font-medium">Import details</h5>
      <ReadResult state={read.state} retry={read.refresh} label="GitHub items">
        {data => (
          <>
            {!data.items.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No authorized items on this page"
                description="Import may still be running. Refresh your GitHub access to check which items you can read."
              />
            ) : (
              <ul className="divide-y">
                {data.items.map(document => (
                  <GitHubDocumentRow key={document.documentId} api={api} document={document} refresh={read.refresh} />
                ))}
              </ul>
            )}
            {(cursors.length > 1 || data.nextCursor) && (
              <nav aria-label="GitHub item pages" className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  Previous GitHub items
                </Button>
                <Button
                  variant="outline"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                  }}
                >
                  Next GitHub items
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
        Check GitHub items again
      </Button>
    </section>
  );
}

function GitHubSourceRow({
  api,
  source,
  disabled,
  changed,
  checkStatus,
}: {
  api: GitHubKnowledgeApi;
  source: GitHubSource;
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
  const command = useCommand<ManageGitHub, GitHubSource>(
    (input, signal) => api.manage(source.sourceId, input, signal),
    async () => {
      setConfirmRemove(false);
      await changed();
    },
    githubConcealKeys,
  );
  useEffect(() => () => controller.current?.abort(), []);
  const busy = command.state.kind === 'sending';
  const locked = disabled || command.locked || refresh.kind === 'loading';
  const blocked = source.repositories?.filter(repository => repository.state === 'unavailable') ?? [];
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
        if (error instanceof GitHubKnowledgeError && [401, 403, 404].includes(error.status))
          await change({ kind: 'conceal', keys: githubConcealKeys });
        else await changed();
      }
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  const manage = (action: ManageGitHub['action']) => {
    if (!locked) void command.send({ commandId: crypto.randomUUID(), action });
  };
  return (
    <li aria-label={source.title} className="space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <BrandIcon brand="github" size="sm" />
        <div className="min-w-0 flex-1 basis-48">
          <h4 className="break-words text-base font-medium">{source.title}</h4>
          {source.selection && (
            <>
              <p className="text-sm text-muted-foreground">
                {source.selection.kinds.map(kind => kindNames[kind]).join(', ')} · activity after{' '}
                {source.selection.after} UTC
              </p>
              <p className="text-sm text-muted-foreground">
                {source.memberIds.length} selected {source.memberIds.length === 1 ? 'member' : 'members'}, including the
                owner
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
          {source.counts.ready} ready · {source.counts.failed} failed · {source.counts.total} items discovered
        </p>
      )}
      {source.repositories && (
        <ul aria-label="Selected repositories" className="space-y-1 text-sm">
          {source.repositories.map(repository => (
            <li key={repository.repositoryId} className="flex flex-wrap items-center gap-2">
              <span className="break-all">{repository.fullName}</span>
              {repository.visibility !== 'public' && (
                <Badge variant="outline">{repository.visibility === 'private' ? 'Private' : 'Internal'}</Badge>
              )}
              {repository.state === 'unavailable' ? (
                <Badge variant="warning">Blocked</Badge>
              ) : (
                <Badge variant="secondary">Active</Badge>
              )}
              {repository.failure && (
                <span className="w-full text-muted-foreground">
                  {repositoryFailures[repository.failure] ??
                    'Permissions for this repository cannot be verified. Its content stays hidden.'}
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
                'Source processing failed. Coverage may be incomplete. Check the GitHub account, then retry the source.')
              : 'Some items could not be imported. Coverage is incomplete.'}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        Sync readiness does not confirm your own GitHub access. Search and evidence require a repository access check
        through your own connected GitHub account within the last five minutes.
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
      {showDocuments && source.state === 'active' && <GitHubSourceDocuments api={api} sourceId={source.sourceId} />}
      {busy && <p role="status">Updating source…</p>}
      {refresh.kind === 'done' && (
        <p role="status" className="text-sm">
          Checked {refresh.refreshed + refresh.unavailable} repositories: {refresh.refreshed} confirmed,{' '}
          {refresh.unavailable} unavailable to you. Access stays valid for at most five minutes.
        </p>
      )}
      {refresh.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not refresh your access. No current authorization is confirmed. Check your GitHub account and
            repository access, then retry.
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
            content stays in GitHub.
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

export function GitHubKnowledgeSources({
  workspaceId,
  onReconnect,
  accountBusy = false,
  footerTarget,
}: {
  workspaceId: string;
  onReconnect?: (id: string) => void;
  accountBusy?: boolean;
  footerTarget: HTMLElement | null;
}) {
  const api = useMemo(() => githubKnowledgeApi(workspaceId), [workspaceId]);
  const { change } = useFeatureChanges();
  const accounts = useGitHubAccounts(workspaceId);
  const automatic = useFlag('default-connection-knowledge');
  const [selecting, setSelecting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sources = useFeatureRead({
    key: [...githubSourceKeys, 'list'],
    load: api.list,
    staleTime: 0,
    pollWhile: data =>
      data.items.some(source => source.state === 'active' && ['queued', 'syncing'].includes(source.syncState)),
    maxChecks: 15,
  });
  const changed = async () => {
    await Promise.all([
      change({ keys: [[...githubSourceKeys, 'list']] }),
      change({ kind: 'conceal', keys: [[...githubSourceKeys, 'documents']] }),
    ]);
  };
  const visibleSources =
    sources.state.kind === 'ready' ? sources.state.data.items.filter(source => source.state !== 'removed') : [];
  const active =
    accounts.state.kind === 'ready' && !accounts.state.error
      ? accounts.state.data.accounts.filter(account => account.state === 'active' && account.identity)
      : [];
  const accountsChecked = accounts.state.kind === 'ready' && !accounts.state.error;
  const close = () => {
    setSelecting(false);
    heading.current?.focus();
  };
  return (
    <section aria-label="GitHub knowledge sources">
      <Card surface="raised">
        <CardContent>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 ref={heading} tabIndex={-1} className="text-lg font-medium text-foreground">
                {selecting ? 'Add repositories' : 'Repositories in Knowledge'}
              </h3>
              {!selecting && visibleSources.length > 0 && (
                <Button
                  disabled={!active.length}
                  onClick={() => {
                    setSelecting(true);
                    setSaved(null);
                  }}
                >
                  Add repositories
                </Button>
              )}
            </div>
            {!selecting && (
              <p className="max-w-prose text-sm text-muted-foreground">
                Import selected content so you can find it in Knowledge.{' '}
                {automatic
                  ? 'New GitHub integrations also import automatically; see Automatic Knowledge.'
                  : 'Connecting an account does not import anything automatically.'}
              </p>
            )}
            {accountsChecked && !active.length && (
              <p className="text-sm text-muted-foreground">Connect a GitHub account above to select repositories.</p>
            )}
            {saved && (
              <p role="status" className="text-sm">
                {saved} was saved. Import continues in the background when you leave this page.
              </p>
            )}
            {selecting && active.length > 0 && (
              <GitHubSelectionForm
                api={api}
                accounts={active}
                onReconnect={onReconnect}
                accountBusy={accountBusy}
                footerTarget={footerTarget}
                onClose={close}
                onSaved={async source => {
                  await changed();
                  setSaved(source.title);
                  close();
                }}
              />
            )}
            {sources.state.kind === 'ready' ? (
              <>
                {sources.state.error && (
                  <div className="space-y-2">
                    <Alert variant="destructive">
                      <AlertDescription>
                        Could not update source status. The last confirmed list is shown; management is paused until
                        status is checked.
                      </AlertDescription>
                    </Alert>
                    <Button
                      variant="outline"
                      disabled={sources.state.refreshing}
                      onClick={() => void sources.refresh()}
                    >
                      Retry loading GitHub sources
                    </Button>
                  </div>
                )}
                {sources.state.refreshing && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Checking GitHub source status…
                  </p>
                )}
                {!visibleSources.length ? (
                  !selecting &&
                  !sources.state.error && (
                    <div className="space-y-3 border-t border-foreground/10 pt-4">
                      <p className="text-sm font-medium text-foreground">No repositories imported yet</p>
                      <p className="text-sm text-muted-foreground">
                        Choose repositories, what to import, and who can see the content.
                      </p>
                      <Button
                        disabled={!active.length}
                        onClick={() => {
                          setSelecting(true);
                          setSaved(null);
                        }}
                      >
                        Add repositories
                      </Button>
                    </div>
                  )
                ) : (
                  <section aria-label="Existing imports" className="space-y-3">
                    {selecting && <h4 className="text-sm font-medium">Existing imports</h4>}
                    <ul className="divide-y rounded-lg border">
                      {visibleSources.map(source => (
                        <GitHubSourceRow
                          key={source.sourceId}
                          api={api}
                          source={source}
                          disabled={sources.state.kind !== 'ready' || !!sources.state.error || sources.state.refreshing}
                          changed={changed}
                          checkStatus={sources.refresh}
                        />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <ReadResult state={sources.state} retry={sources.refresh} label="GitHub sources">
                {() => null}
              </ReadResult>
            )}
            {sources.delayed && (
              <div className="space-y-2">
                <p role="status" className="text-sm text-muted-foreground">
                  GitHub import is taking longer. Automatic checks have paused; processing continues in the background.
                </p>
                <Button
                  variant="outline"
                  disabled={sources.state.kind === 'ready' && sources.state.refreshing}
                  onClick={() => void sources.refresh()}
                >
                  Check GitHub imports again
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
