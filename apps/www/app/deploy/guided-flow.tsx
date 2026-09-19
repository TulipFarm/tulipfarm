"use client";

import type { WizardSecret } from "@tulipfarm/deploy-render";
import { ArrowRight, ChevronDown } from "@/components/icons";
import { SectionLabel } from "./chrome";
import { OPEN_PROMPT } from "./deploy-command";
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
      deployment definition as the written guide, but we do not boot {target.title} in CI. Review
      them as a starting point and expect to adapt.{" "}
      <a href={OPEN_PROMPT} className="text-fd-primary transition-colors hover:text-fd-primary/80">
        Read the deployment guide
      </a>{" "}
      for the full set of settings.
    </div>
  );
}

function SecretsPanel({ secrets }: { secrets: WizardSecret[] }) {
  return (
    <details className="group border-y border-fd-border">
      <summary className="flex min-h-14 list-none items-center justify-between gap-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>Secrets stay on your machine</span>
        <ChevronDown size={17} className="group-open:rotate-180" />
      </summary>
      <div className="pb-6">
        <p className="max-w-3xl text-sm leading-6 text-fd-muted-foreground">
          This page never asks you to enter a secret. Generate required values on your own machine
          and set them in your platform's environment. To generate the full set:
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

export function OpenPathPanel() {
  return (
    <div>
      <p className="setup-note">
        This platform has no step-by-step guide. Give your assistant the deployment instructions to
        adapt, or choose a documented platform above.
      </p>
      <a href="#assistant-setup" className="button button-primary mt-6">
        Use an AI assistant <ArrowRight size={16} />
      </a>
    </div>
  );
}

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
        <div className="setup-options">
          {input.options.map((option) => (
            <label key={option.value} className="setup-option">
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
          <a
            href={targetDocHref(target)}
            className="min-h-11 content-center text-xs text-fd-muted-foreground transition-colors hover:text-fd-primary"
          >
            Read the full guide
          </a>
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
            <span className="text-fd-foreground">All steps marked done.</span>{" "}
            <span className="text-fd-muted-foreground">
              This page cannot check your server. Use the checks in each step to confirm it works,
              and keep the update and backup instructions for later.
            </span>
          </div>
        ) : null}

        {artifacts.length > 0 ? (
          <div className="mt-8 border-t border-fd-border pt-6">
            <SectionLabel>Deployment files</SectionLabel>
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
