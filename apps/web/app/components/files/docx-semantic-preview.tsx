import type { DocumentProjection, OfficeDocumentFormat } from "@tulipfarm/files/document-preview";
import type { PreviewBlock } from "@tulipfarm/files/office-preview";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { DocxPreviewFailure, previewDocument } from "./docx-preview-client";

type PreviewState =
  | { kind: "loading" }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; preview: DocumentProjection };

export function DocumentSemanticPreview({
  bytes,
  format = "docx",
  className,
}: {
  readonly bytes: Uint8Array;
  readonly format?: OfficeDocumentFormat;
  readonly className?: string;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    previewDocument(bytes, controller.signal, format).then(
      (preview) => {
        if (!controller.signal.aborted) setState({ kind: "ready", preview });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "failed",
          reason:
            error instanceof DocxPreviewFailure
              ? error.message
              : "The local document preview failed. Download the file or try again.",
        });
      }
    );
    return () => controller.abort();
  }, [bytes, format]);

  if (state.kind !== "ready") {
    return (
      <div className={cn("flex items-center justify-center p-6", className)}>
        <p
          role={state.kind === "failed" ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {state.kind === "failed"
            ? state.reason
            : format === "docx"
              ? "Reading Word document locally…"
              : "Reading document locally…"}
        </p>
      </div>
    );
  }
  const { preview } = state;
  return (
    <div className={cn("overflow-auto bg-muted/30 px-6 py-6", className)}>
      <div className={cn("mx-auto space-y-4", format === "xlsx" ? "max-w-full" : "max-w-3xl")}>
        <p className="text-xs text-muted-foreground">
          Semantic preview — document layout and embedded assets may differ from the original.
        </p>
        {format === "xlsx" && (
          <p className="text-xs text-muted-foreground">
            Visible sheets, rows and columns only. Values use stored formatting and cached formula
            results; formulas are not recalculated and these are not raw typed values.
          </p>
        )}
        {format === "pptx" && (
          <p className="text-xs text-muted-foreground">
            Speaker notes are labeled separately from visible text. Semantic content does not
            reproduce slide boundaries, numbering or layout.
          </p>
        )}
        {preview.truncated && (
          <p role="status" className="rounded-md border border-border p-3 text-sm">
            Limited preview: only part of this document is shown (up to 400 blocks and 200 rows per
            table, and 256 columns). Download the original to read more. Chat and Knowledge have
            separate extraction limits.
          </p>
        )}
        {!preview.blocks.some(hasReadableContent) ? (
          <p role="status" className="text-sm text-muted-foreground">
            This document has no readable content.
          </p>
        ) : (
          <article className="space-y-4 rounded-lg border border-border bg-background px-8 py-7">
            <SemanticBlocks blocks={preview.blocks} />
          </article>
        )}
      </div>
    </div>
  );
}

function hasReadableContent(block: PreviewBlock): boolean {
  if (block.kind === "table") return block.rows.some((row) => row.some((cell) => cell.trim()));
  if (block.kind === "heading" || block.kind === "paragraph" || block.kind === "listItem") {
    return block.text.trim().length > 0;
  }
  return false;
}

type ListBlock = Extract<PreviewBlock, { kind: "listItem" }>;
interface ListNode {
  block: ListBlock;
  children: ListNode[];
}

function listTree(items: readonly ListBlock[]): ListNode[] {
  const roots: ListNode[] = [];
  const stack: ListNode[] = [];
  for (const block of items) {
    const node: ListNode = { block, children: [] };
    while (stack.length > 0 && (stack.at(-1)?.block.depth ?? 0) >= (block.depth ?? 0)) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function SemanticList({ nodes }: { readonly nodes: readonly ListNode[] }) {
  const List = nodes[0]?.block.ordered ? "ol" : "ul";
  return (
    <List className="space-y-2 pl-5 text-sm">
      {nodes.map((node, index) => (
        <li key={index}>
          <span className="mr-2">{node.block.marker ?? "•"}</span>
          <span className="whitespace-pre-wrap">{node.block.text}</span>
          {node.children.length > 0 && <SemanticList nodes={node.children} />}
        </li>
      ))}
    </List>
  );
}

function SemanticBlocks({ blocks }: { readonly blocks: readonly PreviewBlock[] }) {
  const groups: (PreviewBlock | ListBlock[])[] = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.kind !== "listItem") groups.push(block);
    else if (Array.isArray(previous)) previous.push(block);
    else groups.push([block]);
  }
  return groups.map((group, index) =>
    Array.isArray(group) ? (
      <SemanticList key={index} nodes={listTree(group)} />
    ) : (
      <SemanticBlock key={index} block={group} />
    )
  );
}

function SemanticBlock({ block }: { readonly block: PreviewBlock }) {
  switch (block.kind) {
    case "heading": {
      const Heading =
        (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[
          Math.max(0, Math.min(5, block.level - 1))
        ] ?? "h2";
      return <Heading className="font-semibold text-foreground">{block.text}</Heading>;
    }
    case "paragraph":
      return <p className="whitespace-pre-wrap text-sm leading-relaxed">{block.text}</p>;
    case "table":
      return <SemanticTable block={block} />;
    default:
      return null;
  }
}

function SemanticTable({ block }: { readonly block: Extract<PreviewBlock, { kind: "table" }> }) {
  const spans = new Map((block.spans ?? []).map((span) => [`${span.row}:${span.column}`, span]));
  const covered = new Set<string>();
  for (const span of spans.values()) {
    for (let row = span.row; row < span.row + span.rowSpan; row += 1) {
      for (let column = span.column; column < span.column + span.colSpan; column += 1) {
        if (row !== span.row || column !== span.column) covered.add(`${row}:${column}`);
      }
    }
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => {
                const coordinate = `${rowIndex}:${cellIndex}`;
                if (covered.has(coordinate)) return null;
                const span = spans.get(coordinate);
                const Cell = rowIndex < (block.headerRows ?? 0) ? "th" : "td";
                return (
                  <Cell
                    key={cellIndex}
                    rowSpan={span?.rowSpan}
                    colSpan={span?.colSpan}
                    scope={Cell === "th" ? "col" : undefined}
                    className="whitespace-pre-wrap border border-border px-3 py-2 text-left align-top"
                  >
                    {cell}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
