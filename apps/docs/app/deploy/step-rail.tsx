"use client";

import Link from "next/link";
import { stepAnchor, targetDocHref, verifyLine, type WizardStep, type WizardTarget } from "./model";

/** The id a step's row carries, so the wayfinding rail can jump to it. */
function stepDomId(step: WizardStep): string {
  return `step-${stepAnchor(step.title)}`;
}

function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/**
 * The contents rail: every step as one compact line, plus how much is left. Sticky on `lg` so the
 * reader always knows where they are in a seventeen-step path.
 */
export function StepIndex({ steps, done }: { steps: WizardStep[]; done: ReadonlySet<string> }) {
  const completed = steps.filter((step) => done.has(step.id)).length;
  const remaining = steps.length - completed;

  return (
    <div className="lg:sticky lg:top-20">
      <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">[contents]</p>
      <p className="mt-3 text-2xl font-bold tracking-tight tabular-nums">
        {completed} <span className="text-fd-muted-foreground">/ {steps.length}</span>
      </p>
      <p className="mt-1 text-xs text-fd-muted-foreground">
        {remaining === 0 ? "every step marked done" : `${remaining} left`}
      </p>
      <div
        className="mt-3 h-0.5 w-full bg-fd-border"
        role="progressbar"
        aria-label="Steps marked done"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={completed}
      >
        <div
          className="h-0.5 bg-fd-foreground transition-[width] duration-300 ease-out"
          style={{ width: `${steps.length === 0 ? 0 : (completed / steps.length) * 100}%` }}
        />
      </div>

      <ol className="mt-5 hidden lg:block">
        {steps.map((step, index) => (
          <li key={step.id}>
            <a
              href={`#${stepDomId(step)}`}
              data-done={done.has(step.id) ? "" : undefined}
              className="flex items-baseline gap-2 border-l-2 border-transparent py-1 pl-2 text-xs leading-6 text-fd-muted-foreground transition-colors duration-150 hover:border-fd-primary hover:text-fd-foreground focus-visible:-outline-offset-2 data-[done]:text-fd-muted-foreground/60 data-[done]:line-through"
            >
              <span className="tabular-nums">{ordinal(index)}</span>
              <span className="truncate">{step.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepRow({
  target,
  step,
  index,
  done,
  onToggle,
}: {
  target: WizardTarget;
  step: WizardStep;
  index: number;
  done: boolean;
  onToggle: (stepId: string) => void;
}) {
  const verify = verifyLine(step.verify);

  return (
    <li
      id={stepDomId(step)}
      data-done={done ? "" : undefined}
      className="group relative grid scroll-mt-20 grid-cols-[2.75rem_1fr] gap-x-2 py-1 transition-opacity duration-300 data-[done]:opacity-45 sm:gap-x-3"
    >
      <label className="relative grid size-11 cursor-pointer place-items-center">
        <input
          type="checkbox"
          checked={done}
          onChange={() => onToggle(step.id)}
          aria-label={`Mark step ${ordinal(index)}, ${step.title}, done`}
          className="peer absolute inset-0 size-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className="grid size-6 place-items-center border border-fd-border bg-fd-background text-[11px] leading-none text-fd-primary transition-colors duration-150 peer-checked:border-fd-primary peer-hover:border-fd-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-fd-ring"
        >
          {done ? "✓" : ""}
        </span>
      </label>

      <div className="min-w-0">
        <div className="flex min-h-11 items-center gap-3">
          <span className="text-xs tabular-nums text-fd-muted-foreground">{ordinal(index)}</span>
          <h3 className="min-w-0 flex-1 text-sm font-medium group-data-[done]:line-through">
            {step.title}
          </h3>
          <Link
            href={targetDocHref(target, step)}
            className="shrink-0 content-center self-stretch pl-3 text-xs text-fd-muted-foreground transition-colors duration-150 hover:text-fd-primary"
          >
            full step →
          </Link>
        </div>

        {done ? null : (
          <div className="grid gap-0.5 pb-3 text-[13px] leading-6">
            {step.run ? (
              <p className="min-w-0">
                <span className="select-none text-fd-primary">$ </span>
                <code className="[overflow-wrap:anywhere] text-fd-foreground">{step.run}</code>
              </p>
            ) : null}
            <p className="min-w-0 pl-[2ch] text-fd-muted-foreground">
              {step.run ? `then ${verify.action}` : verify.action}
            </p>
            <p className="min-w-0 pl-[2ch] text-fd-muted-foreground">{verify.expectation}</p>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The path to a running instance as **one rail**, not a column of boxes: a single vertical rule
 * with a node per step. Marking a step done collapses its detail, so the page shortens as the
 * reader works. The done set is local React state — nothing is stored and nothing is reported.
 */
export function StepRail({
  target,
  steps,
  done,
  onToggle,
}: {
  target: WizardTarget;
  steps: WizardStep[];
  done: ReadonlySet<string>;
  onToggle: (stepId: string) => void;
}) {
  return (
    <ol className="relative">
      <span aria-hidden className="absolute bottom-6 left-[1.375rem] top-6 w-px bg-fd-border" />
      {steps.map((step, index) => (
        <StepRow
          key={step.id}
          target={target}
          step={step}
          index={index}
          done={done.has(step.id)}
          onToggle={onToggle}
        />
      ))}
    </ol>
  );
}
