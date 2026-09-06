/**
 * Rendering a Word or PowerPoint file as the document it is, rather than as an outline of its text.
 *
 * `office-preview.ts` recovers the words and their structure, which is the right answer for a model
 * and a readable answer for a person, but it deliberately throws away layout — so a deck arrives as
 * a stack of titles and bullets. This renders the real thing: fonts, sizes, colours, tables, images
 * and slide geometry.
 *
 * It runs entirely in the tab. That is the only option that fits a self-hosted instance: a hosted
 * viewer such as Google's `gview` or Office Online is *their* server fetching a URL, so it needs the
 * File to be publicly downloadable — which defeats the File's own access control — and it ships
 * private business documents to a third party. Parsing the bytes the session already fetched has
 * neither problem.
 *
 * The renderers are imported dynamically because together they are megabytes of parser that most
 * sessions never open a document at all, and they must not sit in the app's initial bundle.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

/** The types a full-fidelity renderer exists for. */
const RICH_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function isRichEmbeddable(mediaType: string): boolean {
  return RICH_TYPES.has(mediaType);
}

function isPresentation(mediaType: string): boolean {
  return mediaType === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

/**
 * A document rendered at full fidelity, or nothing — the caller shows the outline instead.
 *
 * `onUnsupported` fires when a renderer refuses the file. These parsers cover the common shapes of
 * OOXML rather than all of it, so a document they cannot draw is expected rather than exceptional,
 * and it must degrade to the outline instead of showing an error over a file that reads fine.
 */
export function OfficeEmbed({
  bytes,
  mediaType,
  onUnsupported,
  className,
}: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly onUnsupported: () => void;
  readonly className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // `onUnsupported` is held in a ref so that a caller passing a fresh closure every render cannot
  // restart the render loop, which would re-parse the document forever.
  const unsupported = useRef(onUnsupported);
  useEffect(() => {
    unsupported.current = onUnsupported;
  }, [onUnsupported]);

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    setReady(false);
    container.replaceChildren();

    const draw = async () => {
      // The parsers take ownership of the buffer they are handed, so each gets its own copy and
      // the caller keeps a document it can still fall back to reading.
      const copy = bytes.slice();
      if (isPresentation(mediaType)) {
        const { init } = await import("pptx-preview");
        if (cancelled) return;
        const width = container.clientWidth > 0 ? container.clientWidth : 960;
        const previewer = init(container, { width, height: Math.round((width * 9) / 16) });
        destroy = () => previewer.destroy();
        await previewer.preview(copy.buffer as ArrayBuffer);
      } else {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(copy, container, undefined, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          useBase64URL: true,
        });
      }
      if (!cancelled) setReady(true);
    };

    draw().catch(() => {
      if (!cancelled) unsupported.current();
    });

    return () => {
      cancelled = true;
      try {
        destroy?.();
      } catch {
        // A renderer that fails to tear itself down must not take the dialog with it.
      }
      container.replaceChildren();
    };
  }, [bytes, mediaType]);

  return (
    <div className={cn("overflow-auto bg-muted/30", className)}>
      {!ready && <p className="px-6 py-6 text-sm text-muted-foreground">Rendering document…</p>}
      {/* Never `display: none` while rendering: the presentation renderer measures this element to
          size its slides, and a hidden element reports zero width, so it would fall back to a
          guess and lay the whole deck out at the wrong scale.

          A document is a page — it carries its own colours, so it is drawn on its own surface
          rather than inheriting the app's theme, the way a printed page looks the same in any
          room. */}
      <div ref={host} className="office-embed mx-auto w-full [color-scheme:light]" />
    </div>
  );
}
