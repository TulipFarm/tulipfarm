import { isInlineRenderable } from "@tulipfarm/files/limits";
import { useEffect, useState } from "react";
import { Modal } from "~/components/ui/modal";
import { fetchFileObjectUrl } from "~/lib/files";

/**
 * A File's bytes as an object URL, held only while the preview is open.
 *
 * The library previews one File at a time, so the URL is created on open and revoked on close.
 * Without the revoke, opening twenty previews leaks twenty blobs for the life of the tab.
 */
function useObjectUrl(fileId: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  });

  useEffect(() => {
    if (fileId === null) return;
    const controller = new AbortController();
    let created: string | null = null;
    setState({ url: null, failed: false });
    fetchFileObjectUrl(fileId, controller.signal)
      .then((next) => {
        created = next;
        setState({ url: next, failed: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ url: null, failed: true });
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [fileId]);

  return state;
}

/** The media types this component shows in place rather than handing to a download. */
export function isPreviewable(mediaType: string): boolean {
  return isInlineRenderable(mediaType) || mediaType === "application/pdf";
}

/**
 * One File, previewed in place.
 *
 * Images and PDFs render inline because a browser already knows how; everything else offers its
 * bytes, since a viewer that resolves to nothing is worse than an honest download.
 */
export function FilePreview({
  file,
  onClose,
}: {
  file: { id: string; filename: string; mediaType: string } | null;
  onClose: () => void;
}) {
  const { url, failed } = useObjectUrl(file?.id ?? null);
  if (file === null) return null;

  return (
    <Modal open onClose={onClose} title={file.filename} className="max-w-3xl">
      <div className="flex min-h-[16rem] items-center justify-center">
        {failed ? (
          <p className="text-sm text-muted-foreground">That file could not be loaded.</p>
        ) : url === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isInlineRenderable(file.mediaType) ? (
          <img alt={file.filename} className="max-h-[70vh] max-w-full object-contain" src={url} />
        ) : file.mediaType === "application/pdf" ? (
          <iframe className="h-[70vh] w-full" src={url} title={file.filename} />
        ) : (
          <a
            className="text-sm font-medium text-primary underline underline-offset-4"
            download={file.filename}
            href={url}
          >
            Download {file.filename}
          </a>
        )}
      </div>
    </Modal>
  );
}
