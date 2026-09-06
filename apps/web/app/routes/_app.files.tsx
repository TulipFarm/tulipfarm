import { type MetaFunction, useLoaderData, useNavigate, useRouteError } from "@remix-run/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FileList } from "~/components/files/file-list";
import { FilePreview } from "~/components/files/file-preview";
import { ShareDialog } from "~/components/files/file-share";
import { FileUploadDialog } from "~/components/files/file-upload-dialog";
import { ChevronRight, Folder, Pencil, Plus, Search, Trash2, Upload } from "~/components/icons";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ConfirmModal, Modal } from "~/components/ui/modal";
import { Select } from "~/components/ui/select";
import { ApiError, getSession } from "~/lib/api";
import {
  addFileToKnowledge,
  archiveFile,
  createFileFolder,
  deleteFile,
  deleteFileFolder,
  type FileFolder,
  fetchArchivedFiles,
  fetchFileFolders,
  fetchFiles,
  fetchSharedWithMe,
  type LibraryFile,
  moveFile,
  removeFileFromKnowledge,
  renameFileFolder,
  restoreArchivedFile,
  searchFiles,
} from "~/lib/files";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Files · tulipfarm" }];

const PAGE_SIZE = 50;

/**
 * How many pages a narrowing view may pull in before it stops and says so.
 *
 * Filtering and sorting happen over the Files already loaded, so a filter applied to one page of a
 * larger library returns a confidently wrong answer rather than an obviously incomplete one. The
 * page closes that by fetching the rest before it narrows. The cap is what keeps a very large
 * library from turning one dropdown into an unbounded read — at which point the count is shown
 * instead of quietly truncating.
 */
const MAX_AUTO_PAGES = 20;

const TABS = [
  { id: "all", label: "All Files" },
  { id: "mine", label: "My Files" },
  { id: "shared", label: "Shared with me" },
  { id: "archived", label: "Trash" },
] as const;

type TabId = (typeof TABS)[number]["id"];
type SourceId = Exclude<TabId, "all">;
type SortId = "modified-desc" | "modified-asc" | "name-asc" | "size-desc";
type TypeFilter = "all" | "images" | "pdf" | "documents" | "spreadsheets" | "text";
type AccessFilter = "all" | "private" | "shared";
type KnowledgeFilter = "all" | "in" | "out";
type FileSources = Record<SourceId, readonly LibraryFile[]>;
type FileCursors = Record<SourceId, string | null>;

export async function clientLoader() {
  const [mine, shared, archived, folders, viewer] = await Promise.all([
    fetchFiles({ limit: PAGE_SIZE }),
    fetchSharedWithMe({ limit: PAGE_SIZE }),
    fetchArchivedFiles({ limit: PAGE_SIZE }),
    fetchFileFolders(),
    getSession(),
  ]);
  return {
    sources: { mine: mine.files, shared: shared.files, archived: archived.files },
    cursors: {
      mine: mine.nextCursor,
      shared: shared.nextCursor,
      archived: archived.nextCursor,
    },
    viewerId: viewer.id,
    folders,
  };
}

