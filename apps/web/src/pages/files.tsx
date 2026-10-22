import {
  DataList,
  DataListActions,
  DataListCell,
  DataListLink,
  DataListRow,
  DataListSecondary,
} from '@/components/data-list';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useElementScrollRestoration } from '@tanstack/react-router';
import { Edit } from 'reicon-react/icons/Edit';
import { FolderMove } from 'reicon-react/icons/FolderMove';
import { InfoCircle } from 'reicon-react/icons/InfoCircle';
import { Link as LinkIcon } from 'reicon-react/icons/Link';
import { Share } from 'reicon-react/icons/Share';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { Book } from 'reicon-react/icons/Book';
import { Briefcase } from 'reicon-react/icons/Briefcase';
import { Files } from 'reicon-react/icons/Files';
import { Folder } from 'reicon-react/icons/Folder';
import { FolderAdd } from 'reicon-react/icons/FolderAdd';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Trash } from 'reicon-react/icons/Trash';
import { Upload } from 'reicon-react/icons/Upload';
import type { LibraryItem, LibraryPage, LibraryQuery } from '@tulipfarm/files/contracts';
import { filesRoute, workspaceRoute } from '@/router';
import { FilesSample } from '@/components/empty-samples';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
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
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { SelectionSlot } from '@tulipfarm/sprout/selection-slot';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  fileKeys,
  filesViewSchema,
  filtered,
  place,
  libraryFilters,
  librarySort,
  modifiedText,
  roleLabels,
  useFilesApi,
  useFilesChanges,
  viewerSearchSchema,
  type FilesSearch,
  type FilesView,
  type FileSummary,
} from '@/features/files/api';
import { AllSources } from '@/features/files/all-sources';
import { clearedFilters, FilterBar } from '@/features/files/filters';
import { DeleteForeverDialog, deletionNotice, StorageUsage } from '@/features/files/deletion';
import { DetailsDialog, typeLabel } from '@/features/files/details';
import { GoogleDrive } from '@/features/files/google-drive';
import { MoveDialog, type MoveOutcome } from '@/features/files/move';
import { copyLink, SharingDialog } from '@/features/files/sharing';
import { NameDialog, UploadList, useFileDrop, useUploads, type Destination } from '@/features/files/operations';
import { UseInChatDialog } from '@/features/files/use-in-chat';
import { AddToKnowledgeDialog } from '@/features/files/add-to-knowledge';
import { AddToProjectDialog } from '@/features/files/add-to-project';
import { failedWrite, TableRequestError, type ReadState } from '@/features/tables/request-state';
import { formatFileSize } from '@/lib/file-viewer';
import { useFeatureRead, useFeatureScope } from '@/lib/query';

const views: Record<FilesView, string> = {
  mine: 'My files',
  shared: 'Shared with me',
  google: 'Google Drive',
  trash: 'Trash',
};
type Dialog =
  | { kind: 'folder'; destination: Destination }
  | { kind: 'rename'; item: FileSummary }
  | { kind: 'share'; item: FileSummary }
  | { kind: 'details'; item: FileSummary }
  | { kind: 'move'; items: FileSummary[] }
  | { kind: 'chat' | 'knowledge' | 'project'; items: FileSummary[] }
  | { kind: 'restore'; item: FileSummary }
  | { kind: 'delete'; item: FileSummary }
  | null;
type Notice =
  | { kind: 'done'; text: string; undo?: FileSummary }
  | { kind: 'failed'; text: string }
  | { kind: 'partial'; text: string; failures: { item: FileSummary; message: string }[] }
  | null;
const count = (total: number) => (total === 1 ? '1 item' : `${total} items`);

export function FilesPage() {
  const scope = useFeatureScope();
  const search = filesRoute.useSearch();
  if (scope.kind !== 'workspace') return null;
  return (
    <Library
      key={scope.membershipId}
      workspaceId={scope.workspaceId}
      membershipId={scope.membershipId}
      search={search}
    />
  );
}

