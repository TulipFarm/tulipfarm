import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";

/**
 * Compact chip vocabulary for reporting what a Tool acted on.
 *
 * A chip is the *object* of a step, never the step itself: `Wrote` is the label, `agents/triage.md`
 * is the chip. Keeping the object in a chip lets a row truncate the identifier instead of the verb,
 * so two rows in the same run stay tellable apart at any width.
 */

export const DIFF_TONES = ["add", "remove", "context"] as const;
export type DiffTone = (typeof DIFF_TONES)[number];
export type DiffLine = { text: string; tone: DiffTone };

const DIFF_LINE_CLASS: Record<DiffTone, string> = {
  add: "bg-diff-added-surface text-diff-added",
  remove: "bg-diff-removed-surface text-diff-removed",
  context: "text-muted-foreground",
};

const DIFF_MARKER: Record<DiffTone, string> = { add: "+", remove: "−", context: " " };

/**
 * `+13 −2`. The sign carries the meaning, so the pair still reads without color, and the
 * screen-reader line says it in words rather than as arithmetic.
 */
export function DiffCount({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  if (added <= 0 && removed <= 0) return null;

  return (
    <span
      className={cn("inline-flex shrink-0 gap-1 font-mono text-[11px] tabular-nums", className)}
    >
      <span aria-hidden className="contents">
        {added > 0 ? <span className="text-diff-added">+{added}</span> : null}
        {removed > 0 ? <span className="text-diff-removed">−{removed}</span> : null}
      </span>
      <span className="sr-only">
        {added > 0 ? `${added} added` : ""}
        {added > 0 && removed > 0 ? ", " : ""}
        {removed > 0 ? `${removed} removed` : ""}
      </span>
    </span>
  );
}

/** The object a step acted on: a path, a command, a query. Mono whenever it is an identifier. */
export function ToolChip({
  children,
  mono,
  className,
}: {
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center truncate rounded-md border border-run-border bg-run-surface px-1.5 py-0.5 text-xs text-muted-foreground",
        mono === true && "font-mono",
        className
      )}
    >
      {children}
    </span>
  );
}

type PreviewPosition = { left: number; top?: number; bottom: number | undefined };

/** Roughly what the panel will occupy, so it can decide to flip before it has been measured. */
function estimateHeight(lines: number) {
  return 34 + lines * 20;
}

/**
 * One changed file as a chip. When the change itself is available it previews on hover and on
 * keyboard focus; with nothing to show it stays a plain chip rather than a control that opens an
 * empty panel.
 */
export function DiffChip({
  file,
  added,
  removed,
  lines,
  className,
}: {
  file: string;
  added: number;
  removed: number;
  lines?: readonly DiffLine[];
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<PreviewPosition | null>(null);
  const hasPreview = lines !== undefined && lines.length > 0;

  const face = (
    <>
      <span className="min-w-0 truncate">{file}</span>
      <DiffCount added={added} removed={removed} className="text-[11px]" />
    </>
  );

  const chipClass = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md border border-run-border bg-card px-2 py-1 font-mono text-xs text-foreground",
    className
  );

  if (!hasPreview) {
    return <span className={chipClass}>{face}</span>;
  }

  function open() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = estimateHeight(lines?.length ?? 0);
    const fitsBelow = rect.bottom + 6 + height <= window.innerHeight - 12;
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      top: fitsBelow ? rect.bottom + 6 : undefined,
      bottom: fitsBelow ? undefined : window.innerHeight - rect.top + 6,
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={position !== null}
        aria-label={`Show the change to ${file}`}
        onMouseEnter={open}
        onMouseLeave={() => setPosition(null)}
        onFocus={open}
        onBlur={() => setPosition(null)}
        onClick={() => (position === null ? open() : setPosition(null))}
        className={cn(
          chipClass,
          "transition-colors hover:bg-run-surface-hover focus-visible:-outline-offset-2"
        )}
      >
        {face}
      </button>
      {position === null
        ? null
        : createPortal(
            <div
              // The panel follows the pointer's chip, so it must not sit inside the transcript's
              // clipping and transformed ancestors — a fixed panel there is positioned against the
              // wrong origin and lands off-screen.
              className="pointer-events-none fixed z-[100] w-72 overflow-hidden rounded-md border border-code-border bg-code-surface"
              style={{ left: position.left, top: position.top, bottom: position.bottom }}
            >
              <div className="flex items-center justify-between gap-2 border-b border-code-border px-2.5 py-1.5 font-mono text-[11px]">
                <span className="min-w-0 truncate text-muted-foreground">{file}</span>
                <DiffCount added={added} removed={removed} />
              </div>
              <div className="py-1 font-mono text-[11px] leading-[1.7]">
                {lines?.map((line, index) => (
                  <div
                    key={`${line.tone}-${index}-${line.text}`}
                    className={cn("flex gap-2 whitespace-pre px-2.5", DIFF_LINE_CLASS[line.tone])}
                  >
                    <span aria-hidden className="w-3 shrink-0 select-none">
                      {DIFF_MARKER[line.tone]}
                    </span>
                    <span className="min-w-0 truncate">{line.text}</span>
                  </div>
                ))}
              </div>
            </div>,
            document.body
          )}
    </>
  );
}

/**
 * The changed files of a run. Long lists stay one line high until asked to grow, because the
 * summary above them is the thing being read — but `+N more` reveals the rest rather than being a
 * count with nothing behind it.
 */
export function DiffChipGroup({
  files,
  max = 3,
  className,
}: {
  files: readonly { file: string; added: number; removed: number; lines?: readonly DiffLine[] }[];
  max?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, files.length - max);
  const shown = expanded ? files : files.slice(0, max);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((entry) => (
        <DiffChip key={entry.file} {...entry} />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="rounded-md px-1.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:-outline-offset-2"
        >
          {expanded ? "Show fewer" : `+${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}
