import { isExtractableMediaType } from "@tulipfarm/files/limits";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Download,
  FileX2,
  FolderInput,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  Share2,
  Trash2,
} from "~/components/icons";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip } from "~/components/ui/tooltip";
import { fetchFileObjectUrl, formatFileSize, type LibraryFile } from "~/lib/files";
import { FileTypeIcon } from "./file-type-icon";

export interface FileListActions {
  readonly onPreview?: (file: LibraryFile) => void;
  readonly onAttach?: (file: LibraryFile) => void;
  readonly onShare?: (file: LibraryFile) => void;
  readonly onKnowledge?: (file: LibraryFile) => void;
  readonly onArchive?: (file: LibraryFile) => void;
  readonly onMove?: (file: LibraryFile) => void;
  readonly onRestore?: (file: LibraryFile) => void;
  readonly onDelete?: (file: LibraryFile) => void;
}

/** The dense, semantic Files library table. */
export function FileList({
  files,
  viewerId,
  ...actions
}: {
  readonly files: readonly LibraryFile[];
  readonly viewerId: string;
} & FileListActions) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="border-b border-border bg-muted/70 px-3 py-1.5 text-start text-xs font-medium text-muted-foreground"
            >
              Name
            </th>
            <th
              scope="col"
              className="border-b border-border bg-muted/70 px-3 py-1.5 text-start text-xs font-medium text-muted-foreground"
            >
              Owner
            </th>
            <th
              scope="col"
              className="border-b border-border bg-muted/70 px-3 py-1.5 text-start text-xs font-medium text-muted-foreground"
            >
              Access
            </th>
            <th
              scope="col"
              className="border-b border-border bg-muted/70 px-3 py-1.5 text-start text-xs font-medium text-muted-foreground"
            >
              Modified
            </th>
            <th
              scope="col"
              className="border-b border-border bg-muted/70 px-3 py-1.5 text-end text-xs font-medium text-muted-foreground"
            >
              Size
            </th>
            <th
              scope="col"
              className="w-20 border-b border-border bg-muted/70 px-3 py-1.5 text-end text-xs font-medium text-muted-foreground"
            >
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
          {files.map((file) => (
            <FileRow key={file.id} file={file} viewerId={viewerId} {...actions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileRow({
  file,
  viewerId,
  ...actions
}: {
  readonly file: LibraryFile;
  readonly viewerId: string;
} & FileListActions) {
  const owned = file.owner === viewerId;
  const ownerName = file.ownerName ?? (owned ? "You" : file.owner);
  const accessLabel = owned
    ? file.sharedWithCount
      ? `Shared with ${file.sharedWithCount}`
      : "Private"
    : "Shared with you";
  const preview = () => actions.onPreview?.(file);
  const previewCell =
    "block w-full rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <tr className="group transition-colors hover:bg-muted/60">
      <td className="max-w-[28rem] px-3 py-2">
        <button
          type="button"
          aria-label={`Preview ${file.filename}`}
          onClick={preview}
          className={`${previewCell} min-w-0`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
              <FileTypeIcon mediaType={file.mediaType} filename={file.filename} />
            </span>
            <span className="truncate font-medium text-foreground underline-offset-4 group-hover:underline">
              {file.filename}
            </span>
            {file.inKnowledge ? (
              <span
                title="In Knowledge"
                className="inline-flex shrink-0 items-center text-status-info"
              >
                <BookOpen className="size-3.5" aria-hidden />
                <span className="sr-only">In Knowledge</span>
              </span>
            ) : null}
          </span>
        </button>
      </td>
      <td className="max-w-48 px-3 py-2 text-xs text-muted-foreground">
        <Tooltip content={ownerName}>
          <button
            type="button"
            aria-label={`Owner: ${ownerName}`}
            onClick={preview}
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Avatar identity={ownerName} />
          </button>
        </Tooltip>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <button type="button" onClick={preview} className={previewCell}>
          <Badge
            variant={owned && !file.sharedWithCount ? "neutral" : "info"}
            className={
              owned && !file.sharedWithCount
                ? "border-border bg-secondary text-secondary-foreground"
                : "border-status-info/30"
            }
          >
            {accessLabel}
          </Badge>
        </button>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
        <button type="button" onClick={preview} className={previewCell}>
          <time
            dateTime={file.modifiedAt ?? file.createdAt}
            title={new Date(file.modifiedAt ?? file.createdAt).toLocaleString()}
          >
            {formatDate(file.modifiedAt ?? file.createdAt)}
          </time>
        </button>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-end text-xs tabular-nums text-muted-foreground">
        <button type="button" onClick={preview} className={`${previewCell} text-end`}>
          {formatFileSize(file.sizeBytes)}
        </button>
      </td>
      <td className="px-3 py-1.5">
        <FileActionsMenu file={file} owned={owned} {...actions} />
      </td>
    </tr>
  );
}

function FileActionsMenu({
  file,
  owned,
  onAttach,
  onShare,
  onKnowledge,
  onArchive,
  onMove,
  onRestore,
  onDelete,
}: {
  readonly file: LibraryFile;
  readonly owned: boolean;
} & FileListActions) {
  const archived = file.archivedAt != null;
  const indexable = isExtractableMediaType(file.mediaType);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (!open && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen((current) => !current);
  }

  function choose(action: (file: LibraryFile) => void) {
    return () => {
      setOpen(false);
      action(file);
    };
  }

  async function download() {
    setOpen(false);
    setDownloadFailed(false);
    try {
      await downloadFile(file);
    } catch {
      setDownloadFailed(true);
    }
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary";

  return (
    <div className="flex justify-end">
      {downloadFailed ? (
        <span role="alert" className="sr-only">
          Download failed
        </span>
      ) : null}
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${file.filename}`}
        onClick={toggle}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </Button>
      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={`Actions for ${file.filename}`}
              className="fixed z-50 w-56 rounded-md border border-border bg-card p-1 shadow-lg"
              style={{ top: rect.bottom + 4, right: window.innerWidth - rect.right }}
            >
              {onAttach && !archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={choose(onAttach)}
                >
                  <Paperclip className="size-4" aria-hidden />
                  Attach to chat
                </button>
              ) : null}
              {onShare && owned && !archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={choose(onShare)}
                >
                  <Share2 className="size-4" aria-hidden />
                  Share
                </button>
              ) : null}
              {onKnowledge && owned && indexable && !archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={choose(onKnowledge)}
                >
                  <BookOpen className="size-4" aria-hidden />
                  {file.inKnowledge ? "Remove from Knowledge" : "Add to Knowledge"}
                </button>
              ) : null}
              <button type="button" role="menuitem" className={itemClass} onClick={download}>
                <Download className="size-4" aria-hidden />
                Download
              </button>
              {onMove && owned && !archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={choose(onMove)}
                >
                  <FolderInput className="size-4" aria-hidden />
                  Move
                </button>
              ) : null}
              {onArchive && owned && !archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={choose(onArchive)}
                >
                  <FileX2 className="size-4" aria-hidden />
                  Archive
                </button>
              ) : null}
              {onRestore && owned && archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={choose(onRestore)}
                >
                  <RotateCcw className="size-4" aria-hidden />
                  Restore
                </button>
              ) : null}
              {onDelete && owned && archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={`${itemClass} text-destructive hover:bg-destructive/10`}
                  onClick={choose(onDelete)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Delete permanently
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

async function downloadFile(file: Pick<LibraryFile, "id" | "filename">): Promise<void> {
  const url = await fetchFileObjectUrl(file.id);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Authenticated download: a normal link cannot carry the optional bearer token. */
export function DownloadButton({
  file,
  fetchUrl,
  label = false,
}: {
  readonly file: Pick<LibraryFile, "id" | "filename">;
  readonly fetchUrl?: () => Promise<string>;
  readonly label?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      if (fetchUrl) {
        const url = await fetchUrl();
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.filename;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        await downloadFile(file);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {failed ? (
        <span role="alert" className="sr-only">
          Download failed
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        onClick={download}
        aria-label={`${failed ? "Download failed. Retry downloading" : "Download"} ${file.filename}`}
      >
        <Download className="size-3.5" aria-hidden />
        {label ? (busy ? "Downloading…" : "Download") : null}
      </Button>
    </>
  );
}

function formatDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
