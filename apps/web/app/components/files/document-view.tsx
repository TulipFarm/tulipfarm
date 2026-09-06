import { isDelimitedPreviewable, previewDelimited } from "@tulipfarm/files/delimited-preview";
import type { PreviewBlock } from "@tulipfarm/files/office-preview";
import { isOfficePreviewable, previewOffice } from "@tulipfarm/files/office-preview";
import { useEffect, useRef, useState } from "react";
import { fetchFileBytes } from "~/lib/files";
import { cn } from "~/lib/utils";
import { isRichEmbeddable, OfficeEmbed } from "./office-embed";

/** The text formats a viewer shows as text rather than handing to a download. */
const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export function isTextPreviewable(mediaType: string): boolean {
  return TEXT_TYPES.has(mediaType);
}

/** Everything the document viewer can read out of the bytes itself. */
export function isDocumentPreviewable(mediaType: string): boolean {
  return isTextPreviewable(mediaType) || isOfficePreviewable(mediaType);
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "rich"; readonly bytes: Uint8Array }
  | { readonly kind: "blocks"; readonly blocks: readonly PreviewBlock[] };

/**
 * Reads a File and turns it into something renderable, in the tab rather than on a server.
 *
 * Parsing here rather than server-side keeps the File's bytes inside the session that already had
 * permission to read them: no new route to authorize, and nothing cached anywhere a later reader
 * could reach without going through the same access check.
 */
function useDocument(file: { id: string; mediaType: string } | null): Loaded {
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const id = file?.id ?? null;
  const mediaType = file?.mediaType ?? null;

  // Depends on the two fields rather than on `file`: callers pass a fresh object every render, and
  // an object dependency would abort the in-flight read and restart it forever.
  useEffect(() => {
    if (id === null || mediaType === null) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    fetchFileBytes(id, controller.signal)
      .then(({ bytes, text }) => {
        if (controller.signal.aborted) return;
        if (isOfficePreviewable(mediaType)) {
          // A Word or PowerPoint file is drawn as itself when a renderer exists for it; the outline
          // below is what it falls back to, so the bytes are kept rather than parsed twice.
          if (isRichEmbeddable(mediaType)) {
            setState({ kind: "rich", bytes });
            return;
          }
          setState({ kind: "blocks", blocks: previewOffice(bytes, mediaType) });
          return;
        }
        // A CSV is a spreadsheet stored as text: it reads as a grid, not as comma-separated lines.
        if (isDelimitedPreviewable(mediaType)) {
          setState({ kind: "blocks", blocks: previewDelimited(text(), mediaType) });
          return;
        }
        setState({ kind: "text", text: text() });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A document that cannot be read is still a document that can be downloaded, so the
        // message says what failed rather than pretending the format is unsupported.
        setState({
          kind: "failed",
          reason:
            error instanceof Error && error.message.length > 0
              ? `That file could not be opened for preview: ${error.message}`
              : "That file could not be opened for preview.",
        });
      });
    return () => controller.abort();
  }, [id, mediaType]);

  return state;
}

