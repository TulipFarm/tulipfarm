import { isInlineRenderable } from "@tulipfarm/files";
import { useEffect, useState } from "react";
import { fetchFileObjectUrl } from "~/lib/files";

/**
 * The bytes of an image File, held as an object URL for as long as this component is mounted.
 *
 * Revoked on unmount and whenever the id changes; without that, scrolling a long transcript leaks
 * a blob per image for the lifetime of the tab.
 */
function useImageObjectUrl(fileId: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let created: string | null = null;
    fetchFileObjectUrl(fileId, controller.signal)
      .then((next) => {
        created = next;
        setUrl(next);
      })
      .catch(() => {
        // An image that will not load falls back to its name; there is nothing more useful to say.
        setUrl(null);
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [fileId, enabled]);

  return url;
}

/**
 * One attached File, as it appears inside a message.
 *
 * Images render as a thumbnail that opens full size, because the whole reason someone attaches a
 * screenshot is to be looked at. Everything else renders as a named download — a PDF thumbnail
 * would be a promise this component cannot keep.
 */
export function FileAttachment({
  fileId,
  mediaType,
  name,
}: {
  fileId: string;
  mediaType: string;
  name: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isImage = isInlineRenderable(mediaType);
  const url = useImageObjectUrl(fileId, isImage);

  if (!isImage) return <DownloadChip fileId={fileId} name={name} />;
  if (url === null) return <PendingChip name={name} />;

  if (expanded) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop mirrors the close button.
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
        onClick={() => setExpanded(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setExpanded(false);
        }}
      >
        <img alt={name} className="max-h-full max-w-full object-contain" src={url} />
        <button
          aria-label={`Close ${name}`}
          className="absolute right-4 top-4 rounded-md bg-background px-3 py-1.5 text-sm"
          onClick={() => setExpanded(false)}
          type="button"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <button
      aria-label={`View ${name} full size`}
      className="block overflow-hidden rounded-md border border-border"
      onClick={() => setExpanded(true)}
      type="button"
    >
      <img alt={name} className="max-h-48 max-w-full object-cover" src={url} />
    </button>
  );
}

const CHIP =
  "inline-flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground";

function PendingChip({ name }: { name: string }) {
  return (
    <span className={CHIP}>
      <span aria-hidden="true">📎</span>
      <span className="max-w-[16rem] truncate">{name}</span>
    </span>
  );
}

/**
 * A non-image attachment. The bytes are fetched on click rather than on render: a transcript of
 * PDFs should not download every one of them just to render their names.
 */
function DownloadChip({ fileId, name }: { fileId: string; name: string }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const url = await fetchFileObjectUrl(fileId);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      // Revoked on the next tick: revoking synchronously races the browser's read of the URL.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      aria-label={`Download ${name}`}
      className={`${CHIP} hover:bg-secondary`}
      disabled={busy}
      onClick={download}
      type="button"
    >
      <span aria-hidden="true">📎</span>
      <span className="max-w-[16rem] truncate">{name}</span>
    </button>
  );
}