function Library({
  workspaceId,
  membershipId,
  search,
}: {
  workspaceId: string;
  membershipId: string;
  search: FilesSearch;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const { sessionId, user } = workspaceRoute.useRouteContext();
  const navigate = filesRoute.useNavigate();
  const api = useFilesApi(workspaceId);
  const { changed } = useFilesChanges();
  const view = search.section ?? 'mine';
  const query = search.q ?? '';
  const allSources = search.scope === 'all' && query !== '';
  const library: LibraryQuery = {
    section: view === 'google' ? 'mine' : view,
    query,
    sort: librarySort(search),
    filters: libraryFilters(search),
    location: search.folder && !query ? { kind: 'folder', id: search.folder } : { kind: 'root' },
    ...(search.after ? { after: search.after } : {}),
  };
  // A cursor the server refuses (malformed, gone, or out of reach) is an expired link: drop it and show the first page.
  const read = useFeatureRead({
    key: fileKeys.library(library),
    enabled: view !== 'google' && !allSources,
    staleTime: 0,
    load: signal =>
      api.library(library, signal).catch((error: unknown) => {
        if (library.after && error instanceof TableRequestError && error.status === 400)
          return 'expired-cursor' as const;
        throw error;
      }),
    pollWhile: data => data !== 'expired-cursor' && data.items.some(item => item.deletion === 'deleting'),
    interval: 5000,
    maxChecks: 24,
  });
  const expired = read.state.kind === 'ready' && read.state.data === 'expired-cursor';
  const listing: ReadState<LibraryPage> =
    read.state.kind !== 'ready'
      ? read.state
      : read.state.data === 'expired-cursor'
        ? { kind: 'loading' }
        : { ...read.state, data: read.state.data };
  const page = listing.kind === 'ready' ? listing.data : null;
  const folder = library.location.kind === 'folder' ? page?.breadcrumbs.at(-1) : undefined;
  const destination: Destination | null =
    view === 'mine' && library.location.kind === 'root' && !query
      ? { parentId: null, label: 'My files' }
      : folder && folder.role !== 'viewer'
        ? { parentId: folder.id, label: folder.name }
        : null;
  const uploads = useUploads(api, { userId: user.id, sessionId, workspaceId, membershipId }, changed);
  const drop = useFileDrop(uploads.add);
  const listDrop = drop.zone(view === 'google' || allSources ? null : destination);
  const chooser = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, FileSummary>>(new Map());
  const noticeRegion = useRef<HTMLDivElement>(null);
  const focusNotice = useRef(false);
  const finalFocus = () => {
    const notice = focusNotice.current && noticeRegion.current;
    focusNotice.current = false;
    return notice || true;
  };
  // Focuses the notice once it renders, after the control that started an action unmounts with its row or empty state.
  const [noticeFocus, setNoticeFocus] = useState(0);
  useEffect(() => {
    if (noticeFocus) noticeRegion.current?.focus();
  }, [noticeFocus]);
  const focusNoticeSoon = () => setNoticeFocus(value => value + 1);
  const [draft, setDraft] = useState(query);
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useElementScrollRestoration({ id: 'files-library' });
  useEffect(() => {
    if (page && restored && scroller.current) scroller.current.scrollTop = restored.scrollY;
  }, [page === null, restored?.scrollY]);
  useEffect(() => {
    setDraft(query);
  }, [query]);
  useEffect(() => {
    setNotice(null);
    setSelected(new Map());
  }, [view, search.folder, query, allSources, JSON.stringify(library.filters)]);
  useEffect(() => {
    if (!expired) return;
    void navigate({ search: { ...search, after: undefined }, replace: true });
    setNotice({ kind: 'failed', text: 'This page link no longer works. Showing the first page.' });
  }, [expired]);
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(
      () => void navigate({ search: { ...search, q: draft || undefined, after: undefined }, replace: true }),
      250,
    );
    return () => clearTimeout(timer);
  }, [draft]);

  /** A folder or page in this section, keeping the chosen sort and filters. */
  const at = (next: FilesSearch) => ({
    ...(view === 'mine' ? {} : { section: view }),
    sort: search.sort,
    order: search.order,
    type: search.type,
    owner: search.owner,
    modified: search.modified,
    from: search.from,
    to: search.to,
    ...next,
  });
  const change = (next: Partial<FilesSearch>) =>
    void navigate({ search: { ...search, ...next, after: undefined }, replace: true });
  const scope = query !== '' && (
    <SearchScope section={views[view]} all={allSources} set={all => change({ scope: all ? 'all' : undefined })} />
  );
  async function setTrashed(item: FileSummary, trashed: boolean) {
    setPending(item.id);
    setNotice(null);
    try {
      await api.trash(item.id, trashed);
      void changed();
      setNotice({
        kind: 'done',
        text: trashed ? `“${item.name}” moved to Trash.` : `“${item.name}” restored to its original location.`,
        ...(trashed ? { undo: item } : {}),
      });
      if (!trashed) focusNoticeSoon();
    } catch (error) {
      if (!trashed && error instanceof TableRequestError && error.code === 'file-restore-destination') {
        setDialog({ kind: 'restore', item });
        return;
      }
      setNotice({
        kind: 'failed',
        text: `“${item.name}” could not be ${trashed ? 'moved to Trash' : 'restored'}. Your access may have changed. Refresh the list and try again.`,
      });
    } finally {
      setPending(null);
    }
  }
  async function retryDeletion(item: FileSummary) {
    setPending(item.id);
    setNotice(null);
    try {
      setNotice(deletionNotice(item, await api.deleteForever(item.id)));
    } catch (error) {
      const outcome = failedWrite(null, error);
      setNotice({
        kind: 'failed',
        text:
          outcome.kind === 'rejected'
            ? `“${item.name}”: ${outcome.message}`
            : `We couldn’t confirm whether “${item.name}” finished deleting. Check Trash again in a moment.`,
      });
    } finally {
      setPending(null);
      void changed();
    }
  }
  function deleted(item: FileSummary, outcome: Parameters<typeof deletionNotice>[1] | null) {
    setDialog(null);
    if (!outcome) return;
    focusNotice.current = true;
    setNotice(deletionNotice(item, outcome));
    void changed();
  }
  async function trashSelected(items: FileSummary[]) {
    setPending('selection');
    setNotice(null);
    const failures: { item: FileSummary; message: string }[] = [];
    for (const item of items) {
      try {
        await api.trash(item.id, true);
      } catch (error) {
        const outcome = failedWrite(null, error);
        failures.push({
          item,
          message:
            outcome.kind === 'rejected'
              ? `${outcome.message} It wasn’t moved to Trash.`
              : 'We couldn’t confirm whether it moved to Trash. Refresh the list to check.',
        });
      }
    }
    void changed();
    setPending(null);
    setSelected(new Map(failures.map(failure => [failure.item.id, failure.item])));
    const trashed = items.length - failures.length;
    setNotice(
      failures.length
        ? {
            kind: 'partial',
            text: `${count(trashed)} moved to Trash. ${count(failures.length)} need${failures.length === 1 ? 's' : ''} attention.`,
            failures,
          }
        : { kind: 'done', text: `${count(trashed)} moved to Trash.` },
    );
    focusNoticeSoon();
  }
  function moved(outcome: MoveOutcome | null, verb: 'Moved' | 'Restored' = 'Moved') {
    setDialog(null);
    if (!outcome) return;
    focusNotice.current = true;
    setSelected(new Map(outcome.failed.map(failure => [failure.item.id, failure.item])));
    const only =
      outcome.moved.length === 1 && !outcome.failed.length
        ? `“${outcome.moved[0]?.name}”`
        : count(outcome.moved.length);
    setNotice(
      outcome.failed.length
        ? {
            kind: 'partial',
            text: `${count(outcome.moved.length)} ${verb.toLowerCase()} to ${outcome.destination.label}. ${count(outcome.failed.length)} need${outcome.failed.length === 1 ? 's' : ''} attention.`,
            failures: outcome.failed,
          }
        : { kind: 'done', text: `${verb} ${only} to ${outcome.destination.label}.` },
    );
  }
  const select = (item: FileSummary, checked: boolean) =>
    setSelected(current => {
      const next = new Map(current);
      if (checked) next.set(item.id, item);
      else next.delete(item.id);
      return next;
    });
  const selection = [...selected.values()];
  const actions = destination && (
    <>
      <Button onClick={() => chooser.current?.click()}>
        <Upload size={16} aria-hidden="true" />
        Upload
      </Button>
      <Button variant="outline" onClick={() => setDialog({ kind: 'folder', destination })}>
        <FolderAdd size={16} aria-hidden="true" />
        New folder
      </Button>
    </>
  );

  return (
    <div ref={scroller} data-scroll-restoration-id="files-library" className="min-h-0 flex-1 overflow-y-auto">
      <PageContent>
        {destination && (
          <Input
            ref={chooser}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={event => {
              uploads.add(
                Array.from(event.target.files ?? [], file => ({ file, folder: false })),
                destination,
              );
              event.target.value = '';
            }}
          />
        )}
        <PageHeader
          title="Files"
          description="Find, open, and organize workspace files. Sharing a file never changes who owns it."
          actions={actions}
        />
        <div className="space-y-2 lg:hidden">
          <Label htmlFor="files-view">Section</Label>
          <Select
            value={view}
            onValueChange={value => {
              if (!value) return;
              const next = filesViewSchema.parse(value);
              void navigate({ search: next === 'mine' ? {} : { section: next } });
            }}
          >
            <SelectTrigger id="files-view" width="full">
              <SelectValue>{views[view]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(views).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <StorageUsage api={api} />
        </div>
        <div className="flex min-w-0 gap-8">
          <div className="hidden w-44 shrink-0 space-y-6 lg:block">
            <nav aria-label="Files sections">
              <ul className="space-y-0.5">
                {Object.entries(views).map(([value, label]) => (
                  <li key={value} className="grid">
                    <Button
                      variant={view === value ? 'secondary' : 'ghost'}
                      size="md"
                      nativeButton={false}
                      role="link"
                      render={
                        <Link
                          to="/$workspaceSlug/files"
                          params={{ workspaceSlug }}
                          search={value === 'mine' ? {} : { section: filesViewSchema.parse(value) }}
                          aria-current={view === value ? 'page' : undefined}
                        />
                      }
                    >
                      <span className="flex-1 text-start">{label}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </nav>
            <section aria-label="Storage">
              <StorageUsage api={api} />
            </section>
          </div>
          <section
            aria-label={allSources ? 'All sources' : views[view]}
            data-drop-target={
              (!allSources && drop.target !== null && drop.target.parentId === destination?.parentId) || undefined
            }
            onDragOver={listDrop.onDragOver}
            onDragLeave={listDrop.onDragLeave}
            onDrop={listDrop.onDrop}
            className="@container min-w-0 flex-1 space-y-4 rounded-xl outline-offset-4 data-drop-target:outline-2 data-drop-target:outline-ring data-drop-target:outline-dashed"
          >
            {drop.target && (
              <p
                role="status"
                className="pointer-events-none fixed inset-x-4 bottom-6 z-50 mx-auto w-fit max-w-full truncate rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg"
              >
                Drop to upload to {drop.target.label}
              </p>
            )}
            {allSources ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-foreground">Search results from all sources</h2>
                  <SearchField label="Search all sources" value={draft} maxLength={255} onChange={setDraft} />
                </div>
                {scope}
                <AllSources workspaceId={workspaceId} membershipId={membershipId} search={search} change={change} />
              </>
            ) : view === 'google' ? (
              <GoogleDrive workspaceId={workspaceId} scope={scope} />
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Breadcrumb aria-label="Folder path">
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        {library.location.kind === 'root' && !query ? (
                          <BreadcrumbPage>{views[view]}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink
                            render={<Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={at({})} />}
                          >
                            {views[view]}
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {query ? (
                        <>
                          <BreadcrumbSeparator />
                          <BreadcrumbItem>
                            <BreadcrumbPage>Search results</BreadcrumbPage>
                          </BreadcrumbItem>
                        </>
                      ) : (
                        page && (
                          <Trail
                            page={page}
                            link={id => (
                              <Link to="/$workspaceSlug/files" params={{ workspaceSlug }} search={at({ folder: id })} />
                            )}
                          />
                        )
                      )}
                    </BreadcrumbList>
                  </Breadcrumb>
                  <SearchField label={`Search ${views[view]}`} value={draft} maxLength={255} onChange={setDraft} />
                </div>
                {scope}
                <div className="@container/selection">
                  <SelectionSlot
                    active={selection.length > 0 && view !== 'trash'}
                    selection={
                      <div role="toolbar" aria-label="Selected items" className="flex min-w-0 items-center gap-2">
                        <p role="status" className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {count(selection.length)} selected
                        </p>
                        <div className="hidden items-center gap-2 @4xl/selection:flex">
                          {selection.some(item => item.kind === 'file') && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pending !== null}
                                onClick={() => setDialog({ kind: 'chat', items: selection })}
                              >
                                <ChatRound size={14} aria-hidden="true" />
                                Use in chat
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pending !== null}
                                onClick={() => setDialog({ kind: 'knowledge', items: selection })}
                              >
                                <Book size={14} aria-hidden="true" />
                                Add to Knowledge
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pending !== null}
                                onClick={() => setDialog({ kind: 'project', items: selection })}
                              >
                                <Briefcase size={14} aria-hidden="true" />
                                Add to project
                              </Button>
                            </>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending !== null}
                            onClick={() => setDialog({ kind: 'move', items: selection })}
                          >
                            <FolderMove size={14} aria-hidden="true" />
                            Move
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending !== null}
                            aria-busy={pending === 'selection'}
                            onClick={() => void trashSelected(selection)}
                          >
                            <Trash size={14} aria-hidden="true" />
                            {pending === 'selection' ? 'Moving to Trash…' : 'Move to trash'}
                          </Button>
                        </div>
                        <div className="@4xl/selection:hidden">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={pending !== null}
                                  aria-busy={pending === 'selection'}
                                />
                              }
                            >
                              {pending === 'selection' ? 'Moving…' : 'Selected actions'}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {selection.some(item => item.kind === 'file') && (
                                <>
                                  <DropdownMenuItem
                                    disabled={pending !== null}
                                    onClick={() => setDialog({ kind: 'chat', items: selection })}
                                  >
                                    Use in chat
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={pending !== null}
                                    onClick={() => setDialog({ kind: 'knowledge', items: selection })}
                                  >
                                    Add to Knowledge
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={pending !== null}
                                    onClick={() => setDialog({ kind: 'project', items: selection })}
                                  >
                                    Add to project
                                  </DropdownMenuItem>
                                </>
                              )}
                              <DropdownMenuItem
                                disabled={pending !== null}
                                onClick={() => setDialog({ kind: 'move', items: selection })}
                              >
                                Move
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={pending !== null}
                                onClick={() => void trashSelected(selection)}
                              >
                                Move to trash
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <FilterBar
                          compact
                          search={search}
                          owners={page?.owners ?? []}
                          membershipId={membershipId}
                          change={change}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending !== null}
                          aria-label="Clear selection"
                          onClick={() => setSelected(new Map())}
                        >
                          Clear
                        </Button>
                      </div>
                    }
                  >
                    <FilterBar
                      search={search}
                      owners={page?.owners ?? []}
                      membershipId={membershipId}
                      change={change}
                    />
                  </SelectionSlot>
                </div>
                {view === 'trash' && (
                  <p className="text-sm text-muted-foreground">
                    Trash keeps items you manage until someone restores them or the owner deletes them forever. Trashed
                    files still use storage.
                  </p>
                )}
                <UploadList uploads={uploads} />
                <div
                  ref={noticeRegion}
                  tabIndex={-1}
                  className="space-y-2 rounded-lg empty:hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {notice?.kind === 'failed' && (
                    <Alert variant="destructive">
                      <AlertDescription>{notice.text}</AlertDescription>
                    </Alert>
                  )}
                  {notice?.kind === 'partial' && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        <p>{notice.text}</p>
                        <ul className="mt-1 list-disc pl-5">
                          {notice.failures.map(failure => (
                            <li key={failure.item.id} className="wrap-anywhere">
                              “{failure.item.name}”: {failure.message}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1">Items that need attention stay selected.</p>
                      </AlertDescription>
                    </Alert>
                  )}
                  {notice?.kind === 'done' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <p role="status" className="text-sm text-foreground wrap-anywhere">
                        {notice.text}
                      </p>
                      {notice.undo && (
                        <UndoButton
                          key={notice.text}
                          disabled={pending !== null}
                          undo={() => {
                            if (notice.undo) void setTrashed(notice.undo, false);
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
                <Listing
                  state={listing}
                  retry={read.refresh}
                  folder={library.location.kind === 'folder'}
                  empty={() => {
                    if (filtered(search))
                      return (
                        <StatePanel
                          kind="empty"
                          icon={Files}
                          title="No files match these filters"
                          description={`Filters apply to ${query ? 'search results' : 'this location'} in ${views[view]}. Files added before modified times were recorded don’t match a date filter.`}
                        >
                          <Button variant="outline" onClick={() => change(clearedFilters)}>
                            Clear filters
                          </Button>
                        </StatePanel>
                      );
                    if (query)
                      return (
                        <StatePanel
                          kind="empty"
                          icon={Files}
                          title={`No files match “${query}”`}
                          description={`Search checks names in ${views[view]}, including items inside folders.`}
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
                          title="No more files"
                          description="Items may have moved since this page loaded."
                        >
                          <Button
                            variant="outline"
                            nativeButton={false}
                            role="link"
                            render={
                              <Link
                                to="/$workspaceSlug/files"
                                params={{ workspaceSlug }}
                                search={at(search.folder ? { folder: search.folder } : {})}
                              />
                            }
                          >
                            Back to first page
                          </Button>
                        </StatePanel>
                      );
                    if (library.location.kind === 'folder')
                      return (
                        <StatePanel
                          kind="empty"
                          icon={Folder}
                          title="This folder is empty"
                          description={
                            destination
                              ? 'Upload files or add a folder to organize this space.'
                              : 'Nothing has been added here yet. You can view this folder but not add to it.'
                          }
                        >
                          {actions}
                        </StatePanel>
                      );
                    if (view === 'shared')
                      return (
                        <StatePanel
                          kind="empty"
                          icon={Files}
                          title="Nothing shared with you yet"
                          description="Files and folders that other people share with you appear here. A workspace role alone does not open someone else's files."
                        />
                      );
                    if (view === 'trash')
                      return (
                        <StatePanel
                          kind="empty"
                          icon={Trash}
                          title="Trash is empty"
                          description="Items you move to Trash appear here until you restore them or delete them forever. So do items you own inside a folder someone else moved to Trash."
                        />
                      );
                    return (
                      <StatePanel
                        kind="empty"
                        icon={Files}
                        title="No files yet"
                        description="Upload the documents your work depends on, like price lists, contracts, and policies. Files stay private until you share them."
                        sample={<FilesSample />}
                      >
                        {actions}
                      </StatePanel>
                    );
                  }}
                >
                  {data => (
                    <>
                      <div>
                        <DataList
                          aria-label={query ? 'Search results' : 'Files and folders'}
                          stack="container"
                          columns={view === 'trash' ? 'trailingActions' : 'trailing'}
                          headings={
                            view === 'trash' ? ['Name', 'Owner', 'Size', ''] : ['Name', 'Owner', 'Modified', 'Size', '']
                          }
                        >
                          {data.items.map(item => (
                            <Row
                              key={item.id}
                              item={item}
                              trash={view === 'trash'}
                              owned={item.creatorMembershipId === membershipId}
                              place={query ? place(item, membershipId) : null}
                              owner={
                                item.creatorMembershipId === membershipId
                                  ? 'You'
                                  : `${data.owners.find(owner => owner.membershipId === item.creatorMembershipId)?.name ?? 'Former member'} · ${roleLabels[item.role]}`
                              }
                              busy={pending === item.id || (pending === 'selection' && selected.has(item.id))}
                              selected={selected.has(item.id)}
                              select={checked => select(item, checked)}
                              drop={
                                item.kind === 'folder' && view !== 'trash'
                                  ? drop.zone(item.role === 'viewer' ? null : { parentId: item.id, label: item.name })
                                  : undefined
                              }
                              dropTarget={item.kind === 'folder' && drop.target?.parentId === item.id}
                              link={
                                item.kind === 'folder' ? (
                                  <Link
                                    to="/$workspaceSlug/files"
                                    params={{ workspaceSlug }}
                                    search={at({ folder: item.id })}
                                  />
                                ) : (
                                  <Link
                                    to="/$workspaceSlug/files/$fileId"
                                    params={{ workspaceSlug, fileId: item.id }}
                                    search={viewerSearchSchema.parse(search)}
                                  />
                                )
                              }
                              open={kind => setDialog({ kind, item })}
                              move={() => setDialog({ kind: 'move', items: [item] })}
                              promote={kind => setDialog({ kind, items: [item] })}
                              rescue={() => setDialog({ kind: 'restore', item })}
                              copy={() => void copyLink(workspaceSlug, item).then(setNotice)}
                              setTrashed={trashed => void setTrashed(item, trashed)}
                              deleteForever={() => setDialog({ kind: 'delete', item })}
                              retryDeletion={() => void retryDeletion(item)}
                            />
                          ))}
                        </DataList>
                      </div>
                      {(search.after || data.next) && (
                        <nav aria-label="File pages" className="flex flex-wrap gap-2">
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
                          {data.next && (
                            <Button
                              variant="outline"
                              nativeButton={false}
                              role="link"
                              render={
                                <Link
                                  to="/$workspaceSlug/files"
                                  params={{ workspaceSlug }}
                                  search={{ ...search, after: data.next }}
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
                </Listing>
              </>
            )}
          </section>
        </div>
        {dialog?.kind === 'share' && (
          <SharingDialog
            api={api}
            item={dialog.item}
            membershipId={membershipId}
            workspaceSlug={workspaceSlug}
            finalFocus={finalFocus}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'details' && (
          <DetailsDialog
            api={api}
            item={dialog.item}
            membershipId={membershipId}
            finalFocus={finalFocus}
            share={() => setDialog({ kind: 'share', item: dialog.item })}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'delete' && (
          <DeleteForeverDialog
            api={api}
            item={dialog.item}
            finalFocus={finalFocus}
            onClose={outcome => deleted(dialog.item, outcome)}
          />
        )}
        {dialog?.kind === 'knowledge' && (
          <AddToKnowledgeDialog
            workspaceId={workspaceId}
            items={dialog.items}
            finalFocus={finalFocus}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'project' && (
          <AddToProjectDialog
            api={api}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            membershipId={membershipId}
            items={dialog.items}
            finalFocus={finalFocus}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'chat' && (
          <UseInChatDialog
            api={api}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            membershipId={membershipId}
            items={dialog.items}
            finalFocus={finalFocus}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'move' && (
          <MoveDialog
            api={api}
            items={dialog.items}
            membershipId={membershipId}
            finalFocus={finalFocus}
            onClose={moved}
          />
        )}
        {dialog?.kind === 'restore' && (
          <MoveDialog
            verb="Restore"
            api={api}
            items={[dialog.item]}
            membershipId={membershipId}
            finalFocus={finalFocus}
            onClose={outcome => moved(outcome, 'Restored')}
          />
        )}
        {(dialog?.kind === 'folder' || dialog?.kind === 'rename') && (
          <NameDialog
            key={dialog.kind === 'rename' ? dialog.item.id : 'folder'}
            mode={dialog}
            open
            onOpenChange={open => {
              if (!open) setDialog(null);
            }}
            refresh={() => void changed()}
            finalFocus={finalFocus}
            submit={(name, id) =>
              dialog.kind === 'rename'
                ? api.rename(dialog.item.id, name)
                : api.createFolder(id, name, dialog.destination.parentId)
            }
            done={item => {
              void changed();
              if (dialog.kind === 'folder') focusNotice.current = true;
              setNotice({
                kind: 'done',
                text: dialog.kind === 'rename' ? `Renamed to “${item.name}”.` : `Folder “${item.name}” created.`,
              });
            }}
          />
        )}
      </PageContent>
    </div>
  );
}

function UndoButton({ disabled, undo }: { disabled: boolean; undo: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <Button ref={button} variant="outline" size="sm" disabled={disabled} onClick={undo}>
      Undo
    </Button>
  );
}

function Trail({ page, link }: { page: LibraryPage; link: (id: string) => ReactElement }) {
  const restricted = (page.breadcrumbs[0]?.parentId ?? null) !== null;
  return (
    <>
      {restricted && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbEllipsis />
            <span className="sr-only">Folders you cannot open</span>
          </BreadcrumbItem>
        </>
      )}
      {page.breadcrumbs.map((crumb, index) => (
        <Crumb key={crumb.id} name={crumb.name} current={index === page.breadcrumbs.length - 1} link={link(crumb.id)} />
      ))}
    </>
  );
}

function Crumb({ name, current, link }: { name: string; current: boolean; link: ReactElement }) {
  const label = (
    <span className="block max-w-48 truncate" title={name}>
      {name}
    </span>
  );
  return (
    <>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        {current ? <BreadcrumbPage>{label}</BreadcrumbPage> : <BreadcrumbLink render={link}>{label}</BreadcrumbLink>}
      </BreadcrumbItem>
    </>
  );
}

function Listing({
  state,
  retry,
  folder,
  empty,
  children,
}: {
  state: ReadState<LibraryPage>;
  retry: () => Promise<void>;
  folder: boolean;
  empty: () => ReactNode;
  children: (page: LibraryPage) => ReactNode;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const [retrying, setRetrying] = useState(false);
  const again = async () => {
    setRetrying(true);
    try {
      await retry();
    } finally {
      setRetrying(false);
    }
  };
  const button = (label: string, variant: 'outline' | 'ghost' = 'outline') => (
    <Button variant={variant} disabled={retrying} aria-busy={retrying} onClick={() => void again()}>
      {retrying ? 'Checking…' : label}
    </Button>
  );
  if (state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading files" className="space-y-4 py-2">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading files…</span>
      </div>
    );
  if (state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        title={folder ? 'Folder unavailable' : 'Files unavailable'}
        description={
          folder
            ? 'This folder was moved to Trash, or your access changed. Its contents stay hidden.'
            : 'Your workspace access changed. Files stay hidden until access is confirmed.'
        }
      >
        <Button
          variant="outline"
          nativeButton={false}
          role="link"
          render={<Link to="/$workspaceSlug/files" params={{ workspaceSlug }} />}
        >
          Back to My files
        </Button>
        {button('Check access again', 'ghost')}
      </StatePanel>
    );
  if (state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        title="Couldn’t load files"
        description="Your files are safe. The list could not be loaded. Check your connection and try again."
      >
        {button('Retry loading files')}
      </StatePanel>
    );
  return (
    <>
      <p role="status" className="sr-only">
        {state.refreshing ? 'Updating files…' : ''}
      </p>
      {state.error && (
        <div className="flex flex-wrap items-center gap-2">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t refresh files. The last loaded list is still shown.</AlertDescription>
          </Alert>
          {button('Retry loading files')}
        </div>
      )}
      {state.data.items.length ? children(state.data) : empty()}
    </>
  );
}

function TrashActions({
  item,
  owned,
  busy,
  restore,
  rescue,
  deleteForever,
  retryDeletion,
}: {
  item: LibraryItem;
  owned: boolean;
  busy: boolean;
  restore: () => void;
  rescue: () => void;
  deleteForever: () => void;
  retryDeletion: () => void;
}) {
  if (item.deletion === 'deleting') return <p className="text-xs text-muted-foreground">Deleting forever…</p>;
  if (item.deletion === 'failed')
    return (
      <>
        <p className="text-xs text-destructive">Deletion didn’t finish</p>
        {owned && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            aria-label={`Retry deleting ${item.name}`}
            onClick={retryDeletion}
          >
            {busy ? 'Retrying…' : 'Retry deletion'}
          </Button>
        )}
      </>
    );
  if (item.stranded)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-label={`Restore ${item.name} to a folder you choose`}
        onClick={rescue}
      >
        Restore…
      </Button>
    );
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-busy={busy}
        aria-label={`Restore ${item.name}`}
        onClick={restore}
      >
        {busy ? 'Restoring…' : 'Restore'}
      </Button>
      {owned && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Delete ${item.name} forever`}
          onClick={deleteForever}
        >
          Delete forever
        </Button>
      )}
    </>
  );
}

function SearchScope({ section, all, set }: { section: string; all: boolean; set: (all: boolean) => void }) {
  return (
    <div role="group" aria-label="Search in" className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-sm text-muted-foreground">Search in</span>
      <Button variant={all ? 'ghost' : 'scope'} size="sm" aria-pressed={!all} onClick={() => set(false)}>
        {section}
      </Button>
      <Button variant={all ? 'scope' : 'ghost'} size="sm" aria-pressed={all} onClick={() => set(true)}>
        All sources
      </Button>
    </div>
  );
}

function Modified({ at }: { at: string | null }) {
  if (at === null)
    return (
      <span title="Not recorded for files added before modified times were tracked">
        —<span className="sr-only">Unknown</span>
      </span>
    );
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {modifiedText(at)}
    </time>
  );
}

function Row({
  item,
  trash,
  owned,
  owner,
  place,
  busy,
  selected,
  select,
  link,
  drop,
  dropTarget,
  open,
  move,
  promote,
  rescue,
  copy,
  setTrashed,
  deleteForever,
  retryDeletion,
}: {
  item: LibraryItem;
  trash: boolean;
  owned: boolean;
  owner: string;
  place: string | null;
  busy: boolean;
  selected: boolean;
  select: (checked: boolean) => void;
  link: ReactElement;
  drop: ReturnType<ReturnType<typeof useFileDrop>['zone']> | undefined;
  dropTarget: boolean;
  open: (kind: 'rename' | 'share' | 'details') => void;
  move: () => void;
  promote: (kind: 'chat' | 'knowledge' | 'project') => void;
  rescue: () => void;
  copy: () => void;
  setTrashed: (trashed: boolean) => void;
  deleteForever: () => void;
  retryDeletion: () => void;
}) {
  const type = typeLabel(item);
  const size = item.size === null ? '' : formatFileSize(item.size);
  const manager = item.role === 'manager';
  return (
    <DataListRow
      dropTarget={dropTarget}
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
    >
      <DataListCell flow="line">
        {!trash && (
          <span className="relative z-10 flex w-4 shrink-0 justify-center">
            {manager && (
              <Checkbox
                checked={selected}
                disabled={busy}
                aria-label={`Select ${item.name}`}
                onCheckedChange={select}
              />
            )}
          </span>
        )}
        <span aria-hidden="true" className="flex w-6 shrink-0 justify-center text-muted-foreground">
          {item.kind === 'folder' ? (
            <Folder size={20} />
          ) : (
            <FileTypeIcon name={item.name} mediaType={item.mediaType ?? 'application/octet-stream'} />
          )}
        </span>
        {trash ? (
          <span className="min-w-0">
            <span className="block truncate" title={item.name}>
              {item.name}
            </span>
            {item.stranded && (
              <span className="block text-xs text-muted-foreground">Its folder was moved to Trash by its owner</span>
            )}
          </span>
        ) : (
          <DataListLink role="link" render={link}>
            <span title={item.name}>{item.name}</span>
          </DataListLink>
        )}
        <span className="text-xs text-muted-foreground list-wide:hidden">
          {[type, `Modified ${modifiedText(item.modifiedAt)}`, size, owner].filter(Boolean).join(' · ')}
        </span>
        {place && <span className="w-full text-xs text-muted-foreground list-wide:pl-12">{place}</span>}
      </DataListCell>
      <DataListSecondary visibility="wide">{owner}</DataListSecondary>
      {!trash && (
        <DataListSecondary visibility="wide">
          <Modified at={item.modifiedAt} />
        </DataListSecondary>
      )}
      <DataListSecondary visibility="wide">{size}</DataListSecondary>
      <DataListActions>
        {trash ? (
          <TrashActions
            item={item}
            owned={owned}
            busy={busy}
            restore={() => setTrashed(false)}
            rescue={rescue}
            deleteForever={deleteForever}
            retryDeletion={retryDeletion}
          />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${item.name}`} />}
            >
              <MoreH size={16} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" size="menu">
              {item.kind === 'file' && (
                <>
                  <DropdownMenuItem onClick={() => promote('chat')}>
                    <ChatRound size={14} aria-hidden="true" />
                    Use in chat
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => promote('knowledge')}>
                    <Book size={14} aria-hidden="true" />
                    Add to Knowledge
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => promote('project')}>
                    <Briefcase size={14} aria-hidden="true" />
                    Add to project
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => open('details')}>
                <InfoCircle size={14} aria-hidden="true" />
                Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copy}>
                <LinkIcon size={14} aria-hidden="true" />
                Copy link
              </DropdownMenuItem>
              {manager && (
                <>
                  <DropdownMenuItem onClick={() => open('share')}>
                    <Share size={14} aria-hidden="true" />
                    Share
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => open('rename')}>
                    <Edit size={14} aria-hidden="true" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={move}>
                    <FolderMove size={14} aria-hidden="true" />
                    Move
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setTrashed(true)}>
                    <Trash size={14} aria-hidden="true" />
                    Move to trash
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </DataListActions>
    </DataListRow>
  );
}
