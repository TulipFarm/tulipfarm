import { Link } from "@remix-run/react";
import { Bot, Download, FileText, ImageIcon, MessageSquare, Paperclip, Upload } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { fetchFileObjectUrl, formatFileSize, type LibraryFile } from "~/lib/files";
import { isPreviewable } from "./file-preview";

/**
 * One shape rather than a grid/table toggle.
 *
 * The library holds screenshots and documents together, and only a row can carry size, origin and
 * source Chat. A grid would show the images well and reduce every PDF to an identical rectangle,
 * so the row wins and carries a thumbnail where one is meaningful.
 */
export function FileList({
  files,
  viewerId,
  onPreview,
  onAttach,
}: {
  files: readonly LibraryFile[];
  viewerId: string;
  onPreview: (file: LibraryFile) => void;
  onAttach?: (file: LibraryFile) => void;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
      {files.map((file) => (
        <li key={file.id}>
          <FileRow file={file} viewerId={viewerId} onPreview={onPreview} onAttach={onAttach} />
        </li>
      ))}
    </ul>
  );
}

function FileRow({
  file,
  viewerId,
  onPreview,
  onAttach,
}: {
  file: LibraryFile;
  viewerId: string;
  onPreview: (file: LibraryFile) => void;
  onAttach?: (file: LibraryFile) => void;
}) {
  const isImage = file.mediaType.startsWith("image/");
  const Icon = isImage ? ImageIcon : FileText;
  const previewable = isPreviewable(file.mediaType);

  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {previewable ? (
            <button
              type="button"
              onClick={() => onPreview(file)}
              className="min-w-0 max-w-full cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground transition-colors hover:text-primary"
            >
              {file.filename}
            </button>
          ) : (
            <span className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">
              {file.filename}
            </span>
          )}
          <OriginBadge origin={file.origin} />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>{file.mediaType}</span>
          <span aria-hidden>·</span>
          <span>{formatFileSize(file.sizeBytes)}</span>
          <span aria-hidden>·</span>
          <span>{file.owner === viewerId ? "you" : file.owner}</span>
          <span aria-hidden>·</span>
          <time dateTime={file.createdAt}>{formatDate(file.createdAt)}</time>
          {file.sourceChatId ? (
            <>
              <span aria-hidden>·</span>
              <Link
                to={`/chat/${encodeURIComponent(file.sourceChatId)}`}
                className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
              >
                <MessageSquare className="size-3" aria-hidden />
                from a chat
              </Link>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onAttach ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAttach(file)}
            aria-label={`Attach ${file.filename} to a new chat`}
          >
            <Paperclip className="size-3.5" aria-hidden />
            Attach
          </Button>
        ) : null}
        <DownloadButton file={file} />
      </div>
    </div>
  );
}

/**
 * Who made this File.
 *
 * An icon and a word, not a tint: whether an Agent wrote a document is exactly the kind of fact a
 * person must not have to distinguish two shades of grey to read.
 */
function OriginBadge({ origin }: { origin: LibraryFile["origin"] }) {
  if (origin === "generated") {
    return (
      <Badge variant="info">
        <Bot className="size-3" aria-hidden />
        Agent-generated
      </Badge>
    );
  }
  return (
    <Badge variant="neutral">
      <Upload className="size-3" aria-hidden />
      Uploaded
    </Badge>
  );
}

/**
 * The bytes, fetched on click.
 *
 * A plain `href` would not carry the session across origins and cannot carry a bearer token, so
 * the click authenticates the request and hands the browser a blob.
 */
function DownloadButton({ file }: { file: LibraryFile }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const url = await fetchFileObjectUrl(file.id);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // A File that has since been deleted, or a session that has expired, both land here. Saying
      // nothing would look exactly like a download the browser handled quietly.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          Download failed
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={download}
        aria-label={`Download ${file.filename}`}
      >
        <Download className="size-3.5" aria-hidden />
        {busy ? "…" : "Download"}
      </Button>
    </>
  );
}

function formatDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
