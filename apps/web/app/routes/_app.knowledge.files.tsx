import { type MetaFunction, useLoaderData, useNavigate, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { FileList } from "~/components/files/file-list";
import { FilePreview } from "~/components/files/file-preview";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError, getSession } from "~/lib/api";
import { fetchFiles, type LibraryFile } from "~/lib/files";

export const meta: MetaFunction = () => [{ title: "Files · Knowledge · tulipfarm" }];

const PAGE_SIZE = 25;

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

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const batch = await fetchFiles({ limit: PAGE_SIZE, after: cursor });
      setFiles((prev) => [...prev, ...batch.files]);
      setCursor(batch.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Those files could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  const crumbs = [{ label: "knowledge", to: "/knowledge" }, { label: "files" }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <div>
        <h1 className="text-base font-bold text-foreground">Files</h1>
        <p className="text-sm text-muted-foreground">
          Everything you have uploaded or an agent has made for you, in one place.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {files.length === 0 ? (
        <div className="rounded-sm border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">No files yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Attach an image or a PDF to a chat and it will appear here, alongside anything an agent
            makes for you — so you can find it again without remembering which chat it arrived in.
          </p>
        </div>
      ) : (
        <>
          <FileList
            files={files}
            viewerId={loaded.viewerId}
            onPreview={setPreviewing}
            onAttach={(file) => navigate(`/?attach=${encodeURIComponent(file.id)}`)}
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
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
