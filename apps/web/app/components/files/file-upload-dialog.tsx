import { ALLOWED_MEDIA_TYPES, MAX_FILE_BYTES, uploadMediaType } from "@tulipfarm/files/limits";
import { useEffect, useId, useRef, useState } from "react";
import { FileTypeIcon } from "~/components/files/file-type-icon";
import { Link2, Loader2, Trash2, Upload, UserRound, UsersRound } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Select } from "~/components/ui/select";
import { type FileGrantee, formatFileSize, shareFile, uploadFile } from "~/lib/files";
import { cn } from "~/lib/utils";

type UploadSource = "upload" | "link" | "drive";
const MAX_UPLOAD_FILES = 10;
const FILE_PICKER_ACCEPT = [
  ...ALLOWED_MEDIA_TYPES,
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".pdf",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".docx",
  ".xlsx",
  ".pptx",
].join(",");

const SOURCES: ReadonlyArray<{
  id: UploadSource;
  label: string;
  disabled?: boolean;
}> = [
  { id: "upload", label: "Upload" },
  { id: "link", label: "File Link" },
  { id: "drive", label: "Google Drive", disabled: true },
];

export function FileUploadDialog({
  open,
  onClose,
  onUploaded,
  folderId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUploaded: () => void;
  readonly folderId?: string | null;
}) {
  const [source, setSource] = useState<UploadSource>("upload");
  const [selected, setSelected] = useState<readonly File[]>([]);
  const [filenames, setFilenames] = useState<readonly string[]>([]);
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [shares, setShares] = useState<readonly FileGrantee[]>([]);
  const [shareKind, setShareKind] = useState<FileGrantee["kind"]>("user");
  const [shareId, setShareId] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadedIds, setUploadedIds] = useState<readonly (string | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const tabRefs = useRef<Partial<Record<UploadSource, HTMLButtonElement>>>({});
  const nameId = useId();
  const urlId = useId();
  const shareKindId = useId();
  const shareIdId = useId();

  useEffect(() => {
    if (open) return;
    setSource("upload");
    setSelected([]);
    setFilenames([]);
    setUrl("");
    setFilename("");
    setShares([]);
    setShareKind("user");
    setShareId("");
    setProgress(0);
    setUploadedIds([]);
    setError(null);
    setDragActive(false);
    dragDepth.current = 0;
  }, [open]);

  function choose(files: readonly File[]) {
    setError(null);
    if (files.length > MAX_UPLOAD_FILES) {
      setSelected([]);
      setFilenames([]);
      setFilename("");
      setUploadedIds([]);
      setError(`You can upload up to ${MAX_UPLOAD_FILES} files at once.`);
      return;
    }
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is larger than ${formatFileSize(MAX_FILE_BYTES)}.`);
        return;
      }
      // A file the browser could not type and whose name does not name it either is left to the
      // server's byte sniffer, which is the authority. Refusing here rejects files it would take.
      if (file.type !== "" && uploadMediaType(file.type, file.name) === null) {
        setError(`${file.name} is not a supported file type.`);
        return;
      }
    }
    setSelected(files);
    setFilenames(files.map((file) => file.name));
    setFilename(files.length === 1 ? (files[0]?.name ?? "") : "");
    setUploadedIds([]);
  }

  function openPicker() {
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  function removeSelected(index: number) {
    const nextFiles = selected.filter((_, selectedIndex) => selectedIndex !== index);
    const nextNames = filenames.filter((_, selectedIndex) => selectedIndex !== index);
    setSelected(nextFiles);
    setFilenames(nextNames);
    setFilename(nextFiles.length === 1 ? (nextNames[0] ?? "") : "");
    setUploadedIds([]);
  }

  function addShare() {
    const id = shareId.trim();
    if (id.length === 0) return;
    if (shares.some((share) => share.kind === shareKind && share.id === id)) return;
    setShares((current) => [...current, { kind: shareKind, id }]);
    setShareId("");
  }

  async function resolveFiles(): Promise<readonly File[]> {
    if (source === "upload") {
      if (selected.length === 0) throw new Error("Choose at least one file.");
      return selected;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Use an HTTP or HTTPS file link.");
    }
    let response: Response;
    try {
      response = await fetch(parsed, { credentials: "omit" });
    } catch {
      throw new Error("That link could not be downloaded. It may block browser downloads.");
    }
    if (!response.ok) throw new Error("That link could not be downloaded.");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_FILE_BYTES) {
      throw new Error(`That file is larger than ${formatFileSize(MAX_FILE_BYTES)}.`);
    }
    const blob = await response.blob();
    if (blob.size > MAX_FILE_BYTES) {
      throw new Error(`That file is larger than ${formatFileSize(MAX_FILE_BYTES)}.`);
    }
    const resolvedName = filename || nameFromUrl(parsed);
    if (blob.type !== "" && uploadMediaType(blob.type, resolvedName) === null) {
      throw new Error("That link does not point to a supported file type.");
    }
    return [
      new File([blob], resolvedName, {
        type: blob.type || "application/octet-stream",
      }),
    ];
  }

  async function submit() {
    const names = source === "upload" ? filenames.map((name) => name.trim()) : [filename.trim()];
    if (names.some((name) => name.length === 0)) {
      setError("Give every file a name.");
      return;
    }
    setBusy(true);
    setError(null);
    const count = source === "upload" ? selected.length : 1;
    const ids = Array.from({ length: count }, (_, index) => uploadedIds[index] ?? null);
    let uploadsCompleted = ids.every((id) => id !== null);
    try {
      const files = uploadsCompleted ? [] : await resolveFiles();
      for (let index = 0; index < count; index += 1) {
        if (ids[index] !== null) continue;
        const file = files[index];
        const name = names[index];
        if (!file || !name) throw new Error("That file could not be prepared.");
        const uploaded = await uploadFile(
          file,
          (fraction) => setProgress((index + fraction) / count),
          name,
          folderId ?? undefined
        ).done;
        ids[index] = uploaded.id;
        setUploadedIds([...ids]);
      }
      uploadsCompleted = true;
      for (const fileId of ids) {
        if (fileId === null) continue;
        for (const share of shares) await shareFile(fileId, share);
      }
      onUploaded();
      onClose();
    } catch (cause) {
      setError(
        !uploadsCompleted
          ? cause instanceof Error
            ? cause.message
            : "Those files could not be uploaded."
          : "The files were uploaded, but their sharing access could not be saved. Check the access ids and try again."
      );
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    (source === "upload"
      ? selected.length > 0 && filenames.every((name) => name.trim().length > 0)
      : filename.trim().length > 0 && url.trim().length > 0);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add a file"
      className="max-w-xl"
    >
      <div className="flex flex-col gap-5">
        <div role="tablist" aria-label="File source" className="flex border-b border-border">
          {SOURCES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`file-source-tab-${item.id}`}
              aria-controls={`file-source-panel-${item.id}`}
              aria-selected={source === item.id}
              disabled={item.disabled}
              tabIndex={source === item.id ? 0 : -1}
              ref={(node) => {
                tabRefs.current[item.id] = node ?? undefined;
              }}
              onClick={() => setSource(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const next = source === "upload" ? "link" : "upload";
                setSource(next);
                tabRefs.current[next]?.focus();
              }}
              className={cn(
                "-mb-px flex min-h-9 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-[color,border-color]",
                source === item.id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
                item.disabled && "cursor-not-allowed text-muted-foreground"
              )}
            >
              {item.label}
              {item.disabled ? <Badge variant="warning">Coming soon</Badge> : null}
            </button>
          ))}
        </div>

        {source === "upload" ? (
          <div
            id="file-source-panel-upload"
            role="tabpanel"
            aria-labelledby="file-source-tab-upload"
            className="flex flex-col gap-3"
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={FILE_PICKER_ACCEPT}
              className="sr-only"
              // The drop zone below is the labelled control assistive tech should meet; this input
              // only exists to open the picker, so it stays out of the tab order and the a11y tree.
              tabIndex={-1}
              aria-hidden
              data-testid="file-picker-input"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                if (files.length > 0) choose(files);
              }}
            />
            <button
              type="button"
              onClick={openPicker}
              onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                dragDepth.current += 1;
                setDragActive(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dragDepth.current = 0;
                setDragActive(false);
                const files = Array.from(event.dataTransfer.files);
                if (files.length > 0) choose(files);
              }}
              className={cn(
                "flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 text-center transition-[background-color,border-color]",
                dragActive
                  ? "border-foreground bg-muted/70"
                  : "border-border bg-muted/30 hover:border-foreground/30 hover:bg-muted/50"
              )}
            >
              <span className="flex items-end -space-x-1.5" aria-hidden>
                <span className="flex size-8 rotate-[-8deg] items-center justify-center rounded-md border border-border bg-card shadow-xs">
                  <FileTypeIcon mediaType="application/pdf" filename="file.pdf" />
                </span>
                <span className="z-10 flex size-9 items-center justify-center rounded-full bg-foreground text-background shadow-sm">
                  <Upload className="size-4" />
                </span>
                <span className="flex size-8 rotate-[8deg] items-center justify-center rounded-md border border-border bg-card shadow-xs">
                  <FileTypeIcon mediaType="text/csv" filename="file.csv" />
                </span>
              </span>
              <span className="font-medium text-foreground">
                {dragActive
                  ? "Drop the files here"
                  : selected.length > 0
                    ? "Drop another file, or choose one"
                    : "Drag and drop files, or choose them"}
              </span>
              <span className="text-xs text-muted-foreground">
                Up to {MAX_UPLOAD_FILES} files · {formatFileSize(MAX_FILE_BYTES)} each
              </span>
            </button>
            {selected.length > 0 ? (
              <ul className="flex max-h-52 flex-col gap-2 overflow-y-auto">
                {selected.map((file, index) => (
                  <li
                    key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
                    className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <FileTypeIcon mediaType={file.type} filename={file.name} />
                    </span>
                    <div className="min-w-0 flex-1">
                      {selected.length === 1 ? (
                        <p className="truncate text-sm font-medium">{file.name}</p>
                      ) : (
                        <Input
                          aria-label={`File name for ${file.name}`}
                          value={filenames[index] ?? ""}
                          onChange={(event) =>
                            setFilenames((current) =>
                              current.map((name, nameIndex) =>
                                nameIndex === index ? event.target.value : name
                              )
                            )
                          }
                        />
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {file.type || "Type detected after upload"} · {formatFileSize(file.size)}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => removeSelected(index)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {source === "link" ? (
          <div
            id="file-source-panel-link"
            role="tabpanel"
            aria-labelledby="file-source-tab-link"
            className="flex flex-col gap-2"
          >
            <label htmlFor={urlId} className="text-xs font-medium text-muted-foreground">
              Public file link
            </label>
            <div className="relative">
              <Link2
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id={urlId}
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                }}
                onBlur={() => {
                  if (filename.length > 0) return;
                  try {
                    setFilename(nameFromUrl(new URL(url)));
                  } catch {
                    // The field validation below handles incomplete URLs on submit.
                  }
                }}
                placeholder="https://example.com/report.pdf"
                className="pl-8"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The link must be public and allow browser downloads.
            </p>
          </div>
        ) : null}

        {source === "link" || selected.length <= 1 ? (
          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
                File name
              </label>
              <Input
                id={nameId}
                value={source === "upload" ? (filenames[0] ?? "") : filename}
                onChange={(event) => {
                  setFilename(event.target.value);
                  if (source === "upload") setFilenames([event.target.value]);
                }}
                placeholder="quarterly-report.pdf"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Owner</span>
              <div className="flex h-7 items-center rounded-md border border-input bg-muted/30 px-2.5 text-sm">
                You
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Share access</span>
          <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
            <Select
              id={shareKindId}
              aria-label="Share target type"
              value={shareKind}
              onChange={(event) => setShareKind(event.target.value as FileGrantee["kind"])}
            >
              <option value="user">Person</option>
              <option value="role">Role</option>
            </Select>
            <Input
              id={shareIdId}
              aria-label={shareKind === "user" ? "Person principal id" : "Role id"}
              value={shareId}
              onChange={(event) => setShareId(event.target.value)}
              placeholder={shareKind === "user" ? "Principal id" : "Role id"}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addShare();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addShare}
              disabled={shareId.trim().length === 0}
            >
              Add
            </Button>
          </div>
          {shares.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Private. Only you can open {selected.length > 1 ? "these files" : "this file"}.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {shares.map((share) => (
                <li
                  key={`${share.kind}:${share.id}`}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 text-xs"
                >
                  {share.kind === "role" ? (
                    <UsersRound className="size-3 text-muted-foreground" aria-hidden />
                  ) : (
                    <UserRound className="size-3 text-muted-foreground" aria-hidden />
                  )}
                  <span className="max-w-48 truncate">{share.id}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${share.id}`}
                    onClick={() =>
                      setShares((current) =>
                        current.filter(
                          (entry) => entry.kind !== share.kind || entry.id !== share.id
                        )
                      )
                    }
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {progress > 0 && busy ? (
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-foreground transition-[width] duration-150"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="active:scale-[0.96]"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {busy
              ? "Uploading…"
              : source === "upload" && selected.length > 1
                ? "Add files"
                : "Add file"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function nameFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  return last || "download";
}
