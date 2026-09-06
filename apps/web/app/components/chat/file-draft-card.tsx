import { useState } from "react";
import { FileTypeIcon } from "~/components/files/file-type-icon";
import { Download, Eye, FolderInput } from "~/components/icons";
import { Link } from "~/components/ui/link";
import { Modal } from "~/components/ui/modal";
import type { TimelinePart } from "~/lib/chat/types";
import { fetchFileDraftObjectUrl, fetchFileDraftText, saveFileDraft } from "~/lib/files";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

export interface FileDraftResult {
  readonly status: "draft";
  readonly draftId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly expiresAt: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unwrap(value: unknown): Record<string, unknown> | undefined {
  const record = objectValue(value);
  if (record === undefined) return undefined;
  for (const key of ["data", "output", "result"]) {
    const nested = objectValue(record[key]);
    if (nested !== undefined) return nested;
  }
  return record;
}

export function fileDraftOf(part: ToolPart): FileDraftResult | undefined {
  if (part.toolName !== "file_create" || part.status !== "done" || part.outcome === "error") {
    return undefined;
  }
  let value = part.result;
  if (part.resultPreview !== undefined) {
    try {
      value = JSON.parse(part.resultPreview.json);
    } catch {
      return undefined;
    }
  }
  const result = unwrap(value);
  if (
    result?.status !== "draft" ||
    typeof result.draftId !== "string" ||
    typeof result.filename !== "string" ||
    typeof result.mediaType !== "string" ||
    typeof result.sizeBytes !== "number" ||
    typeof result.expiresAt !== "string"
  ) {
    return undefined;
  }
  return result as unknown as FileDraftResult;
}

export function FileDraftCard({
  draft,
  onRevise,
}: {
  readonly draft: FileDraftResult;
  readonly onRevise?: (draft: FileDraftResult) => void;
}) {
  const [state, setState] = useState<
    | { kind: "ready" }
    | { kind: "downloading" }
    | { kind: "previewing" }
    | { kind: "saving" }
    | { kind: "saved"; fileId: string }
    | { kind: "error"; message: string }
  >({ kind: "ready" });
  const [preview, setPreview] = useState<string | null>(null);
  const canPreview =
    draft.mediaType.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml"].includes(draft.mediaType);
  const expired = Date.parse(draft.expiresAt) <= Date.now();

  async function download() {
    setState({ kind: "downloading" });
    try {
      const url = await fetchFileDraftObjectUrl(draft.draftId);
      const link = document.createElement("a");
      link.href = url;
      link.download = draft.filename;
      link.click();
      URL.revokeObjectURL(url);
      setState({ kind: "ready" });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "That draft could not be downloaded.",
      });
    }
  }

  async function save() {
    setState({ kind: "saving" });
    try {
      const file = await saveFileDraft(draft.draftId);
      setState({ kind: "saved", fileId: file.id });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "That draft could not be saved.",
      });
    }
  }

  async function openPreview() {
    setState({ kind: "previewing" });
    try {
      setPreview(await fetchFileDraftText(draft.draftId));
      setState({ kind: "ready" });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "That draft could not be previewed.",
      });
    }
  }

  return (
    <section
      aria-label={`Generated draft ${draft.filename}`}
      className="ml-6 mt-2 rounded-md border border-border bg-card px-3 py-3"
    >
      <div className="flex items-start gap-2">
        <FileTypeIcon mediaType={draft.mediaType} filename={draft.filename} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{draft.filename}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {expired
              ? "Draft expired."
              : `Draft only. It expires ${new Date(draft.expiresAt).toLocaleString()}.`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Download it to review. Save it to keep it. To revise it, tell the Agent what to change.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canPreview ? (
          <button
            type="button"
            onClick={() => void openPreview()}
            disabled={expired || state.kind === "previewing" || state.kind === "saving"}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition hover:bg-accent disabled:opacity-50"
          >
            <Eye aria-hidden className="size-4" />
            {state.kind === "previewing" ? "Loading…" : "Preview"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void download()}
          disabled={
            expired ||
            state.kind === "downloading" ||
            state.kind === "previewing" ||
            state.kind === "saving"
          }
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition hover:bg-accent disabled:opacity-50"
        >
          <Download aria-hidden className="size-4" />
          {state.kind === "downloading" ? "Downloading…" : "Download"}
        </button>
        {state.kind === "saved" ? (
          <Link
            to={`/files/${state.fileId}`}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            <FolderInput aria-hidden className="size-4" />
            Open saved file
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => void save()}
            disabled={
              expired ||
              state.kind === "saving" ||
              state.kind === "downloading" ||
              state.kind === "previewing"
            }
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            <FolderInput aria-hidden className="size-4" />
            {state.kind === "saving" ? "Saving…" : "Save File"}
          </button>
        )}
        {onRevise === undefined ? null : (
          <button
            type="button"
            onClick={() => onRevise(draft)}
            disabled={
              state.kind === "saving" || state.kind === "downloading" || state.kind === "previewing"
            }
            className="inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            Revise
          </button>
        )}
      </div>
      {state.kind === "error" ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
      {preview === null ? null : (
        <Modal open onClose={() => setPreview(null)} title={draft.filename} className="max-w-3xl">
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-4 text-sm">
            {preview}
          </pre>
        </Modal>
      )}
    </section>
  );
}