/** One File's readable content, laid out for reading rather than for editing. */
export function DocumentView({
  file,
  className,
}: {
  readonly file: { id: string; filename: string; mediaType: string };
  readonly className?: string;
}) {
  const state = useDocument(file);
  // Reset per File, so a document the renderer refused does not condemn the next one to the outline.
  const [refusedRichRender, setRefusedRichRender] = useState(false);
  const previousFileId = useRef(file.id);
  if (previousFileId.current !== file.id) {
    previousFileId.current = file.id;
    setRefusedRichRender(false);
  }

  if (state.kind === "loading") {
    return <Centered className={className}>Loading…</Centered>;
  }
  if (state.kind === "failed") {
    return <Centered className={className}>{state.reason}</Centered>;
  }
  if (state.kind === "text") {
    return (
      <div className={cn("overflow-auto bg-muted/30 px-6 py-6", className)}>
        <pre className="mx-auto max-w-3xl whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-8 py-7 font-mono text-[13px] leading-relaxed text-foreground shadow-sm">
          {state.text}
        </pre>
      </div>
    );
  }
  if (state.kind === "rich" && !refusedRichRender) {
    return (
      <OfficeEmbed
        bytes={state.bytes}
        mediaType={file.mediaType}
        onUnsupported={() => setRefusedRichRender(true)}
        className={className}
      />
    );
  }
  const blocks = state.kind === "rich" ? outlineOf(state.bytes, file.mediaType) : state.blocks;
  if (blocks.length === 0) {
    return <Centered className={className}>This document has no readable content.</Centered>;
  }
  // A grid needs the width more than it needs a comfortable measure, so a document made only of
  // grids is not squeezed into a reading column it will just scroll sideways inside.
  const allGrids = blocks.every((b) => b.kind === "table" || b.kind === "sheet");
  // A deck reads as a deck only if its cards are ordered, so each slide carries its position.
  const slideNumbers = new Map<PreviewBlock, number>();
  for (const block of blocks) {
    if (block.kind === "slide") slideNumbers.set(block, slideNumbers.size + 1);
  }
  return (
    <div className={cn("overflow-auto bg-muted/30 px-6 py-6", className)}>
      <div className={cn("mx-auto space-y-4", allGrids ? "max-w-full" : "max-w-3xl")}>
        {groupIntoPages(blocks).map((group, index) =>
          // Groups are positional and have no identity of their own, so the index is the key.
          group.kind === "standalone" ? (
            <Block key={index} block={group.block} slideNumber={slideNumbers.get(group.block)} />
          ) : (
            <div
              key={index}
              className="rounded-lg border border-border bg-background px-8 py-7 shadow-sm"
            >
              <div className="space-y-4">
                {group.blocks.map((block, blockIndex) => (
                  <Block key={blockIndex} block={block} />
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

type PageGroup =
  | { readonly kind: "page"; readonly blocks: readonly PreviewBlock[] }
  | { readonly kind: "standalone"; readonly block: PreviewBlock };

/**
 * Puts prose onto a page and leaves grids and slides to stand on their own.
 *
 * Without this every paragraph floats as its own element and a text document reads as a list of
 * fragments rather than as a page. Slides and sheets already carry their own frame, so wrapping
 * them again would just nest one card inside another.
 */
function groupIntoPages(blocks: readonly PreviewBlock[]): readonly PageGroup[] {
  const groups: PageGroup[] = [];
  let page: PreviewBlock[] = [];
  const flush = () => {
    if (page.length > 0) groups.push({ kind: "page", blocks: page });
    page = [];
  };
  for (const block of blocks) {
    if (block.kind === "slide" || block.kind === "sheet" || block.kind === "table") {
      flush();
      groups.push({ kind: "standalone", block });
      continue;
    }
    page.push(block);
  }
  flush();
  return groups;
}

/**
 * The outline a document falls back to, or nothing when it cannot be parsed either.
 *
 * This runs during render, on the path taken after a full-fidelity renderer has already refused the
 * file, so a parse failure here would take the whole viewer down with it over a File the reader can
 * still perfectly well download.
 */
function outlineOf(bytes: Uint8Array, mediaType: string): readonly PreviewBlock[] {
  try {
    return previewOffice(bytes, mediaType);
  } catch {
    return [];
  }
}

function Centered({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-center", className)}>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

const HEADING_SIZES = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"];

function Block({
  block,
  slideNumber,
}: {
  readonly block: PreviewBlock;
  readonly slideNumber?: number;
}) {
  switch (block.kind) {
    case "heading":
      return (
        <p
          className={cn(
            "font-semibold text-foreground",
            HEADING_SIZES[Math.min(block.level, 6) - 1] ?? "text-base"
          )}
        >
          {block.text}
        </p>
      );
    case "paragraph":
      return <p className="text-sm leading-relaxed text-foreground">{block.text}</p>;
    case "listItem":
      return (
        <p className="flex gap-2 text-sm leading-relaxed text-foreground">
          <span aria-hidden className="text-muted-foreground">
            •
          </span>
          <span>{block.text}</span>
        </p>
      );
    case "table":
      return <Grid rows={block.rows} />;
    case "sheet":
      return (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {block.name}
          </p>
          <Grid rows={block.rows} />
        </div>
      );
    case "slide":
      return (
        <div className="rounded-lg border border-border bg-background px-5 py-4 shadow-sm">
          {slideNumber !== undefined && (
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Slide {slideNumber}
            </p>
          )}
          <p className="text-lg font-semibold text-foreground">{block.title}</p>
          {block.bullets.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {block.bullets.map((bullet, index) => (
                <li key={index} className="flex gap-2 text-sm text-foreground">
                  <span aria-hidden className="text-muted-foreground">
                    •
                  </span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
  }
}

function Grid({ rows }: { readonly rows: readonly (readonly string[])[] }) {
  const [header, ...body] = rows;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background">
      <table className="w-full border-collapse text-sm">
        {header !== undefined && (
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  className="border-b border-border px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  scope="col"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 text-foreground">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
