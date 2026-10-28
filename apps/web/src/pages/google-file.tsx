import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { ChevronLeft } from 'reicon-react/icons/ChevronLeft';
import { Copy } from 'reicon-react/icons/Copy';
import { Download } from 'reicon-react/icons/Download';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Refresh } from 'reicon-react/icons/Refresh';
import { googleFileRoute, workspaceRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { FileContent, LoadingFile } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { FilesSearch } from '@/features/files/api';
import {
  googleFileKeys,
  googleOwner,
  googleType,
  googleWebLink,
  outcome,
  readTime,
  useDriveAccess,
  useGoogleFilesApi,
  useGoogleFetch,
  useRefetch,
  type DriveAccess,
  type GoogleFilesSearch,
} from '@/features/files/google-api';
import { canCopy, SaveCopyDialog } from '@/features/files/google-copy';
import { GoogleBusyPanel, GoogleRecoveryPanel } from '@/features/files/google-recovery';
import { GoogleSheet } from '@/features/files/google-sheet';
import { UseGoogleFileInChatDialog } from '@/features/files/use-in-chat';
import { googleReadable } from '@/features/chat/file-mentions';
import { formatFileSize, renderableType } from '@/lib/file-viewer';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import { useIsMobile } from '@/hooks/use-mobile';
import { loadView, unreadable } from '@/features/google/file-view';

const modified = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
type Search = FilesSearch & GoogleFilesSearch;
type Ready = Extract<DriveAccess, { kind: 'ready' }>;

export function GoogleFilePage() {
  const scope = useFeatureScope();
  const { fileId } = googleFileRoute.useParams();
  const search = googleFileRoute.useSearch();
  if (scope.kind !== 'workspace') return null;
  return (
    <Viewer
      key={`${scope.membershipId}:${fileId}`}
      workspaceId={scope.workspaceId}
      membershipId={scope.membershipId}
      fileId={fileId}
      search={search}
    />
  );
}

function Viewer({
  workspaceId,
  membershipId,
  fileId,
  search,
}: {
  workspaceId: string;
  membershipId: string;
  fileId: string;
  search: Search;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const drive = useDriveAccess(workspaceId);
  const { access } = drive;
  const back = <Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={{ ...search, section: 'google' }} />;
  const backLink = (
    <Button variant="ghost" size="sm" nativeButton={false} role="link" render={back}>
      <ChevronLeft size={16} aria-hidden="true" />
      Google Drive
    </Button>
  );
  if (access.kind === 'loading')
    return (
      <Page>
        {backLink}
        <StatePanel
          kind="loading"
          heading="h1"
          title="Opening Google file"
          description="Checking your Google integration."
        />
      </Page>
    );
  if (access.kind !== 'ready')
    return (
      <Page>
        {backLink}
        <GoogleRecoveryPanel
          heading="h1"
          recovery={access.kind === 'grant' ? { kind: 'grant', app: 'drive', email: access.email } : access}
          connect={drive.connect}
          retry={drive.refresh}
        />
      </Page>
    );
  const { binding } = access;
  return (
    <Opened
      key={`${binding.integrationId}:${binding.accountId}:${binding.generation}`}
      workspaceId={workspaceId}
      membershipId={membershipId}
      fileId={fileId}
      access={access}
      drive={drive}
      back={back}
      backLink={backLink}
    />
  );
}

function Opened({
  workspaceId,
  membershipId,
  fileId,
  access,
  drive,
  back,
  backLink,
}: {
  workspaceId: string;
  membershipId: string;
  fileId: string;
  access: Ready;
  drive: ReturnType<typeof useDriveAccess>;
  back: ReactElement;
  backLink: ReactNode;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const { binding } = access;
  const api = useGoogleFilesApi(workspaceId, binding, access.scopes);
  const key = googleFileKeys.item(binding, fileId);
  const load = (signal: AbortSignal) => outcome(() => loadView(api, access.scopes, fileId, signal));
  const read = useFeatureRead({ key, staleTime: 0, load });
  const refetch = useRefetch();
  const fetchNow = useGoogleFetch();
  const [refreshing, setRefreshing] = useState(false);
  const [download, setDownload] = useState<'idle' | 'sending' | 'failed'>('idle');
  const saving = useRef(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const [copying, setCopying] = useState(false);
  const chatButton = useRef<HTMLButtonElement>(null);
  const [chatting, setChatting] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const narrow = useIsMobile();
  const data = read.state.kind === 'ready' ? read.state.data : null;
  const block = data?.kind === 'blocked' ? data.block : null;
  useEffect(() => {
    if (block === 'reconnect' || block === 'grant') void drive.refresh();
  }, [block]);
  const binary = data?.kind === 'ok' && data.value.view.kind === 'binary' ? data.value.view : null;
  const [rendered, setRendered] = useState<{ source: typeof binary; url: string } | null>(null);
  useEffect(() => {
    if (!binary) {
      setRendered(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([binary.bytes], { type: renderableType(binary.filename, binary.mediaType) }),
    );
    setRendered({ source: binary, url });
    return () => URL.revokeObjectURL(url);
  }, [binary]);
  const url = rendered?.source === binary ? rendered.url : null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refetch(key);
    } finally {
      setRefreshing(false);
    }
  };
  async function save() {
    if (saving.current) return;
    saving.current = true;
    setDownload('sending');
    try {
      const current = await fetchNow({ key, staleTime: 0, load });
      if (current.kind === 'ok' && current.value.view.kind === 'binary') {
        const { bytes, filename } = current.value.view;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
      setDownload('idle');
    } catch {
      setDownload('failed');
    } finally {
      saving.current = false;
    }
  }

  const retry = (label: string) => (
    <Button variant="outline" disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()}>
      {refreshing ? 'Checking…' : label}
    </Button>
  );
  const backButton = (
    <Button variant="outline" nativeButton={false} role="link" render={back}>
      Back to Google Drive
    </Button>
  );
  if (read.state.kind === 'loading')
    return (
      <Page>
        {backLink}
        <StatePanel
          kind="loading"
          heading="h1"
          title="Opening Google file"
          description="Reading it from Google Drive."
        />
      </Page>
    );
  if (read.state.kind === 'unavailable')
    return (
      <Page>
        {backLink}
        <GoogleRecoveryPanel
          heading="h1"
          recovery={{ kind: 'unavailable' }}
          connect={drive.connect}
          retry={drive.refresh}
        />
      </Page>
    );
  if (read.state.kind === 'error' && read.state.busy)
    return (
      <Page>
        {backLink}
        <GoogleBusyPanel heading="h1">{retry('Try again')}</GoogleBusyPanel>
      </Page>
    );
  if (read.state.kind === 'error')
    return (
      <Page>
        {backLink}
        <StatePanel
          kind="error"
          heading="h1"
          title="Couldn’t open this Google file"
          description="Google didn’t respond, or the request timed out. The file in Google is unchanged."
        >
          {retry('Retry opening file')}
        </StatePanel>
      </Page>
    );
  const result = read.state.data;
  if (result.kind === 'blocked') {
    switch (result.block) {
      case 'reconnect':
        return (
          <Page>
            {backLink}
            <GoogleRecoveryPanel
              heading="h1"
              recovery={{ kind: 'reconnect', email: access.email }}
              connect={drive.connect}
              retry={drive.refresh}
            />
          </Page>
        );
      case 'grant':
        return (
          <Page>
            {backLink}
            <GoogleRecoveryPanel
              heading="h1"
              recovery={{ kind: 'grant', app: 'drive', email: access.email }}
              connect={drive.connect}
              retry={drive.refresh}
            />
          </Page>
        );
      case 'not-found':
        return (
          <Page>
            {backLink}
            <StatePanel
              kind="unavailable"
              heading="h1"
              title="This Google file isn’t available"
              description="It may have been deleted, moved to trash, or unshared in Google."
            >
              {backButton}
              {retry('Check again')}
            </StatePanel>
          </Page>
        );
      case 'denied':
        return (
          <Page>
            {backLink}
            <StatePanel
              kind="unavailable"
              heading="h1"
              title="Google denied access to this file"
              description="Ask its owner in Google for access. Its details stay hidden."
            >
              {backButton}
              {retry('Check access again')}
            </StatePanel>
          </Page>
        );
      default:
        return (
          <Page>
            {backLink}
            <StatePanel
              kind="error"
              heading="h1"
              title="Couldn’t open this Google file"
              description="Google rejected the request. The file in Google is unchanged."
            >
              {retry('Retry opening file')}
            </StatePanel>
          </Page>
        );
    }
  }
  const { file, view } = result.value;
  const type = googleType(file);
  const web = googleWebLink(file.webViewLink);
  const sending = download === 'sending';
  const openInGoogle = (variant: 'default' | 'outline') =>
    web && (
      <Button
        variant={variant}
        nativeButton={false}
        role="link"
        render={<a href={web} target="_blank" rel="noopener noreferrer" />}
      >
        <ArrowUpRight size={16} aria-hidden="true" />
        Open in Google
      </Button>
    );
  const description = [
    type.label,
    googleOwner(file) === 'You' ? 'Owned by you' : googleOwner(file),
    file.size && type.view === 'blob' ? formatFileSize(Number(file.size)) : null,
    file.modifiedTime ? `Modified ${modified.format(new Date(file.modifiedTime))}` : null,
    `Read from Google at ${readTime(result.readAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const labels = {
    refresh: refreshing ? 'Refreshing…' : 'Refresh',
    download: sending ? 'Downloading…' : type.view === 'pdf' ? 'Download PDF' : 'Download',
  };
  const actions = narrow ? (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button ref={menuButton} variant="outline" size="icon" aria-label="File actions" />}>
        <MoreH size={16} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" size="menu">
        {googleReadable(file) && (
          <DropdownMenuItem onClick={() => setChatting(true)}>
            <ChatRound size={14} aria-hidden="true" />
            Use in chat
          </DropdownMenuItem>
        )}
        {binary && (
          <DropdownMenuItem disabled={sending} onClick={() => void save()}>
            <Download size={14} aria-hidden="true" />
            {labels.download}
          </DropdownMenuItem>
        )}
        {canCopy(file) && (
          <DropdownMenuItem onClick={() => setCopying(true)}>
            <Copy size={14} aria-hidden="true" />
            Save a copy
          </DropdownMenuItem>
        )}
        {view.kind !== 'details' && web && (
          <DropdownMenuItem render={<a href={web} target="_blank" rel="noopener noreferrer" />}>
            <ArrowUpRight size={14} aria-hidden="true" />
            Open in Google
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={refreshing} onClick={() => void refresh()}>
          <Refresh size={14} aria-hidden="true" />
          {labels.refresh}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <>
      <Button variant="outline" disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()}>
        {labels.refresh}
      </Button>
      {binary && (
        <Button variant="outline" disabled={sending} aria-busy={sending} onClick={() => void save()}>
          <Download size={16} aria-hidden="true" />
          {labels.download}
        </Button>
      )}
      {googleReadable(file) && (
        <Button ref={chatButton} onClick={() => setChatting(true)}>
          <ChatRound size={16} aria-hidden="true" />
          Use in chat
        </Button>
      )}
      {canCopy(file) && (
        <Button ref={copyButton} variant="outline" onClick={() => setCopying(true)}>
          <Copy size={16} aria-hidden="true" />
          Save a copy
        </Button>
      )}
      {view.kind !== 'details' && openInGoogle('outline')}
    </>
  );
  return (
    <Page>
      {backLink}
      <PageHeader title={file.name} description={description} actions={actions} />
      {chatting && (
        <UseGoogleFileInChatDialog
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          membershipId={membershipId}
          file={file}
          binding={binding}
          finalFocus={() => (narrow ? menuButton.current : chatButton.current)}
          onClose={() => setChatting(false)}
        />
      )}
      {copying && (
        <SaveCopyDialog
          workspaceId={workspaceId}
          api={api}
          file={file}
          finalFocus={narrow ? menuButton : copyButton}
          onClose={() => setCopying(false)}
        />
      )}
      {read.state.error && (
        <Alert variant="destructive">
          <AlertDescription>
            Couldn’t refresh from Google. The copy read at {readTime(result.readAt)} is still shown.
          </AlertDescription>
        </Alert>
      )}
      {download === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>The download didn’t finish. Select Download to try again.</AlertDescription>
        </Alert>
      )}
      {view.kind === 'binary' ? (
        <section
          aria-label="File content"
          className="flex h-160 max-h-svh min-h-96 flex-col overflow-hidden rounded-xl border bg-muted/40"
        >
          {url ? (
            <FileContent
              name={view.filename}
              mediaType={view.mediaType}
              bytes={view.bytes}
              url={url}
              onRetry={() => void refresh()}
              renderers={fileRenderers}
            />
          ) : (
            <LoadingFile />
          )}
        </section>
      ) : view.kind === 'sheet' ? (
        <section
          aria-label="Sheet content"
          className="flex h-160 max-h-svh min-h-96 flex-col overflow-hidden rounded-xl border bg-muted/40"
        >
          <GoogleSheet
            api={api}
            binding={binding}
            fileId={file.id}
            tabs={view.tabs}
            connect={drive.connect}
            refreshIntegration={drive.refresh}
          />
        </section>
      ) : view.kind === 'grant-sheets' ? (
        <GoogleRecoveryPanel
          recovery={{ kind: 'grant', app: 'sheets', email: access.email }}
          connect={drive.connect}
          retry={drive.refresh}
        />
      ) : view.kind === 'folder' ? (
        <StatePanel
          kind="unavailable"
          title="This link opens a Google folder"
          description="Folders open in the Google Drive list."
        >
          <Button
            variant="outline"
            nativeButton={false}
            role="link"
            render={
              <Link
                to="/$workspaceSlug/files"
                params={{ workspaceSlug }}
                search={{ section: 'google', drive: file.id }}
              />
            }
          >
            Open folder
          </Button>
        </StatePanel>
      ) : (
        <StatePanel kind="unavailable" title={unreadable[view.reason][0]} description={unreadable[view.reason][1]}>
          {openInGoogle('default') || backButton}
        </StatePanel>
      )}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <PageContent>{children}</PageContent>;
}
