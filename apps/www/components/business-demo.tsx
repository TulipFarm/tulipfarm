"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { BusinessExample } from "@/lib/examples";
import { docsUrl } from "@/lib/site";
import { TulipMark } from "./brand";
import {
  ArrowRight,
  Check,
  ChevronDown,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
} from "./icons";
import { ProductPreview } from "./product-preview";

function ChatCapture({ example }: { example: BusinessExample }) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth === 0) setFailed(true);
  }, []);

  return (
    <details className="capture-disclosure">
      <summary>
        <span>See the actual chat interface</span>
        <ChevronDown size={16} />
      </summary>
      <div className="chat-capture">
        {failed ? (
          <p role="alert" className="capture-error">
            The chat image could not load. The prepared request and result are still available
            above.
          </p>
        ) : (
          <Image
            ref={image}
            src={example.capture}
            width={1200}
            height={594}
            loading="eager"
            alt={`TulipFarm chat with a prepared request: ${example.request}`}
            onError={() => setFailed(true)}
          />
        )}
        <p>Actual chat UI with an unsent example request. No live agent is running on this page.</p>
      </div>
    </details>
  );
}

function ExamplePlayback({ example, ready }: { example: BusinessExample; ready: boolean }) {
  const [stepIndex, setStepIndex] = useState(example.steps.length - 1);
  const [playing, setPlaying] = useState(false);
  const step = example.steps[stepIndex];
  const finalIndex = example.steps.length - 1;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      const next = Math.min(stepIndex + 1, finalIndex);
      setStepIndex(next);
      if (next === finalIndex) setPlaying(false);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [playing, stepIndex, finalIndex]);

  function replay() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStepIndex(finalIndex);
      setPlaying(false);
    } else {
      setStepIndex(0);
      setPlaying(true);
    }
  }

  function selectStep(index: number) {
    setPlaying(false);
    setStepIndex(index);
  }

  return (
    <div className="demo-playback" data-example={example.id} data-phase={stepIndex}>
      <div className="story-flow">
        <div className="story-request">
          <span className="request-label">
            <MessageSquare size={17} /> Your request
          </span>
          <blockquote>{example.request}</blockquote>
          <span className="request-footnote">Your words are the starting point.</span>
        </div>
        <div className="flow-handoff" aria-hidden="true">
          <div className="handoff-line" />
          <span className="handoff-mark">
            <TulipMark size={36} />
          </span>
          <div className="handoff-line handoff-out">
            <ArrowRight size={15} />
          </div>
          <span className="handoff-label">TulipFarm</span>
        </div>
        <figure className="result-window">
          <figcaption>
            <div className="result-title">
              <span className="result-symbol">
                <Plus size={18} />
              </span>
              <div>
                <p>{example.title}</p>
                <h3>{step.heading}</h3>
              </div>
            </div>
            <span className="sample-label">Sample data</span>
          </figcaption>
          <div
            className="demo-result"
            key={step.label}
            data-component={step.artifact.component.name}
          >
            <ProductPreview artifact={step.artifact} />
          </div>
          <p className="story-result-note">
            {stepIndex === finalIndex ? (
              <>
                <Check size={14} /> {example.resultNote}
              </>
            ) : (
              step.description
            )}
          </p>
        </figure>
      </div>
      <div className="demo-bottom">
        <fieldset className="demo-path" disabled={!ready}>
          <legend className="sr-only">Example progression</legend>
          {example.steps.map((item, index) => (
            <button
              key={item.label}
              type="button"
              onClick={() => selectStep(index)}
              aria-pressed={stepIndex === index}
              className="demo-step"
            >
              {item.label}
              {index < finalIndex && <ArrowRight size={13} />}
            </button>
          ))}
        </fieldset>
        <fieldset className="demo-controls" disabled={!ready}>
          <legend className="sr-only">Example playback</legend>
          <button
            className="replay-button"
            type="button"
            onClick={playing ? () => setPlaying(false) : replay}
          >
            {!playing && <Play size={14} />}
            {playing ? "Pause story" : "Replay story"}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Reset example"
            onClick={() => selectStep(0)}
          >
            <RotateCcw size={16} />
          </button>
        </fieldset>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {example.label}: {step.label}
        {playing ? " (playing)" : ""}.
      </p>
    </div>
  );
}

export function BusinessDemo({ examples }: { examples: readonly BusinessExample[] }) {
  const [selected, setSelected] = useState(examples[0]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <section className="example-section site-container" id="examples" aria-labelledby="scene-title">
      {examples.map((example) => (
        <link key={example.id} rel="preload" as="image" href={example.capture} />
      ))}
      <h2 id="scene-title" className="sr-only">
        {selected.sceneTitle}
      </h2>
      <div className="story-stage">
        <div className="scene-header">
          <fieldset className="example-choices" disabled={!ready}>
            <legend className="sr-only">Choose a prepared example</legend>
            {examples.map((example) => {
              const Icon =
                example.id === "customers"
                  ? Plus
                  : example.id === "support"
                    ? ShieldCheck
                    : RotateCcw;
              return (
                <button
                  key={example.id}
                  type="button"
                  aria-pressed={selected.id === example.id}
                  aria-controls="example-story"
                  onClick={() => setSelected(example)}
                >
                  <Icon size={17} />
                  {example.label}
                </button>
              );
            })}
          </fieldset>
          <span className="example-label">Prepared example</span>
        </div>
        <div id="example-story">
          <ExamplePlayback key={selected.id} example={selected} ready={ready} />
        </div>
      </div>
      <div className="scene-caption">
        <p className="demo-caption">
          {ready
            ? "Illustrated flow. Real product components. Fixed sample data."
            : "Static preview. Interactive controls need JavaScript; enable it or reload to try again."}
        </p>
        <a href={docsUrl(selected.docsPath)} className="text-link">
          How this works <ArrowRight size={14} />
        </a>
      </div>
      <ChatCapture key={selected.id} example={selected} />
      <noscript>
        <p className="demo-caption">
          Enable JavaScript to switch examples. The documentation and setup guide work without it.
        </p>
      </noscript>
    </section>
  );
}
