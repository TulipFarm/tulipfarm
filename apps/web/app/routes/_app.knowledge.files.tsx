import { type MetaFunction, useLoaderData, useNavigate, useRouteError } from "@remix-run/react";
import { useRef, useState } from "react";
import { FileList } from "~/components/files/file-list";
import { FilePreview } from "~/components/files/file-preview";
import { ShareDialog } from "~/components/files/file-share";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import { ApiError, getSession } from "~/lib/api";
import {
  addFileToKnowledge,
  deleteFile,
  fetchFiles,
  fetchSharedWithMe,
  type LibraryFile,
  removeFileFromKnowledge,
} from "~/lib/files";

export const meta: MetaFunction = () => [{ title: "Files · Knowledge · tulipfarm" }];

const PAGE_SIZE = 25;

const TABS = [
  { id: "yours", label: "Yours", fetch: fetchFiles },
  { id: "shared", label: "Shared with you", fetch: fetchSharedWithMe },
] as const;

type TabId = (typeof TABS)[number]["id"];

export async function clientLoader() {
  const [page, viewer] = await Promise.all([fetchFiles({ limit: PAGE_SIZE }), getSession()]);
  return { files: page.files, nextCursor: page.nextCursor, viewerId: viewer.id };
}

export default function FilesIndex() {
  const loaded = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [files, setFiles] = useState<readonly LibraryFile[]>(loaded.files);
  const [cursor, setCursor] = useState<string | null>(loaded.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<LibraryFile | null>(null);
  const [sharing, setSharing] = useState<LibraryFile | null>(null);
  const [deleting, setDeleting] = useState<LibraryFile | null>(null);
  const [destroying, setDestroying] = useState(false);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("yours");
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement>>>({});
  // Switching tabs twice in quick succession leaves two requests in flight. Without this, whichever
  // answers last wins, and the list can end up showing one tab's Files under the other tab's label
  // — with a cursor that then pages the wrong set.
  const request = useRef(0);

  const load = TABS.find((candidate) => candidate.id === tab)?.fetch ?? fetchFiles;

  async function loadMore() {
    if (!cursor) return;
    request.current += 1;
    const ticket = request.current;
    setLoading(true);
    setError(null);
    try {
      const batch = await load({ limit: PAGE_SIZE, after: cursor });
      if (request.current !== ticket) return;
      setFiles((prev) => [...prev, ...batch.files]);
      setCursor(batch.nextCursor);
    } catch (err) {
      if (request.current !== ticket) return;
      setError(err instanceof Error ? err.message : "Those files could not be loaded.");
    } finally {
      if (request.current === ticket) setLoading(false);
    }
  }

  async function selectTab(next: TabId, focus = false) {
    request.current += 1;
    const ticket = request.current;
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
    setLoading(true);
    setError(null);
    setFiles([]);
    setCursor(null);
    try {
      const page = await (TABS.find((candidate) => candidate.id === next)?.fetch ?? fetchFiles)({
        limit: PAGE_SIZE,
      });
      if (request.current !== ticket) return;
      setFiles(page.files);
      setCursor(page.nextCursor);
    } catch (err) {
      if (request.current !== ticket) return;
      setError(err instanceof Error ? err.message : "Those files could not be loaded.");
    } finally {
      if (request.current === ticket) setLoading(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDestroying(true);
    setError(null);
    try {
      await deleteFile(deleting.id);
      // Dropped from the list rather than refetched: a refetch would re-page from the top and lose
      // however far the person had already scrolled to find the File they just destroyed.
      setFiles((prev) => prev.filter((file) => file.id !== deleting.id));
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be deleted.");
    } finally {
      setDestroying(false);
    }
  }

  /**
   * Adding is answered 202 — the extraction happens elsewhere — so the row is marked optimistically
   * and put back if the request is refused. Waiting for a worker would leave the button dead for
   * as long as the queue is deep, which reads as a broken button rather than as work in flight.
   */
  async function toggleKnowledge(file: LibraryFile): Promise<void> {
    if (indexing !== null) return;
    const adding = !file.inKnowledge;
    setIndexing(file.id);
    setError(null);
    const mark = (value: boolean) =>
      setFiles((prev) =>
        prev.map((each) => (each.id === file.id ? { ...each, inKnowledge: value } : each))
      );
    mark(adding);
    try {
      if (adding) await addFileToKnowledge(file.id);
      else await removeFileFromKnowledge(file.id);
    } catch (err) {
      mark(!adding);
      setError(err instanceof Error ? err.message : "That file could not be changed.");
    } finally {
      setIndexing(null);
    }
  }

  const crumbs = [{ label: "Knowledge", to: "/knowledge" }, { label: "Files" }];

  return (
    <PageShell
      crumbs={crumbs}
      title="Files"
      description="Everything you have uploaded or an agent has made for you, in one place."
    >
      <div role="tablist" aria-label="Which files to show" className="flex flex-wrap gap-2">
        {TABS.map((candidate, index) => (
          <Button
            key={candidate.id}
            type="button"
            role="tab"
            ref={(element) => {
              tabRefs.current[candidate.id] = element ?? undefined;
            }}
            size="sm"
            variant={tab === candidate.id ? "default" : "outline"}
            aria-selected={tab === candidate.id}
            tabIndex={tab === candidate.id ? 0 : -1}
            onClick={() => void selectTab(candidate.id)}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (direction === 0) return;
              event.preventDefault();
              const next = TABS[(index + direction + TABS.length) % TABS.length];
              if (next) void selectTab(next.id, true);
            }}
          >
            {candidate.label}
          </Button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {files.length === 0 && !loading ? (
        <div className="rounded-sm border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {tab === "shared" ? "Nothing shared with you" : "No files yet"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {tab === "shared"
              ? "When someone shares a file with you, or with a role you hold, it appears here. It leaves again the moment they revoke it."
              : "Attach an image or a PDF to a chat and it will appear here, alongside anything an agent makes for you, so you can find it again without remembering which chat it arrived in."}
          </p>
        </div>
      ) : (
        <>
          <FileList
            files={files}
            viewerId={loaded.viewerId}
            onPreview={setPreviewing}
            onAttach={(file) => navigate(`/?attach=${encodeURIComponent(file.id)}`)}
            onShare={setSharing}
            onKnowledge={(file) => void toggleKnowledge(file)}
            onDelete={setDeleting}
          />
          {cursor ? (
            <div>
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <FilePreview file={previewing} onClose={() => setPreviewing(null)} />
      <ShareDialog file={sharing} onClose={() => setSharing(null)} />
      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title={`Delete ${deleting?.filename ?? "this file"}?`}
        description="The file and its contents are erased for good. Anyone it was shared with loses it too, and any chat that used it will show the attachment as removed. This cannot be undone."
        confirmLabel="Delete for good"
        busy={destroying}
      />
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
