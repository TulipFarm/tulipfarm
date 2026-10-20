import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { Copy } from 'reicon-react/icons/Copy';
import { Files } from 'reicon-react/icons/Files';
import { Folder } from 'reicon-react/icons/Folder';
import { MoreH } from 'reicon-react/icons/MoreH';
import { filesRoute, workspaceRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@tulipfarm/sprout/breadcrumb';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import { googleReadable } from '@/features/chat/file-mentions';
import { UseGoogleFileInChatDialog } from './use-in-chat';
import {
  googleBlock,
  googleFileKeys,
  googleOwner,
  googleType,
  outcome,
  readTime,
  useDriveAccess,
  useGoogleFilesApi,
  useRefetch,
  type DriveAccess,
  type GoogleFileMetadata,
  type GoogleFilesApi,
  type ListQuery,
} from './google-api';
import { canCopy, SaveCopyDialog } from './google-copy';
import { GoogleBusyPanel, GoogleRecoveryPanel } from './google-recovery';

type Ready = Extract<DriveAccess, { kind: 'ready' }>;
type Drive = ReturnType<typeof useDriveAccess>;
const modified = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function GoogleDrive({ workspaceId, scope }: { workspaceId: string; scope: ReactNode }) {
  const drive = useDriveAccess(workspaceId);
  const { access } = drive;
  if (access.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        title="Checking your Google integration"
        description="Your Drive files load after Google confirms your integration."
      />
    );
  if (access.kind !== 'ready')
    return (
      <GoogleRecoveryPanel
        recovery={access.kind === 'grant' ? { kind: 'grant', app: 'drive', email: access.email } : access}
        connect={drive.connect}
        retry={drive.refresh}
      />
    );
  const { binding } = access;
  return (
    <Browser
      key={`${binding.integrationId}:${binding.accountId}:${binding.generation}`}
      workspaceId={workspaceId}
      access={access}
      drive={drive}
      scope={scope}
    />
  );
}

async function loadTrail(api: GoogleFilesApi, folderId: string, signal: AbortSignal) {
  const crumbs: { id: string; name: string }[] = [];
  try {
    const [root, current] = await Promise.all([api.metadata('root', signal), api.metadata(folderId, signal)]);
    for (
      let folder = current;
      folder.id !== root.id;
      folder = await api.metadata(folder.parents?.[0] ?? root.id, signal)
    ) {
      crumbs.unshift({ id: folder.id, name: folder.name });
      const parent = folder.parents?.[0];
      if (!parent || parent === root.id) break;
      if (crumbs.length >= 8) return { crumbs, hidden: 'truncated' as const };
    }
    return { crumbs, hidden: null };
  } catch (error) {
    if (googleBlock(error)) return { crumbs, hidden: 'restricted' as const };
    throw error;
  }
}

function Browser({
  workspaceId,
  access,
  drive,
  scope,
}: {
  workspaceId: string;
  access: Ready;
  drive: Drive;
  scope: ReactNode;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const search = filesRoute.useSearch();
  const navigate = filesRoute.useNavigate();
  const { binding } = access;
  const api = useGoogleFilesApi(workspaceId, binding, access.scopes);
  const refetch = useRefetch();
  const name = search.q ?? '';
  const folder = !name ? search.drive : undefined;
  const shared = !name && !folder && search.shared === true;
  const query: ListQuery = {
    ...(name ? { name } : folder ? { parentId: folder } : shared ? { sharedWithMe: true } : { parentId: 'root' }),
    ...(search.after ? { pageToken: search.after } : {}),
  };
  const list = useFeatureRead({
    key: googleFileKeys.list(binding, query),
    staleTime: 0,
    load: signal => outcome(() => api.list(query, signal)),
  });
  const trail = useFeatureRead({
    key: googleFileKeys.trail(binding, folder ?? 'root'),
    enabled: folder !== undefined,
    staleTime: 60_000,
    load: signal => loadTrail(api, folder ?? 'root', signal),
  });
  const [draft, setDraft] = useState(name);
  const [retrying, setRetrying] = useState(false);
  const block = list.state.kind === 'ready' && list.state.data.kind === 'blocked' ? list.state.data.block : null;
  useEffect(() => {
    if (block === 'reconnect' || block === 'grant') void drive.refresh();
  }, [block]);
  useEffect(() => {
    setDraft(name);
  }, [name]);
  useEffect(() => {
    if (draft === name) return;
    const timer = setTimeout(
      () => void navigate({ search: { section: 'google', ...(draft ? { q: draft } : {}) }, replace: true }),
      250,
    );
    return () => clearTimeout(timer);
  }, [draft]);

  const to = (next: { drive?: string; shared?: true }) => (
    <Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={{ section: 'google', ...next }} />
  );
  const again = async () => {
    setRetrying(true);
    try {
      await refetch(googleFileKeys.all(binding));
    } finally {
      setRetrying(false);
    }
  };
  const retry = (label: string) => (
    <Button variant="outline" disabled={retrying} aria-busy={retrying} onClick={() => void again()}>
      {retrying ? 'Checking…' : label}
    </Button>
  );
  const back = (
    <Button variant="outline" nativeButton={false} role="link" render={to({})}>
      Back to Google Drive
    </Button>
  );
  const atRoot = !name && !folder && !search.after;
  const page = list.state.kind === 'ready' && list.state.data.kind === 'ok' ? list.state.data : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumb aria-label="Folder path">
          <BreadcrumbList>
            <BreadcrumbItem>
              {atRoot && !shared ? (
                <BreadcrumbPage>Google Drive</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={to({})}>Google Drive</BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {name ? (
              <Crumb name="Search results" />
            ) : shared ? (
              <Crumb name="Shared with me" link={search.after ? to({ shared: true }) : undefined} />
            ) : (
              folder &&
              (trail.state.kind === 'ready' ? (
                <>
                  {trail.state.data.hidden && (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbEllipsis />
                        <span className="sr-only">
                          {trail.state.data.hidden === 'truncated'
                            ? 'Higher folders not shown'
                            : 'Folders you can’t open'}
                        </span>
                      </BreadcrumbItem>
                    </>
                  )}
                  {trail.state.data.crumbs.map((crumb, index, all) => (
                    <Crumb
                      key={crumb.id}
                      name={crumb.name}
                      link={index < all.length - 1 || search.after ? to({ drive: crumb.id }) : undefined}
                    />
                  ))}
                </>
              ) : (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbEllipsis />
                    <span className="sr-only">
                      {trail.state.kind === 'loading' ? 'Loading folder path' : 'Folder path unavailable'}
                    </span>
                  </BreadcrumbItem>
                </>
              ))
            )}
          </BreadcrumbList>
        </Breadcrumb>
        <SearchField label="Search Google Drive" value={draft} maxLength={500} onChange={setDraft} />
      </div>
      {scope}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <p className="flex min-w-0 items-center gap-2">
          <BrandIcon brand="google-drive" size="inline" />
          <span className="min-w-0 truncate">
            Live from Google Drive · <span className="text-foreground">{access.email}</span>
          </span>
        </p>
        {page && <p>Read at {readTime(page.readAt)}</p>}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={retrying} aria-busy={retrying} onClick={() => void again()}>
            {retrying ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            role="link"
            render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug }} hash="google-drive" />}
          >
            Manage integration
          </Button>
        </div>
      </div>
      {atRoot && (
        <nav aria-label="Google Drive locations" className="flex flex-wrap gap-1">
          <Button
            variant={shared ? 'ghost' : 'secondary'}
            size="sm"
            nativeButton={false}
            role="link"
            render={
              <Link
                to="/$workspaceSlug/files"
                params={{ workspaceSlug }}
                search={{ section: 'google' }}
                aria-current={shared ? undefined : 'page'}
              />
            }
          >
            My Drive
          </Button>
          <Button
            variant={shared ? 'secondary' : 'ghost'}
            size="sm"
            nativeButton={false}
            role="link"
            render={
              <Link
                to="/$workspaceSlug/files"
                params={{ workspaceSlug }}
                search={{ section: 'google', shared: true }}
                aria-current={shared ? 'page' : undefined}
              />
            }
          >
            Shared with me
          </Button>
        </nav>
      )}
      {list.state.kind === 'loading' ? (
        <div role="status" aria-label="Loading Google Drive files" className="space-y-4 py-2">
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading Google Drive files…</span>
        </div>
      ) : list.state.kind === 'unavailable' ? (
        <GoogleRecoveryPanel recovery={{ kind: 'unavailable' }} connect={drive.connect} retry={drive.refresh} />
      ) : list.state.kind === 'error' && list.state.busy ? (
        <GoogleBusyPanel>{retry('Try again')}</GoogleBusyPanel>
      ) : list.state.kind === 'error' ? (
        <StatePanel
          kind="error"
          title="Couldn’t load Google Drive"
          description="Google didn’t respond, or the request timed out. Your files in Google are unaffected."
        >
          {retry('Retry loading Google Drive')}
        </StatePanel>
      ) : list.state.data.kind === 'blocked' ? (
        (() => {
          switch (list.state.data.block) {
            case 'reconnect':
              return (
                <GoogleRecoveryPanel
                  recovery={{ kind: 'reconnect', email: access.email }}
                  connect={drive.connect}
                  retry={drive.refresh}
                />
              );
            case 'grant':
              return (
                <GoogleRecoveryPanel
                  recovery={{ kind: 'grant', app: 'drive', email: access.email }}
                  connect={drive.connect}
                  retry={drive.refresh}
                />
              );
            case 'not-found':
              return (
                <StatePanel
                  kind="unavailable"
                  icon={Folder}
                  title="This Google folder isn’t available"
                  description="It may have been deleted, moved to trash, or unshared in Google."
                >
                  {back}
                </StatePanel>
              );
            case 'denied':
              return folder ? (
                <StatePanel
                  kind="unavailable"
                  icon={Folder}
                  title="Google denied access to this folder"
                  description="Ask its owner in Google for access. Its contents stay hidden."
                >
                  {back}
                  {retry('Check access again')}
                </StatePanel>
              ) : (
                <StatePanel
                  kind="unavailable"
                  icon={Files}
                  title={`Google denied access to ${name ? 'this search' : shared ? 'files shared with you' : 'My Drive'}`}
                  description="Google refused to list these files for your account. Check your Drive access in Google, then try again."
                >
                  {retry('Check access again')}
                </StatePanel>
              );
            default:
              return (
                <StatePanel
                  kind="error"
                  title="Couldn’t load Google Drive"
                  description="Google rejected this listing. Your files in Google are unaffected."
                >
                  {retry('Retry loading Google Drive')}
                </StatePanel>
              );
          }
        })()
      ) : (
        <>
          <p role="status" className="sr-only">
            {list.state.refreshing ? 'Updating Google Drive files…' : ''}
          </p>
          {list.state.error && page && (
            <div className="flex flex-wrap items-center gap-2">
              <Alert variant="destructive">
                <AlertDescription>
                  Couldn’t refresh Google Drive. The list read at {readTime(page.readAt)} is still shown.
                </AlertDescription>
              </Alert>
              {retry('Retry loading Google Drive')}
            </div>
          )}
          {page && (
            <Listing
              actions={file =>
                (canCopy(file) || googleReadable(file)) && (
                  <RowMenu
                    workspaceId={workspaceId}
                    workspaceSlug={workspaceSlug}
                    api={api}
                    binding={binding}
                    file={file}
                  />
                )
              }
              files={page.value.files}
              skipped={page.value.skipped}
              incomplete={page.value.incompleteSearch}
              empty={(() => {
                if (name)
                  return (
                    <StatePanel
                      kind="empty"
                      icon={Files}
                      title={`No Google Drive files match “${name}”`}
                      description="Search checks file and folder names across My Drive and files shared with you."
                    >
                      <Button variant="outline" onClick={() => setDraft('')}>
                        Clear search
                      </Button>
                    </StatePanel>
                  );
                if (search.after)
                  return (
                    <StatePanel
                      kind="empty"
                      icon={Files}
                      title="No files on this page"
                      description={
                        page.value.nextPageToken
                          ? 'Google returned an empty page. More files may follow.'
                          : 'Files may have moved since the previous page loaded.'
                      }
                    />
                  );
                if (folder)
                  return (
                    <StatePanel
                      kind="empty"
                      icon={Folder}
                      title="This Google folder is empty"
                      description="Add files to it in Google Drive. They appear here the next time you refresh."
                    />
                  );
                if (shared)
                  return (
                    <StatePanel
                      kind="empty"
                      icon={Files}
                      title="Nothing shared with you in Google Drive"
                      description="Files that other people share with your Google account appear here."
                    />
                  );
                return (
                  <StatePanel
                    kind="empty"
                    icon={Files}
                    title="Your Google Drive is empty"
                    description="Files you add to My Drive in Google appear here. They stay in Google."
                  />
                );
              })()}
              link={file =>
                googleType(file).view === 'folder' ? (
                  to({ drive: file.id })
                ) : (
                  <Link
                    to="/$workspaceSlug/files/google/$fileId"
                    params={{ workspaceSlug, fileId: file.id }}
                    search={search}
                  />
                )
              }
            />
          )}
          {page && (search.after || page.value.nextPageToken) && (
            <nav aria-label="Google Drive pages" className="flex flex-wrap gap-2">
              {search.after && (
                <Button
                  variant="outline"
                  nativeButton={false}
                  role="link"
                  render={
                    <Link
                      to="/$workspaceSlug/files"
                      params={{ workspaceSlug }}
                      search={{ ...search, after: undefined }}
                    />
                  }
                >
                  First page
                </Button>
              )}
              {page.value.nextPageToken && (
                <Button
                  variant="outline"
                  nativeButton={false}
                  role="link"
                  render={
                    <Link
                      to="/$workspaceSlug/files"
                      params={{ workspaceSlug }}
                      search={{ ...search, after: page.value.nextPageToken }}
                    />
                  }
                >
                  Next page
                </Button>
              )}
            </nav>
          )}
        </>
      )}
    </>
  );
}

function Crumb({ name, link }: { name: string; link?: ReactElement | undefined }) {
  const label = (
    <span className="block max-w-48 truncate" title={name}>
      {name}
    </span>
  );
  return (
    <>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        {link ? <BreadcrumbLink render={link}>{label}</BreadcrumbLink> : <BreadcrumbPage>{label}</BreadcrumbPage>}
      </BreadcrumbItem>
    </>
  );
}

export function GoogleFileIcon({ file }: { file: Pick<GoogleFileMetadata, 'name' | 'mimeType'> }) {
  const type = googleType(file);
  if (type.view === 'folder') return <Folder size={20} />;
  return type.brand ? (
    <BrandIcon brand={type.brand} size="glyph" />
  ) : (
    <FileTypeIcon name={file.name} mediaType={file.mimeType} />
  );
}

function RowMenu({
  workspaceId,
  workspaceSlug,
  api,
  binding,
  file,
}: {
  workspaceId: string;
  workspaceSlug: string;
  api: GoogleFilesApi;
  binding: Ready['binding'];
  file: GoogleFileMetadata;
}) {
  const scope = useFeatureScope();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<'copy' | 'chat' | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${file.name}`} />}
        >
          <MoreH size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" size="menu">
          {googleReadable(file) && scope.kind === 'workspace' && (
            <DropdownMenuItem onClick={() => setOpen('chat')}>
              <ChatRound size={14} aria-hidden="true" />
              Use in chat
            </DropdownMenuItem>
          )}
          {canCopy(file) && (
            <DropdownMenuItem onClick={() => setOpen('copy')}>
              <Copy size={14} aria-hidden="true" />
              Save a copy to TulipFarm
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'copy' && (
        <SaveCopyDialog
          workspaceId={workspaceId}
          api={api}
          file={file}
          finalFocus={trigger}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'chat' && scope.kind === 'workspace' && (
        <UseGoogleFileInChatDialog
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          membershipId={scope.membershipId}
          file={file}
          binding={binding}
          finalFocus={() => trigger.current}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function Listing({
  files,
  skipped,
  incomplete,
  empty,
  link,
  actions,
}: {
  files: GoogleFileMetadata[];
  skipped: number;
  incomplete: boolean;
  empty: ReactNode;
  link: (file: GoogleFileMetadata) => ReactElement;
  actions: (file: GoogleFileMetadata) => ReactNode;
}) {
  return (
    <>
      {incomplete && (
        <Alert>
          <AlertDescription>
            Google searched only part of your Drive. Some matching files may be missing.
          </AlertDescription>
        </Alert>
      )}
      {skipped > 0 && (
        <Alert>
          <AlertDescription>
            {skipped === 1 ? '1 item' : `${skipped} items`} on this page couldn’t be shown because Google returned
            incomplete details.
          </AlertDescription>
        </Alert>
      )}
      {!files.length ? (
        empty
      ) : (
        <div>
          <div aria-hidden="true" className="hidden gap-3 border-b pb-2 text-xs text-muted-foreground @2xl:flex">
            <span className="w-8 shrink-0" />
            <span className="flex-1">Name</span>
            <span className="w-40 shrink-0">Owner</span>
            <span className="w-28 shrink-0 text-right">Modified</span>
            <span className="w-7 shrink-0" />
          </div>
          <ul aria-label="Google Drive files" className="divide-y">
            {files.map(file => {
              const type = googleType(file).label;
              const owner = googleOwner(file);
              const changed = file.modifiedTime ? modified.format(new Date(file.modifiedTime)) : '';
              return (
                <li key={file.id} className="flex min-w-0 items-center gap-3 py-1.5">
                  <span aria-hidden="true" className="flex w-8 shrink-0 justify-center text-muted-foreground">
                    <GoogleFileIcon file={file} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Button variant="link" size="task-link" nativeButton={false} role="link" render={link(file)}>
                      <span className="min-w-0 truncate" title={file.name}>
                        {file.name}
                      </span>
                    </Button>
                    <p className="truncate text-xs text-muted-foreground">
                      {type}
                      <span className="@2xl:hidden">
                        {[owner, changed]
                          .filter(Boolean)
                          .map(value => ` · ${value}`)
                          .join('')}
                      </span>
                    </p>
                  </div>
                  <span className="hidden w-40 shrink-0 truncate text-sm text-muted-foreground @2xl:block">
                    {owner}
                  </span>
                  <span className="hidden w-28 shrink-0 text-right text-sm text-muted-foreground tabular-nums @2xl:block">
                    {changed}
                  </span>
                  <div className="flex w-7 shrink-0 justify-end">{actions(file)}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