export default function FilesIndex() {
  const loaded = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [sources, setSources] = useState<FileSources>(loaded.sources);
  const [cursors, setCursors] = useState<FileCursors>(loaded.cursors);
  const [tab, setTab] = useState<TabId>("all");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<readonly LibraryFile[] | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<"all" | "mine" | "others">("all");
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [knowledgeFilter, setKnowledgeFilter] = useState<KnowledgeFilter>("all");
  const [sort, setSort] = useState<SortId>("modified-desc");
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<LibraryFile | null>(null);
  const [sharing, setSharing] = useState<LibraryFile | null>(null);
  const [archiving, setArchiving] = useState<LibraryFile | null>(null);
  const [deleting, setDeleting] = useState<LibraryFile | null>(null);
  const [mutating, setMutating] = useState(false);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folders, setFolders] = useState<readonly FileFolder[]>(loaded.folders);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<FileFolder | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [moving, setMoving] = useState<LibraryFile | null>(null);
  const [autoPages, setAutoPages] = useState(0);
  const searchRequest = useRef(0);
  const searchId = useId();

  useEffect(() => {
    const trimmed = query.trim();
    searchRequest.current += 1;
    const ticket = searchRequest.current;
    if (trimmed.length === 0 || tab === "archived") {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchFiles(trimmed, 20, controller.signal)
        .then((files) => {
          if (ticket === searchRequest.current) setSearchResults(files);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || ticket !== searchRequest.current) return;
          setError(err instanceof Error ? err.message : "Files could not be searched.");
        })
        .finally(() => {
          if (ticket === searchRequest.current) setSearching(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, tab]);

  const files = useMemo(() => {
    const active =
      query.trim() && tab !== "archived"
        ? (searchResults ?? [])
        : tab === "all"
          ? mergeFiles(sources.mine, sources.shared)
          : sources[tab];
    const tabbed =
      tab === "mine"
        ? active.filter((file) => file.owner === loaded.viewerId)
        : tab === "shared"
          ? active.filter((file) => file.owner !== loaded.viewerId)
          : active;
    const named =
      tab === "archived" && query.trim()
        ? tabbed.filter((file) => file.filename.toLowerCase().includes(query.trim().toLowerCase()))
        : tabbed;

    return named
      .filter((file) => currentFolderId === null || file.folderId === currentFolderId)
      .filter((file) => matchesType(file, typeFilter))
      .filter((file) => {
        if (tab !== "all") return true;
        if (ownerFilter === "mine") return file.owner === loaded.viewerId;
        if (ownerFilter === "others") return file.owner !== loaded.viewerId;
        return true;
      })
      .filter((file) => {
        if (accessFilter === "private") {
          return file.owner === loaded.viewerId && (file.sharedWithCount ?? 0) === 0;
        }
        if (accessFilter === "shared") {
          return file.owner !== loaded.viewerId || (file.sharedWithCount ?? 0) > 0;
        }
        return true;
      })
      .filter((file) => {
        if (tab === "shared") return true;
        if (knowledgeFilter === "in") return file.inKnowledge === true;
        if (knowledgeFilter === "out") return file.inKnowledge === false;
        return true;
      })
      .sort(fileComparator(sort));
  }, [
    accessFilter,
    knowledgeFilter,
    loaded.viewerId,
    ownerFilter,
    query,
    searchResults,
    sort,
    sources,
    tab,
    typeFilter,
    currentFolderId,
  ]);

  async function removeFolder(folder: FileFolder) {
    setFolderError(null);
    try {
      await deleteFileFolder(folder.id);
      setFolders((current) => current.filter((candidate) => candidate.id !== folder.id));
    } catch (cause) {
      setFolderError(cause instanceof Error ? cause.message : "That folder could not be deleted.");
    }
  }

  const currentFolder = folders.find((folder) => folder.id === currentFolderId) ?? null;
  const visibleFolders = folders.filter((folder) => folder.parentId === currentFolderId);

  const moreSources: readonly SourceId[] =
    tab === "all" ? ["mine", "shared"] : tab === "archived" ? ["archived"] : [tab];
  const hasMore =
    query.trim().length === 0 && moreSources.some((source) => cursors[source] !== null);

  const narrowing =
    typeFilter !== "all" ||
    ownerFilter !== "all" ||
    accessFilter !== "all" ||
    knowledgeFilter !== "all" ||
    sort !== "modified-desc";

  // Depending on loadMore would re-enter on every render, since it is re-created each time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: paging state alone decides re-entry.
  useEffect(() => {
    if (!narrowing || !hasMore || loading || autoPages >= MAX_AUTO_PAGES) return;
    setAutoPages((count) => count + 1);
    void loadMore();
  }, [narrowing, hasMore, loading, autoPages]);

  useEffect(() => {
    if (!narrowing) setAutoPages(0);
  }, [narrowing]);

  const truncated = narrowing && hasMore && autoPages >= MAX_AUTO_PAGES;

  function updateFile(next: LibraryFile) {
    setSources((current) => ({
      mine: current.mine.map((file) => (file.id === next.id ? next : file)),
      shared: current.shared.map((file) => (file.id === next.id ? next : file)),
      archived: current.archived.map((file) => (file.id === next.id ? next : file)),
    }));
    setSearchResults(
      (current) => current?.map((file) => (file.id === next.id ? next : file)) ?? null
    );
  }

  async function loadMore() {
    const targets = moreSources.filter((source) => cursors[source] !== null);
    if (targets.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const pages = await Promise.all(
        targets.map(async (source) => {
          const options = { limit: PAGE_SIZE, after: cursors[source] };
          const page =
            source === "mine"
              ? await fetchFiles(options)
              : source === "shared"
                ? await fetchSharedWithMe(options)
                : await fetchArchivedFiles(options);
          return { source, page };
        })
      );
      setSources((current) => {
        const next = { ...current };
        for (const { source, page } of pages) next[source] = mergeFiles(next[source], page.files);
        return next;
      });
      setCursors((current) => {
        const next = { ...current };
        for (const { source, page } of pages) next[source] = page.nextCursor;
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Those files could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function toggleKnowledge(file: LibraryFile): Promise<void> {
    if (indexing !== null) return;
    const adding = !file.inKnowledge;
    setIndexing(file.id);
    setError(null);
    updateFile({ ...file, inKnowledge: adding });
    try {
      if (adding) await addFileToKnowledge(file.id);
      else await removeFileFromKnowledge(file.id);
    } catch (err) {
      updateFile({ ...file, inKnowledge: !adding });
      setError(err instanceof Error ? err.message : "That file could not be changed.");
    } finally {
      setIndexing(null);
    }
  }

  async function confirmArchive() {
    if (!archiving) return;
    setMutating(true);
    setError(null);
    try {
      const archived = await archiveFile(archiving.id, archiving.revision ?? 1);
      setSources((current) => ({
        mine: current.mine.filter((file) => file.id !== archiving.id),
        shared: current.shared,
        archived: mergeFiles([archived], current.archived),
      }));
      setSearchResults((current) => current?.filter((file) => file.id !== archiving.id) ?? null);
      setArchiving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be moved to the trash.");
    } finally {
      setMutating(false);
    }
  }

  async function restore(file: LibraryFile) {
    setMutating(true);
    setError(null);
    try {
      const restored = await restoreArchivedFile(file.id, file.revision ?? 1);
      setSources((current) => ({
        mine: mergeFiles([restored], current.mine),
        shared: current.shared,
        archived: current.archived.filter((entry) => entry.id !== file.id),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be restored.");
    } finally {
      setMutating(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setMutating(true);
    setError(null);
    try {
      await deleteFile(deleting.id, deleting.revision ?? 1);
      setSources((current) => ({
        ...current,
        archived: current.archived.filter((file) => file.id !== deleting.id),
      }));
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be deleted.");
    } finally {
      setMutating(false);
    }
  }

  return (
    <PageShell
      title="Files"
      description="Files you can open, share, attach, and add to Knowledge."
      actions={
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreatingFolder(true)}>
            <Plus className="size-3.5" aria-hidden />
            New folder
          </Button>
          <Button type="button" size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="size-3.5" aria-hidden />
            Add file
          </Button>
        </div>
      }
    >
      {currentFolder ? (
        <nav aria-label="Folder path" className="flex items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Files home"
          >
            Files
          </button>
          {folderPath(folders, currentFolder).map((folder) => (
            <span key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.id)}
                className="font-medium text-foreground"
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
      ) : null}
      <FileTabs selected={tab} onSelect={setTab} />

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <label htmlFor={searchId} className="relative min-w-0 flex-1">
          <span className="sr-only">Search filenames</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "archived" ? "Search loaded archived files" : "Search filenames"}
            className="pl-8"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <FilterSelect
            label="File type"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as TypeFilter)}
            options={[
              ["all", "All types"],
              ["images", "Images"],
              ["pdf", "PDF"],
              ["documents", "Documents"],
              ["spreadsheets", "Spreadsheets"],
              ["text", "Text and data"],
            ]}
          />
          {tab === "all" ? (
            <FilterSelect
              label="Owner"
              value={ownerFilter}
              onChange={(value) => setOwnerFilter(value as typeof ownerFilter)}
              options={[
                ["all", "Any owner"],
                ["mine", "Owned by me"],
                ["others", "Owned by others"],
              ]}
            />
          ) : null}
          <FilterSelect
            label="Access"
            value={accessFilter}
            onChange={(value) => setAccessFilter(value as AccessFilter)}
            options={[
              ["all", "Any access"],
              ["private", "Private"],
              ["shared", "Shared"],
            ]}
          />
          {tab !== "shared" ? (
            <FilterSelect
              label="Knowledge"
              value={knowledgeFilter}
              onChange={(value) => setKnowledgeFilter(value as KnowledgeFilter)}
              options={[
                ["all", "Any Knowledge state"],
                ["in", "In Knowledge"],
                ["out", "Not in Knowledge"],
              ]}
            />
          ) : null}
          <FilterSelect
            label="Sort"
            value={sort}
            onChange={(value) => setSort(value as SortId)}
            options={[
              ["modified-desc", "Modified newest"],
              ["modified-asc", "Modified oldest"],
              ["name-asc", "Name A–Z"],
              ["size-desc", "Size largest"],
            ]}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {tab !== "shared" && tab !== "archived" && query.trim().length === 0 ? (
        <FolderGrid
          folders={visibleFolders}
          onOpen={setCurrentFolderId}
          onRename={setRenamingFolder}
          onDelete={(folder) => void removeFolder(folder)}
        />
      ) : null}

      {folderError ? (
        <p role="alert" className="text-sm text-destructive">
          {folderError}
        </p>
      ) : null}

      {truncated ? (
        <p role="status" className="text-sm text-muted-foreground">
          Showing the first {MAX_AUTO_PAGES * PAGE_SIZE} files. Search by name to narrow this
          further.
        </p>
      ) : null}

      {files.length === 0 && !loading && !searching ? (
        <div
          id={`files-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`files-tab-${tab}`}
          className="rounded-lg border border-dashed border-border px-4 py-10 text-center"
        >
          <p className="text-sm font-medium text-foreground">{emptyTitle(tab, query)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{emptyDescription(tab, query)}</p>
        </div>
      ) : (
        <div
          id={`files-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`files-tab-${tab}`}
          className="space-y-3"
          aria-busy={loading || searching}
        >
          <FileList
            files={files}
            viewerId={loaded.viewerId}
            onPreview={setPreviewing}
            onAttach={(file) => navigate(`/?attach=${encodeURIComponent(file.id)}`)}
            onShare={setSharing}
            onKnowledge={(file) => void toggleKnowledge(file)}
            onArchive={setArchiving}
            onMove={setMoving}
            onRestore={(file) => void restore(file)}
            onDelete={setDeleting}
          />
          {hasMore ? (
            <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      )}

      <FilePreview file={previewing} onClose={() => setPreviewing(null)} />
      <FileUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          void fetchFiles({ limit: PAGE_SIZE }).then((page) => {
            setSources((current) => ({ ...current, mine: page.files }));
            setCursors((current) => ({ ...current, mine: page.nextCursor }));
            setTab("mine");
            setQuery("");
          });
        }}
        folderId={currentFolderId}
      />
      <CreateFolderDialog
        open={creatingFolder}
        parentId={currentFolderId}
        onClose={() => setCreatingFolder(false)}
        onCreate={async (name) => {
          const folder = await createFileFolder(name, currentFolderId);
          setFolders((current) => [...current, folder]);
          setCreatingFolder(false);
        }}
      />
      <CreateFolderDialog
        open={renamingFolder !== null}
        parentId={renamingFolder?.parentId ?? null}
        initialName={renamingFolder?.name ?? ""}
        title="Rename folder"
        submitLabel="Rename"
        onClose={() => setRenamingFolder(null)}
        onCreate={async (name) => {
          if (renamingFolder === null) return;
          const renamed = await renameFileFolder(renamingFolder.id, name);
          setFolders((current) =>
            current.map((folder) => (folder.id === renamed.id ? renamed : folder))
          );
          setRenamingFolder(null);
        }}
      />
      <MoveFileDialog
        file={moving}
        folders={folders}
        onClose={() => setMoving(null)}
        onMove={async (folderId) => {
          if (!moving) return;
          const moved = await moveFile(moving.id, folderId, moving.revision ?? 1);
          updateFile(moved);
          setMoving(null);
        }}
      />
      <ShareDialog file={sharing} onClose={() => setSharing(null)} />
      <ConfirmModal
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        onConfirm={() => void confirmArchive()}
        title={`Move ${archiving?.filename ?? "this file"} to the trash?`}
        description="It leaves active lists and new Chat attachments. Existing readers can still open it. You can restore it later."
        confirmLabel="Move to trash"
        busy={mutating}
      />
      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title={`Delete ${deleting?.filename ?? "this file"} permanently?`}
        description="The file and every version are erased for good. This cannot be undone."
        confirmLabel="Delete permanently"
        busy={mutating}
      />
    </PageShell>
  );
}

function FolderGrid({
  folders,
  onOpen,
  onRename,
  onDelete,
}: {
  readonly folders: readonly FileFolder[];
  readonly onOpen: (id: string) => void;
  readonly onRename: (folder: FileFolder) => void;
  readonly onDelete: (folder: FileFolder) => void;
}) {
  if (folders.length === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {folders.map((folder) => (
        <div
          key={folder.id}
          className="group flex min-w-0 items-center gap-1 rounded-lg border border-border bg-card pr-1 transition-colors hover:bg-muted/60"
        >
          <button
            type="button"
            aria-label={`Open ${folder.name}`}
            onClick={() => onOpen(folder.id)}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate text-sm font-medium">{folder.name}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Rename ${folder.name}`}
            onClick={() => onRename(folder)}
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Pencil className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${folder.name}`}
            onClick={() => onDelete(folder)}
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}

function CreateFolderDialog({
  open,
  parentId,
  initialName,
  title,
  submitLabel,
  onClose,
  onCreate,
}: {
  readonly open: boolean;
  readonly parentId: string | null;
  readonly initialName?: string;
  readonly title?: string;
  readonly submitLabel?: string;
  readonly onClose: () => void;
  readonly onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reopening for a different folder must not offer the previous one's name.
    if (open) setName(initialName ?? "");
    else setError(null);
  }, [open, initialName]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That folder could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? (parentId ? "New subfolder" : "New folder")}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Folder name</span>
        <Input
          aria-label="Folder name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void create()}
          disabled={busy || name.trim().length === 0}
        >
          {submitLabel ?? "Create"}
        </Button>
      </div>
    </Modal>
  );
}

function MoveFileDialog({
  file,
  folders,
  onClose,
  onMove,
}: {
  readonly file: LibraryFile | null;
  readonly folders: readonly FileFolder[];
  readonly onClose: () => void;
  readonly onMove: (folderId: string | null) => Promise<void>;
}) {
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDestination(file?.folderId ?? "");
    setError(null);
  }, [file]);

  async function move() {
    setBusy(true);
    setError(null);
    try {
      await onMove(destination || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That file could not be moved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={file !== null} onClose={onClose} title={`Move ${file?.filename ?? "file"}`}>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Destination folder</span>
        <Select
          aria-label="Destination folder"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
        >
          <option value="">Files home</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folderLabel(folders, folder)}
            </option>
          ))}
        </Select>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void move()} disabled={busy}>
          Move
        </Button>
      </div>
    </Modal>
  );
}

function folderPath(folders: readonly FileFolder[], folder: FileFolder): readonly FileFolder[] {
  const path: FileFolder[] = [folder];
  let parentId = folder.parentId;
  while (parentId !== null) {
    const parent = folders.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    path.unshift(parent);
    parentId = parent.parentId;
  }
  return path;
}

function folderLabel(folders: readonly FileFolder[], folder: FileFolder): string {
  return folderPath(folders, folder)
    .map((part) => part.name)
    .join(" / ");
}

function FileTabs({
  selected,
  onSelect,
}: {
  readonly selected: TabId;
  readonly onSelect: (tab: TabId) => void;
}) {
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement>>>({});
  return (
    <div
      role="tablist"
      aria-label="Files view"
      className="inline-flex max-w-full self-start items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-muted p-0.5"
    >
      {TABS.map((tab, index) => (
        <button
          key={tab.id}
          id={`files-tab-${tab.id}`}
          ref={(node) => {
            refs.current[tab.id] = node ?? undefined;
          }}
          type="button"
          role="tab"
          aria-selected={selected === tab.id}
          aria-controls={`files-panel-${tab.id}`}
          tabIndex={selected === tab.id ? 0 : -1}
          className={cn(
            "inline-flex h-6 shrink-0 items-center rounded-sm px-2.5 text-sm font-medium transition-[color,background-color] pointer-coarse:h-7",
            selected === tab.id
              ? "bg-raised text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            let nextIndex: number | null = null;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
            if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = TABS.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = TABS[nextIndex];
            if (!next) return;
            onSelect(next.id);
            refs.current[next.id]?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<readonly [string, string]>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );
}

function mergeFiles(...groups: ReadonlyArray<readonly LibraryFile[]>): readonly LibraryFile[] {
  const byId = new Map<string, LibraryFile>();
  for (const group of groups) {
    for (const file of group) byId.set(file.id, file);
  }
  return [...byId.values()].sort(fileComparator("modified-desc"));
}

function fileComparator(sort: SortId): (left: LibraryFile, right: LibraryFile) => number {
  if (sort === "name-asc") {
    return (left, right) => left.filename.localeCompare(right.filename);
  }
  if (sort === "size-desc") {
    return (left, right) => right.sizeBytes - left.sizeBytes;
  }
  return (left, right) => {
    const difference =
      Date.parse(left.modifiedAt ?? left.createdAt) -
      Date.parse(right.modifiedAt ?? right.createdAt);
    return sort === "modified-asc" ? difference : -difference;
  };
}

function matchesType(file: LibraryFile, filter: TypeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "images") return file.mediaType.startsWith("image/");
  if (filter === "pdf") return file.mediaType === "application/pdf";
  if (filter === "documents") {
    return file.mediaType.includes("wordprocessingml") || file.mediaType === "application/msword";
  }
  if (filter === "spreadsheets") {
    return file.mediaType.includes("spreadsheetml") || file.mediaType === "text/csv";
  }
  return (
    file.mediaType.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml"].includes(file.mediaType)
  );
}

function emptyTitle(tab: TabId, query: string): string {
  if (query.trim()) return "No matching files";
  if (tab === "shared") return "Nothing shared with you";
  if (tab === "archived") return "No archived files";
  return "No files yet";
}

function emptyDescription(tab: TabId, query: string): string {
  if (query.trim()) return "Try another filename or clear a filter.";
  if (tab === "shared") return "Files shared directly with you or a role you hold appear here.";
  if (tab === "archived") return "Files you archive appear here until you restore or delete them.";
  return "Upload a file or attach one in Chat to add it to your library.";
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="files" status={status} message={message} />;
}
