import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'reicon-react/icons/ChevronLeft';
import { Download } from 'reicon-react/icons/Download';
import { InfoCircle } from 'reicon-react/icons/InfoCircle';
import { Link as LinkIcon } from 'reicon-react/icons/Link';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Share } from 'reicon-react/icons/Share';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { Book } from 'reicon-react/icons/Book';
import { Briefcase } from 'reicon-react/icons/Briefcase';
import { fileRoute, workspaceRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { FileContent, FileError, LoadingFile } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { fileKeys, useFilesApi, useFilesChanges, type FileSummary, type ViewerSearch } from '@/features/files/api';
import { DetailsDialog } from '@/features/files/details';
import { GenerationDetails } from '@/features/files/generation';
import { useFlag } from '@/lib/feature-flags';
import { copyLink, SharingDialog } from '@/features/files/sharing';
import { UseInChatDialog } from '@/features/files/use-in-chat';
import { AddToKnowledgeDialog } from '@/features/files/add-to-knowledge';
import { AddToProjectDialog } from '@/features/files/add-to-project';
import { formatFileSize, renderableType } from '@/lib/file-viewer';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import { useIsMobile } from '@/hooks/use-mobile';
import { deniedStatus } from '@/lib/query/policy';

type Content = { kind: 'loading' } | { kind: 'ready'; bytes: ArrayBuffer; url: string } | { kind: 'failed' };
type Download = { kind: 'idle' } | { kind: 'sending' } | { kind: 'failed' };

export function FilePage() {
  const scope = useFeatureScope();
  const { fileId } = fileRoute.useParams();
  const search = fileRoute.useSearch();
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
  search: ViewerSearch;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const api = useFilesApi(workspaceId);
  const { concealed } = useFilesChanges();
  const read = useFeatureRead({ key: fileKeys.item(fileId), staleTime: 0, load: signal => api.read(fileId, signal) });
  const [denied, setDenied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<Content>({ kind: 'loading' });
  const [recentUse, setRecentUse] = useState<'idle' | 'recording' | 'done' | 'failed'>('idle');
  const [download, setDownload] = useState<Download>({ kind: 'idle' });
  const saving = useRef<AbortController | null>(null);
  const [dialog, setDialog] = useState<'details' | 'share' | 'chat' | 'knowledge' | 'project' | null>(null);
  const [copied, setCopied] = useState<Awaited<ReturnType<typeof copyLink>>>(null);
  const narrow = useIsMobile();
  const images = useFlag('images');
  const file = read.state.kind === 'ready' && !denied ? read.state.data : null;
  const deny = () => {
    saving.current?.abort();
    setDenied(true);
    setContent({ kind: 'loading' });
    void concealed();
  };
  useEffect(() => () => saving.current?.abort(), []);
  useEffect(() => {
    if (!file || file.kind !== 'file') return;
    const controller = new AbortController();
    let url: string | undefined;
    setContent({ kind: 'loading' });
    api.content(file.id, controller.signal).then(
      bytes => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: renderableType(file.name, file.mediaType ?? '') }));
        setContent({ kind: 'ready', bytes, url });
        setRecentUse('recording');
        void api.recordRecentUse(file.id).then(
          () => setRecentUse('done'),
          () => setRecentUse('failed'),
        );
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (deniedStatus(error) !== undefined) deny();
        else setContent({ kind: 'failed' });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file?.id, file?.name, file?.mediaType, attempt]);

  async function save(item: FileSummary) {
    if (saving.current) return;
    const controller = new AbortController();
    saving.current = controller;
    setDownload({ kind: 'sending' });
    try {
      const current = await api.read(item.id, controller.signal);
      const bytes = await api.content(item.id, controller.signal);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = current.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownload({ kind: 'idle' });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (deniedStatus(error) !== undefined) deny();
      else setDownload({ kind: 'failed' });
    } finally {
      if (saving.current === controller) saving.current = null;
    }
  }

  const back = <Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={search} />;
  const backLink = (
    <Button variant="ghost" size="sm" nativeButton={false} role="link" render={back}>
      <ChevronLeft size={16} aria-hidden="true" />
      Files
    </Button>
  );
  if (denied || read.state.kind === 'unavailable')
    return (
      <Page>
        {backLink}
        <StatePanel
          kind="unavailable"
          heading="h1"
          title="You can’t open this file"
          description="It may have been moved to Trash, or your access changed. Ask the person who shared it for access."
        >
          <Button variant="outline" nativeButton={false} role="link" render={back}>
            Back to Files
          </Button>
        </StatePanel>
      </Page>
    );
  if (read.state.kind === 'loading')
    return (
      <Page>
        {backLink}
        <StatePanel kind="loading" heading="h1" title="Opening file" description="Checking your access to this file." />
      </Page>
    );
  if (read.state.kind === 'error')
    return (
      <Page>
        {backLink}
        <StatePanel
          kind="error"
          heading="h1"
          title="Couldn’t open this file"
          description="The file details could not be loaded. Check your connection and try again."
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry opening file
          </Button>
        </StatePanel>
      </Page>
    );
  const item = read.state.data;
  if (item.kind === 'folder')
    return (
      <Page>
        {backLink}
        <PageHeader title={item.name} />
        <StatePanel kind="unavailable" title="This link opens a folder" description="Folders open in the Files list.">
          <Button
            variant="outline"
            nativeButton={false}
            role="link"
            render={<Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={{ folder: item.id }} />}
          >
            Open folder
          </Button>
        </StatePanel>
      </Page>
    );
  const owner = item.creatorMembershipId === membershipId ? 'Owned by you' : 'Shared with you';
  const sending = download.kind === 'sending';
  const downloadLabel = sending ? 'Downloading…' : 'Download';
  return (
    <Page>
      {backLink}
      <PageHeader
        title={item.name}
        description={[item.size === null ? null : formatFileSize(item.size), owner].filter(Boolean).join(' · ')}
        actions={
          <>
            {!narrow && (
              <>
                <Button onClick={() => setDialog('chat')}>
                  <ChatRound size={16} aria-hidden="true" />
                  Use in chat
                </Button>
                <Button variant="outline" disabled={sending} aria-busy={sending} onClick={() => void save(item)}>
                  <Download size={16} aria-hidden="true" />
                  {downloadLabel}
                </Button>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="icon" aria-label={narrow ? 'File actions' : 'More file actions'} />
                }
              >
                <MoreH size={16} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" size="menu">
                {narrow && (
                  <>
                    <DropdownMenuItem onClick={() => setDialog('chat')}>
                      <ChatRound size={14} aria-hidden="true" />
                      Use in chat
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={sending} onClick={() => void save(item)}>
                      <Download size={14} aria-hidden="true" />
                      {downloadLabel}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onClick={() => setDialog('knowledge')}>
                  <Book size={14} aria-hidden="true" />
                  Add to Knowledge
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog('project')}>
                  <Briefcase size={14} aria-hidden="true" />
                  Add to project
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog('details')}>
                  <InfoCircle size={14} aria-hidden="true" />
                  Details
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void copyLink(workspaceSlug, item).then(setCopied)}>
                  <LinkIcon size={14} aria-hidden="true" />
                  Copy link
                </DropdownMenuItem>
                {item.role === 'manager' && (
                  <DropdownMenuItem onClick={() => setDialog('share')}>
                    <Share size={14} aria-hidden="true" />
                    Share
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {copied?.kind === 'done' && (
        <p role="status" className="text-sm text-foreground">
          {copied.text}
        </p>
      )}
      {copied?.kind === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>
            <span className="wrap-anywhere">{copied.text}</span>
          </AlertDescription>
        </Alert>
      )}
      {dialog === 'details' && (
        <DetailsDialog
          api={api}
          item={item}
          membershipId={membershipId}
          share={() => setDialog('share')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'knowledge' && (
        <AddToKnowledgeDialog workspaceId={workspaceId} items={[item]} onClose={() => setDialog(null)} />
      )}
      {dialog === 'project' && (
        <AddToProjectDialog
          api={api}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          membershipId={membershipId}
          items={[item]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'chat' && (
        <UseInChatDialog
          api={api}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          membershipId={membershipId}
          items={[item]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'share' && (
        <SharingDialog
          api={api}
          item={item}
          membershipId={membershipId}
          workspaceSlug={workspaceSlug}
          onClose={() => setDialog(null)}
        />
      )}
      {download.kind === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>The download didn’t finish. Select Download to try again.</AlertDescription>
        </Alert>
      )}
      {recentUse === 'failed' && (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AlertDescription>The file opened, but it couldn’t be added to your recent files.</AlertDescription>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRecentUse('recording');
                void api.recordRecentUse(item.id).then(
                  () => setRecentUse('done'),
                  () => setRecentUse('failed'),
                );
              }}
            >
              Retry recent file
            </Button>
          </div>
        </Alert>
      )}
      <section
        aria-label="File content"
        className="flex h-160 max-h-svh min-h-96 flex-col overflow-hidden rounded-xl border bg-muted/40"
      >
        {content.kind === 'loading' ? (
          <LoadingFile />
        ) : content.kind === 'failed' ? (
          <FileError
            message="The file content couldn’t be loaded. Your file is unchanged."
            onRetry={() => setAttempt(value => value + 1)}
          />
        ) : (
          <FileContent
            name={item.name}
            mediaType={item.mediaType ?? 'application/octet-stream'}
            bytes={content.bytes}
            url={content.url}
            onRetry={() => setAttempt(value => value + 1)}
            renderers={fileRenderers}
          />
        )}
      </section>
      {images && <GenerationDetails api={api} fileId={item.id} workspaceSlug={workspaceSlug} />}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <PageContent>{children}</PageContent>;
}
