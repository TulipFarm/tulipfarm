"use client";

import type { WizardModel } from "@tulipfarm/deploy-render";
import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "@/components/icons";
import { docsUrl } from "@/lib/site";
import { OTHER } from "./chrome";
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
  const [ready, setReady] = useState(false);

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
    setReady(true);
  }, []);

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
    element.querySelector<HTMLHeadingElement>("h2")?.focus({ preventScroll: true });
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
    <main id="main-content" className="deploy-wizard site-container">
      <section className="setup-intro" aria-labelledby="setup-title">
        <h1 id="setup-title">Make TulipFarm yours.</h1>
        <p>
          Use the guided setup, or give your AI assistant the installation prompt. Everything runs
          on your infrastructure.
        </p>
        <div className="setup-actions">
          <a href="#setup-guide" className="button button-primary">
            Guided setup <ArrowRight size={17} className="down-arrow" />
          </a>
          <a href="#assistant-setup" className="text-link">
            Use an AI assistant <ArrowRight size={17} />
          </a>
        </div>
      </section>

      <div className="setup-grid" data-checklist={stage === "steps" && active !== null}>
        <div className="setup-flow" id="setup-guide">
          <WizardStage
            id="platform"
            index={order.indexOf("platform")}
            title="Where are you deploying?"
            state={stateOf("platform")}
            summary={platformLabel}
            onReopen={() => setStage("platform")}
          >
            <p className="setup-note">
              Choose a host to get its setup steps. Your choices stay in this browser.
            </p>
            {!ready && (
              <p className="setup-fallback">
                Setup controls need JavaScript. Enable it or reload to try again, or{" "}
                <a href={docsUrl("/self-hosting")}>Read the setup docs</a>.
              </p>
            )}
            <PlatformChooser
              targets={targets}
              selected={selected}
              onSelect={selectPlatform}
              disabled={!ready}
            />
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
                          ? "We've selected the documented defaults. Change anything that differs from your setup."
                          : undefined
                      }
                      advanceLabel={next ? "Next question" : `Show ${steps.length} steps`}
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
              title="Your setup checklist"
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
              title="Use the installation prompt."
              state="active"
            >
              <OpenPathPanel />
            </WizardStage>
          ) : null}

          {selected === null ? (
            <WizardStage
              id="steps"
              index={1}
              title="Next: questions about your setup"
              state="upcoming"
            />
          ) : null}
        </div>
        <aside className="setup-assistant" id="assistant-setup" aria-labelledby="assistant-title">
          <h2 id="assistant-title">Let your assistant help.</h2>
          <p>
            Paste this into ChatGPT, Claude Code, Codex, or Copilot. It points to the same
            installation instructions as the guided setup.
          </p>
          <DeployCommand label="Installation prompt" />
          <p className="assistant-note">
            Review what your assistant proposes before it runs commands on your machine.
          </p>
        </aside>
      </div>
    </main>
  );
}
