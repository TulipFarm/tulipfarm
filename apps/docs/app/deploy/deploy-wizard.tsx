"use client";

import type { WizardModel } from "@tulipfarm/deploy-render";
import { useEffect, useRef, useState } from "react";
import { OTHER, SectionLabel } from "./chrome";
import { DeployCommand } from "./deploy-command";
import { OpenPathPanel, QuestionStage, StepsStage } from "./guided-flow";
import {
  type Answers,
  activeInputs,
  applicableSteps,
  chosenLabel,
  defaultAnswers,
  guidedTargets,
  inputStageId,
  type StageId,
  stageOrder,
} from "./model";
import { PlatformChooser } from "./platform-chooser";
import { type StageState, stageDomId, WizardStage } from "./stage";

export function DeployWizard({ model }: { model: WizardModel }) {
  const targets = guidedTargets(model);
  const [selected, setSelected] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [stage, setStage] = useState<StageId>("platform");

  const active = targets.find((target) => target.name === selected) ?? null;
  const steps = active ? applicableSteps(active, answers) : [];
  const questions = active ? activeInputs(active, answers) : [];
  const order = stageOrder(active, answers);

  function stateOf(id: StageId): StageState {
    if (id === stage) return "active";
    return order.indexOf(id) < order.indexOf(stage) ? "done" : "upcoming";
  }

  const settled = useRef(false);
  useEffect(() => {
    // Never scroll on first paint — the reader arrived at the top of the page on purpose. Only a
    // transition they caused moves the viewport.
    if (!settled.current) {
      settled.current = true;
      return;
    }
    const element = document.getElementById(stageDomId(stage));
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [stage]);

  function selectPlatform(value: string) {
    setSelected(value);
    setDone(new Set());
    const target = targets.find((candidate) => candidate.name === value);
    const next = target ? defaultAnswers(target) : {};
    setAnswers(next);
    setStage(stageOrder(target ?? null, next)[1]);
  }

  function answer(inputId: string, value: string) {
    setAnswers((current) => ({ ...current, [inputId]: value }));
  }

  function toggleStep(stepId: string) {
    setDone((current) => {
      const next = new Set(current);
      if (!next.delete(stepId)) next.add(stepId);
      return next;
    });
  }

  const platformLabel = active ? active.title : selected === OTHER ? "Somewhere else" : undefined;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-x-clip">
      <section className="mx-auto w-full max-w-6xl px-4 pt-10 pb-8 sm:px-6 sm:pt-12">
        <SectionLabel>[deploy tulipfarm]</SectionLabel>
        <h1
          className="mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl motion-safe:animate-rise"
          style={{ animationDelay: "120ms" }}
        >
          Two ways to get a running instance.
        </h1>
        <p
          className="mt-4 max-w-xl text-sm leading-6 text-fd-muted-foreground sm:text-base motion-safe:animate-rise"
          style={{ animationDelay: "200ms" }}
        >
          Hand the whole contract to your own LLM, or walk the steps yourself. Both read the same
          manifest.
        </p>
      </section>

      <section className="border-t border-fd-border">
        <div className="mx-auto grid w-full max-w-6xl divide-y divide-fd-border px-4 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:divide-x lg:divide-y-0">
          <div className="py-8 lg:pr-14">
            <div className="flex items-baseline gap-3">
              <SectionLabel>[path 01]</SectionLabel>
              <p className="text-xs text-fd-muted-foreground">fastest</p>
            </div>
            <h2 className="mt-4 text-xl font-bold tracking-tight">Hand it to your LLM</h2>
            <p className="mt-3 max-w-lg text-sm leading-6 text-fd-muted-foreground">
              Three lines put the entire deployment contract in front of the model you already use.
              It asks you what it needs and adapts the steps to the machine in front of you.
            </p>
            <div className="mt-6 motion-safe:animate-rise" style={{ animationDelay: "260ms" }}>
              <DeployCommand label="the whole contract" />
            </div>
          </div>

          <div className="flex flex-col py-8 lg:pl-14">
            <div className="flex items-baseline gap-3">
              <SectionLabel>[path 02]</SectionLabel>
              <p className="text-xs text-fd-muted-foreground">no model required</p>
            </div>
            <h2 className="mt-4 text-xl font-bold tracking-tight">Walk it yourself</h2>
            <p className="mt-3 max-w-lg text-sm leading-6 text-fd-muted-foreground">
              Answer two questions about your setup, then work a checklist. Each step names the
              command to run and what a passing result looks like.
            </p>
            <ul className="mt-6 border-t border-fd-border text-sm">
              {targets.map((target) => (
                <li
                  key={target.name}
                  className="flex min-h-11 items-center border-b border-fd-border"
                >
                  <span className="text-fd-muted-foreground">{target.title}</span>
                </li>
              ))}
            </ul>
            <a
              href={`#${stageDomId("platform")}`}
              className="mt-6 flex min-h-11 w-max items-center rounded-sm bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground transition-colors duration-150 hover:bg-fd-primary/90"
            >
              [+] start the walk ↓
            </a>
          </div>
        </div>
      </section>

      <WizardStage
        id="platform"
        index={order.indexOf("platform")}
        title="Where are you deploying?"
        state={stateOf("platform")}
        summary={platformLabel}
        onReopen={() => setStage("platform")}
      >
        <p className="text-sm leading-6 text-fd-muted-foreground">
          Nothing you pick here leaves your browser.
        </p>
        <div className="mt-4">
          <PlatformChooser targets={targets} selected={selected} onSelect={selectPlatform} />
        </div>
      </WizardStage>

      {active
        ? questions.map((input, position) => {
            const id = inputStageId(input.id);
            const next = questions[position + 1];
            return (
              <WizardStage
                key={input.id}
                id={id}
                index={order.indexOf(id)}
                title={input.question}
                state={stateOf(id)}
                summary={stateOf(id) === "done" ? chosenLabel(input, answers) : undefined}
                onReopen={() => setStage(id)}
              >
                <QuestionStage
                  input={input}
                  answer={answers[input.id]}
                  note={
                    position === 0
                      ? "Your answers decide which steps you get. Each one is already set to what most instances use, so change what differs and carry on."
                      : undefined
                  }
                  advanceLabel={next ? "[→] next question" : `[→] show my ${steps.length} steps`}
                  onAnswer={answer}
                  onContinue={() => setStage(next ? inputStageId(next.id) : "steps")}
                />
              </WizardStage>
            );
          })
        : null}

      {active ? (
        <WizardStage
          id="steps"
          index={order.indexOf("steps")}
          title={`Run the steps — ${steps.length} of them`}
          state={stateOf("steps")}
        >
          <StepsStage
            key={active.name}
            target={active}
            secrets={model.secrets}
            steps={steps}
            done={done}
            onToggle={toggleStep}
          />
        </WizardStage>
      ) : null}

      {selected === OTHER ? (
        <WizardStage
          id="steps"
          index={order.indexOf("steps")}
          title="There are no steps to walk"
          state="active"
        >
          <OpenPathPanel />
        </WizardStage>
      ) : null}

      {selected === null ? (
        <WizardStage
          id="steps"
          index={1}
          title="Answer a few questions, then run the steps"
          state="upcoming"
        />
      ) : null}
    </main>
  );
}
