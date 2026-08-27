"use client";

import type { ReactNode } from "react";

/** Where the reader is in the walk. A stage the reader has settled collapses to one line. */
export type StageState = "done" | "active" | "upcoming";

/** The element a stage transition scrolls to. */
export function stageDomId(id: string): string {
  return `stage-${id}`;
}

function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function StageGlyph({ state }: { state: StageState }) {
  return (
    <span
      aria-hidden
      className={
        state === "done"
          ? "grid size-6 shrink-0 place-items-center border border-fd-primary text-[11px] leading-none text-fd-primary"
          : "grid size-6 shrink-0 place-items-center border border-fd-border text-[11px] leading-none text-fd-muted-foreground"
      }
    >
      {state === "done" ? "✓" : ""}
    </span>
  );
}

/**
 * One stage of the walk. Only the active stage renders its `children`; a settled stage collapses to
 * a single line carrying what the reader chose, so the page is always about the decision in front
 * of them rather than every decision at once.
 *
 * An upcoming stage stays visible but empty, because a reader needs to see that a third step exists
 * before they commit to the first.
 */
export function WizardStage({
  id,
  index,
  title,
  state,
  summary,
  onReopen,
  children,
}: {
  id: string;
  index: number;
  title: string;
  state: StageState;
  summary?: string;
  onReopen?: () => void;
  children?: ReactNode;
}) {
  return (
    <section
      id={stageDomId(id)}
      data-stage={id}
      data-state={state}
      className="scroll-mt-16 border-t border-fd-border"
    >
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {state === "active" ? (
          <div className="py-10">
            <div className="flex items-baseline gap-3">
              <span className="text-xs tabular-nums text-fd-primary">{ordinal(index)}</span>
              <h2 className="text-xl font-bold tracking-tight">{title}</h2>
            </div>
            <div className="mt-6">{children}</div>
          </div>
        ) : (
          <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 py-2">
            <StageGlyph state={state} />
            <span
              className={
                state === "done"
                  ? "text-xs tabular-nums text-fd-muted-foreground"
                  : "text-xs tabular-nums text-fd-muted-foreground/60"
              }
            >
              {ordinal(index)}
            </span>
            <span className={state === "done" ? "text-sm" : "text-sm text-fd-muted-foreground/60"}>
              {title}
            </span>
            {summary ? (
              <span className="min-w-0 truncate text-sm text-fd-muted-foreground">{summary}</span>
            ) : null}
            {state === "done" && onReopen ? (
              <button
                type="button"
                onClick={onReopen}
                className="ml-auto min-h-11 cursor-pointer text-xs text-fd-muted-foreground transition-colors duration-150 hover:text-fd-primary"
              >
                [change]
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** The primary control that settles a stage and moves the reader to the next one. */
export function StageAdvance({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-max cursor-pointer items-center rounded-sm bg-tf-fill px-5 text-sm font-medium text-tf-fill-foreground transition-colors duration-150 hover:bg-tf-fill-hover"
    >
      {children}
    </button>
  );
}
