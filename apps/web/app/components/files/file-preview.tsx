import { isInlineRenderable } from "@tulipfarm/files/limits";
import { useEffect, useState } from "react";
import { Modal } from "~/components/ui/modal";
import { fetchFileObjectUrl } from "~/lib/files";
import { cn } from "~/lib/utils";
import { DocumentView, isDocumentPreviewable } from "./document-view";

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
  return (
    isInlineRenderable(mediaType) ||
    mediaType === "application/pdf" ||
    isDocumentPreviewable(mediaType)
  );
}

/**
 * One File, previewed in place.
 *
 * Images and PDFs go to the browser, which already knows how to draw them. Everything else is read
 * here in the tab — text as text, and an Office package parsed into blocks by `@tulipfarm/files`.
 *
 * Nothing is handed to a hosted viewer. A viewer like Google's `gview` renders by fetching the URL
 * from Google's own servers, which would mean publishing the File to the public internet — it can
 * reach neither a localhost instance nor one behind a firewall, it would bypass the File's access
 * control for anyone holding the link, and it would send private business documents to a third
 * party. Reading the bytes locally has none of those problems.
 */
export function FilePreview({
  file,
  onClose,
}: {
  file: { id: string; filename: string; mediaType: string } | null;
  onClose: () => void;
}) {
  const { url, failed } = useObjectUrl(
    file !== null && !isDocumentPreviewable(file.mediaType) ? file.id : null
  );
  if (file === null) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={file.filename}
      className="h-[92vh] w-[96vw] max-w-[96rem]"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
      <PreviewBody file={file} url={url} failed={failed} className="min-h-0 flex-1" />
    </Modal>
  );
}

/** The existing authenticated preview, rendered inline on a File detail page. */
export function FilePreviewPanel({
  file,
  className,
}: {
  readonly file: { id: string; filename: string; mediaType: string };
  readonly className?: string;
}) {
  if (!isPreviewable(file.mediaType)) {
    return (
      <div className={cn("flex items-center justify-center", className)}>
        <p className="text-sm text-muted-foreground">
          Preview is not available for this file format.
        </p>
      </div>
    );
  }
  return <PreviewLoader file={file} className={className} />;
}

function PreviewLoader({
  file,
  className,
}: {
  readonly file: { id: string; filename: string; mediaType: string };
  readonly className?: string;
}) {
  const { url, failed } = useObjectUrl(isDocumentPreviewable(file.mediaType) ? null : file.id);
  return <PreviewBody file={file} url={url} failed={failed} className={className} />;
}

function PreviewBody({
  file,
  url,
  failed,
  className,
}: {
  readonly file: { id: string; filename: string; mediaType: string };
  readonly url: string | null;
  readonly failed: boolean;
  readonly className?: string;
}) {
  if (isDocumentPreviewable(file.mediaType)) {
    return <DocumentView file={file} className={className} />;
  }
  return (
    <div className={cn("flex items-center justify-center", className)}>
      {failed ? (
        <p className="text-sm text-muted-foreground">That file could not be loaded.</p>
      ) : url === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : isInlineRenderable(file.mediaType) ? (
        <img
          alt={file.filename}
          className="max-h-full max-w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          src={url}
        />
      ) : file.mediaType === "application/pdf" ? (
        <iframe className="h-full w-full" src={url} title={file.filename} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Preview is not available for this file format.
        </p>
      )}
    </div>
  );
}
