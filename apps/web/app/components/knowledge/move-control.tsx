import { useState } from "react";
import { FolderInput } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import {
  listSubjects,
  movePage,
  type PageMovePreview,
  previewPageMove,
  type SubjectDirectory,
} from "~/lib/knowledge-api";
import { MoveDialog } from "./move-dialog";

/**
 * The move affordance on a tree row.
 *
 * A button and a text field rather than drag-and-drop, because a permission change reachable only
 * by dragging is a permission change some people cannot make. Drag can be added on top of this; it
 * cannot replace it.
 */
export function MoveControl({
  pageId,
  pageTitle,
  currentPath,
  onMoved,
}: {
  pageId: string;
  pageTitle: string;
  currentPath: string;
  onMoved: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [path, setPath] = useState(currentPath);
  const [preview, setPreview] = useState<PageMovePreview | null>(null);
  const [directory, setDirectory] = useState<SubjectDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    if (busy) return;
    if (path.trim() === "" || path === currentPath) {
      setError("Enter a different path.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [p, d] = await Promise.all([previewPageMove(pageId, { path }), listSubjects()]);
      setPreview(p);
      setDirectory(d);
      setAsking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not check the move");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPreview(null);
    setDirectory(null);
    setPath(currentPath);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        title="Move"
        aria-label={`Move ${pageTitle}`}
        className="cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100 focus-visible:opacity-100"
      >
        <FolderInput className="size-3" aria-hidden />
      </button>

      <Modal open={asking} onClose={() => setAsking(false)} title={`Move ${pageTitle}`}>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">New path</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1.5 text-foreground"
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void check()} disabled={busy}>
            Continue
          </Button>
        </div>
      </Modal>

      {preview && directory ? (
        <MoveDialog
          open
          pageTitle={pageTitle}
          destination={path}
          preview={preview}
          directory={directory}
          onConfirm={async () => {
            await movePage(pageId, { path });
            reset();
            onMoved();
          }}
          onCancel={reset}
        />
      ) : null}
    </>
  );
}
