import { X } from "~/components/icons";
import type { Attachment } from "./use-attachments";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The staged attachments, shown between the editor and its toolbar.
 *
 * Every chip is removable in every state, including mid-upload — the remove button is what cancels
 * an upload, so there is no separate cancel control to find.
 */
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: readonly Attachment[];
  onRemove: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-2 px-2 pb-1.5">
      {attachments.map((attachment) => (
        <li
          className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${
            attachment.status === "error"
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : "border-border bg-secondary text-foreground"
          }`}
          key={attachment.localId}
        >
          <span className="max-w-[12rem] truncate font-medium">{attachment.name}</span>
          <span className="text-muted-foreground">
            {attachment.status === "uploading"
              ? `${Math.round(attachment.progress * 100)}%`
              : attachment.status === "error"
                ? attachment.error
                : formatSize(attachment.sizeBytes)}
          </span>
          {attachment.status === "uploading" ? (
            <progress
              aria-label={`Uploading ${attachment.name}`}
              className="h-1 w-12"
              max={1}
              value={attachment.progress}
            />
          ) : null}
          <button
            aria-label={
              attachment.status === "uploading"
                ? `Cancel upload of ${attachment.name}`
                : `Remove ${attachment.name}`
            }
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onRemove(attachment.localId)}
            type="button"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
