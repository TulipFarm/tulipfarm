"use client";

import type { ReactNode } from "react";
import { ArrowRight, Check } from "@/components/icons";

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
    <span aria-hidden="true" className="stage-glyph">
      {state === "done" ? <Check size={15} /> : <ArrowRight size={15} />}
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
    <section id={stageDomId(id)} data-stage={id} data-state={state} className="wizard-stage">
      {state === "active" ? (
        <div className="stage-active">
          <div className="stage-heading">
            <span className="stage-number" aria-hidden="true">
              {ordinal(index)}
            </span>
            <h2 tabIndex={-1}>{title}</h2>
          </div>
          <div className="stage-body">{children}</div>
        </div>
      ) : (
        <div className="stage-summary">
          <StageGlyph state={state} />
          <div>
            <p>{title}</p>
            {summary ? <span>{summary}</span> : null}
          </div>
          {state === "done" && onReopen ? (
            <button
              type="button"
              onClick={onReopen}
              className="stage-change"
              aria-label={`Change ${summary ?? title}`}
            >
              Change
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** The primary control that settles a stage and moves the reader to the next one. */
export function StageAdvance({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="button button-primary w-max">
      {children} <ArrowRight size={16} />
    </button>
  );
}
