"use client";

import type { WizardSecret } from "@tulipfarm/deploy-render";
import Link from "next/link";
import { SectionLabel } from "./chrome";
import { DeployCommand, OPEN_PROMPT } from "./deploy-command";
import {
  artifactHref,
  artifactName,
  targetDocHref,
  type WizardInput,
  type WizardStep,
  type WizardTarget,
} from "./model";
import { StageAdvance } from "./stage";
import { StepIndex, StepRail } from "./step-rail";

/** Stated once, above the steps, for as long as a `community` target is selected. */
function UnverifiedNotice({ target }: { target: WizardTarget }) {
  return (
    <div className="border-l-2 border-fd-border bg-fd-card px-4 py-3 text-[13px] leading-6 text-fd-muted-foreground">
      <span className="text-fd-foreground">Not verified end to end.</span> These steps come from the
      same manifest as every other target, but we do not boot {target.title} in CI, so nothing here
      is proven by a build. Read them as a starting point and expect to adapt.{" "}
      <a href={OPEN_PROMPT} className="text-fd-primary transition-colors hover:text-fd-primary/80">
        The single-file prompt →
      </a>{" "}
      carries the fuller configuration surface.
    </div>
  );
}

function SecretsPanel({ secrets }: { secrets: WizardSecret[] }) {
  return (
    <details className="group border-y border-fd-border">
      <summary className="flex min-h-14 list-none items-center gap-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-fd-primary">
          <span className="group-open:hidden">[+]</span>
          <span className="hidden group-open:inline">[−]</span>
        </span>
        <span>{secrets.length} Secrets, none of them typed on this page</span>
      </summary>
      <div className="pb-6">
        <p className="max-w-3xl text-sm leading-6 text-fd-muted-foreground">
          This page has no field for a Secret, so there is nothing here to leak. Where a Secret is
          required, generate it on your own machine and set it through your platform's environment.
          The whole set at once:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-sm border border-fd-border bg-fd-card p-3 text-[13px] leading-6">
          ./scripts/generate-secrets.sh
        </pre>
        <ul className="mt-5 border-t border-fd-border">
          {secrets.map((secret) => (
            <li
              key={secret.name}
              className="grid gap-1 border-b border-fd-border py-3.5 lg:grid-cols-[18rem_1fr] lg:items-baseline lg:gap-5"
            >
              <code className="min-w-0 text-[13px] [overflow-wrap:anywhere] text-fd-foreground">
                {secret.name}
              </code>
              <div className="min-w-0 text-[13px] leading-6 text-fd-muted-foreground">
                <p>{secret.description}</p>
                {secret.generate ? (
                  <p className="min-w-0">
                    <span className="select-none text-fd-primary">$ </span>
                    <code className="[overflow-wrap:anywhere] text-fd-foreground">
                      {secret.generate}
                    </code>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * The resolution for a platform no manifest describes. There are no steps to walk, so the stage
 * hands over the whole contract instead of pretending a path exists.
 */
export function OpenPathPanel() {
  return (
    <div className="grid min-w-0 gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
      <div>
        <p className="text-sm leading-6 text-fd-muted-foreground">
          The walk can only follow a path some manifest describes. For everything else, TulipFarm
          publishes its entire runtime contract as one file you hand to your own LLM: every
          variable, every decision point, and a verification for every step.
        </p>
      </div>
      <DeployCommand label="the whole contract" />
    </div>
  );
}

/**
 * The questions the chosen manifest asks, as their own stage. Every one is pre-answered with the
 * manifest's default, so a reader confirms rather than faces a blank form; the count in the
 * advance control is what their current answers actually produce, not the manifest's step total.
 */
/**
 * One question, alone on its stage. The question itself is the stage heading, so the fieldset
 * carries it only for screen readers rather than printing it twice.
 */
export function QuestionStage({
  input,
  answer,
  advanceLabel,
  note,
  onAnswer,
  onContinue,
}: {
  input: WizardInput;
  answer: string | undefined;
  advanceLabel: string;
  note?: string;
  onAnswer: (inputId: string, value: string) => void;
  onContinue: () => void;
}) {
  return (
    <div className="min-w-0">
      {note ? <p className="max-w-2xl text-sm leading-6 text-fd-muted-foreground">{note}</p> : null}
      <fieldset className={note ? "mt-6 min-w-0" : "min-w-0"}>
        <legend className="sr-only">{input.question}</legend>
        <div className="grid border-t border-fd-border">
          {input.options.map((option) => (
            <label
              key={option.value}
              className="flex min-h-14 cursor-pointer items-center gap-3 border-b border-fd-border text-sm"
            >
              <input
                type="radio"
                name={input.id}
                value={option.value}
                checked={answer === option.value}
                onChange={() => onAnswer(input.id, option.value)}
                className="accent-fd-primary"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-6">
        <StageAdvance onClick={onContinue}>{advanceLabel}</StageAdvance>
      </div>
    </div>
  );
}

/**
 * The walk itself: a contents rail beside one step rail. Nothing here is stored and nothing is
 * reported — the done set is local React state that dies with the tab.
 */
export function StepsStage({
  target,
  secrets,
  steps,
  done,
  onToggle,
}: {
  target: WizardTarget;
  secrets: WizardSecret[];
  steps: WizardStep[];
  done: ReadonlySet<string>;
  onToggle: (stepId: string) => void;
}) {
  const artifacts = target.artifacts ?? [];
  const remaining = steps.filter((step) => !done.has(step.id)).length;

  return (
    <div className="grid min-w-0 gap-10 lg:grid-cols-[15rem_1fr] lg:gap-14">
      <div className="min-w-0">
        <StepIndex steps={steps} done={done} />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h3 className="text-lg font-bold tracking-tight">{target.title}</h3>
          <Link
            href={targetDocHref(target)}
            className="min-h-11 content-center text-xs text-fd-muted-foreground transition-colors hover:text-fd-primary"
          >
            the full written guide →
          </Link>
        </div>

        {target.tier === "supported" ? null : (
          <div className="mt-4">
            <UnverifiedNotice target={target} />
          </div>
        )}

        <div className="mt-6">
          <StepRail target={target} steps={steps} done={done} onToggle={onToggle} />
        </div>

        {steps.length > 0 && remaining === 0 ? (
          <div className="mt-4 border-l-2 border-fd-primary bg-fd-card px-4 py-3 text-[13px] leading-6">
            <span className="text-fd-foreground">That is the whole path.</span>{" "}
            <span className="text-fd-muted-foreground">
              Every step is marked done, so your instance should be answering on the address you
              configured. Keep the update and backup steps, the two you come back for.
            </span>
          </div>
        ) : null}

        {artifacts.length > 0 ? (
          <div className="mt-8 border-t border-fd-border pt-6">
            <SectionLabel>what your platform consumes</SectionLabel>
            <ul className="mt-3 flex flex-wrap gap-3">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <a
                    href={artifactHref(artifact)}
                    download
                    className="flex min-h-11 items-center rounded-sm border border-fd-border px-4 text-xs transition-colors hover:border-fd-primary hover:text-fd-primary"
                  >
                    {artifactName(artifact)} ↓
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-8">
          <SecretsPanel secrets={secrets} />
        </div>
      </div>
    </div>
  );
}
