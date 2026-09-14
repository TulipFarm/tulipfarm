import { useEffect, useId, useState } from "react";
import { FileTypeIcon } from "~/components/files/file-type-icon";
import { Plug, Search, Upload } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { formatFileSize, type LibraryFile, searchFiles, type UploadedFile } from "~/lib/files";
import { cn } from "~/lib/utils";

type PickerTab = "workspace" | "upload" | "integrations";

/**
 * The single entry point for adding a file to a message: search the workspace Files catalog, or
 * pick/drop something local. Replaces what used to be two adjacent toolbar buttons (issue #846).
 */
export function FilePickerModal({
  open,
  onClose,
  onAttachExisting,
  onFilesDropped,
  onBrowse,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Stages an already-uploaded workspace File without re-sending its bytes. */
  readonly onAttachExisting: (file: UploadedFile) => void;
  /** Stages Files dropped directly onto the Upload tab. */
  readonly onFilesDropped: (files: File[]) => void;
  /** Opens the OS file picker — the composer owns the actual `<input type="file">`. */
  readonly onBrowse: () => void;
}) {
  const [tab, setTab] = useState<PickerTab>("workspace");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly LibraryFile[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const searchId = useId();

  useEffect(() => {
    if (open) return;
    setTab("workspace");
    setQuery("");
    setResults([]);
    setError(null);
    setDragActive(false);
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "workspace") return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchFiles(trimmed, 20, controller.signal)
        .then((files) => setResults(files))
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : "Files could not be searched.");
        })
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, tab, query]);

  function choose(file: LibraryFile) {
    onAttachExisting(file);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add files" className="max-w-xl">
      <Tabs value={tab} onValueChange={(value) => setTab(value as PickerTab)}>
        <TabsList>
          <TabsTrigger value="workspace">Workspace Files</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="integrations" className="gap-1.5">
            Cloud Integrations
            <Badge variant="warning">Coming soon</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workspace" className="flex flex-col gap-3">
          <label htmlFor={searchId} className="relative block">
            <span className="sr-only">Search workspace files</span>
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search filenames"
              className="pl-8"
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {query.trim().length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Start typing to search your workspace files.
            </p>
          ) : searching ? (
            <p role="status" className="py-6 text-center text-sm text-muted-foreground">
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching files.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {results.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => choose(file)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                      <FileTypeIcon mediaType={file.mediaType} filename={file.filename} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">
                        {file.filename}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatFileSize(file.sizeBytes)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="upload">
          <button
            type="button"
            onClick={onBrowse}
            onDragEnter={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
            }}
            onDragLeave={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              const files = Array.from(event.dataTransfer.files);
              if (files.length > 0) {
                onFilesDropped(files);
                onClose();
              }
            }}
            className={cn(
              "flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 text-center transition-[background-color,border-color]",
              dragActive
                ? "border-foreground bg-muted/70"
                : "border-border bg-muted/30 hover:border-foreground/30 hover:bg-muted/50"
            )}
          >
            <Upload className="size-6 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground">
              {dragActive ? "Drop the files here" : "Drag and drop files, or choose them"}
            </span>
          </button>
        </TabsContent>

        <TabsContent value="integrations">
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 text-center">
            <Plug className="size-6 text-muted-foreground" aria-hidden />
            <p className="font-medium text-foreground">Coming soon</p>
            <p className="text-xs text-muted-foreground">
              Attaching files straight from Google Drive and other providers will land here once
              that integration exists.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
