"use client";

import { useEffect, useRef, useState } from "react";
import { SITE_URL } from "@/lib/shared";

/** Where the single-file prompt is served from, relative to the site root. */
export const OPEN_PROMPT = "/deploy.txt";

const PROMPT_URL = `${SITE_URL}${OPEN_PROMPT}`;

/**
 * What a reader pastes into ChatGPT, Claude Code, Codex or Copilot. It is prose, not a shell
 * command: the assistant is the thing being addressed, and `deploy.txt` opens by telling it that
 * a human pointed it here. The third line is load-bearing — the file asks decision questions, and
 * without it a model tends to guess an answer and start running commands.
 */
const PROMPT = `Deploy TulipFarm on my own infrastructure.
Read ${PROMPT_URL} and follow it exactly.
Ask me the questions it lists before you run anything.`;

const TOKENS = [
  { key: "open", value: "Deploy TulipFarm on my own infrastructure.\nRead ", className: "" },
  { key: "url", value: PROMPT_URL, className: "text-fd-primary" },
  {
    key: "close",
    value: " and follow it exactly.\nAsk me the questions it lists before you run anything.",
    className: "",
  },
];

type CopyState = "idle" | "copied" | "failed";

/**
 * The `/deploy.txt` prompt as a copyable block, matching the home page's install command. This is
 * the LLM path's entire interface, so it carries prose a reader pastes into an assistant rather
 * than a command they run in a shell. `navigator.clipboard` is a browser API, so the page still
 * makes no request after load.
 */
export function DeployCommand({ label }: { label: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2500);
  }

  useEffect(
    () => () => {
      clearTimeout(resetTimer.current);
    },
    []
  );

  const copyLabel =
    copyState === "copied" ? "[copied]" : copyState === "failed" ? "[copy failed]" : "[copy]";

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-fd-border px-4">
        <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">[{label}]</p>
        <p className="text-xs text-fd-muted-foreground">one file · no account</p>
      </div>
      <div className="min-w-0 p-4 sm:p-5">
        <p className="mb-3 text-xs leading-5 text-fd-muted-foreground">
          Paste this into{" "}
          <span className="text-fd-foreground">ChatGPT, Claude Code, Codex or Copilot.</span>
        </p>
        <div className="relative min-w-0 border border-fd-border bg-fd-background">
          <pre className="min-h-13 whitespace-pre-wrap px-4 py-3.5 pr-20 text-xs leading-6 tracking-[-0.02em]">
            <code className="[overflow-wrap:anywhere]">
              {TOKENS.map((token) => (
                <span key={token.key} className={token.className}>
                  {token.value}
                </span>
              ))}
            </code>
          </pre>
          <button
            type="button"
            onClick={copyCommand}
            aria-label="Copy the deployment prompt"
            className="absolute right-0 top-0 min-h-11 w-[4.5rem] cursor-pointer border-b border-l border-fd-border bg-fd-background/80 text-xs font-medium text-fd-muted-foreground transition-colors duration-150 hover:bg-fd-accent hover:text-fd-foreground focus-visible:bg-fd-accent focus-visible:text-fd-foreground"
          >
            {copyLabel}
          </button>
        </div>
        <p className="sr-only" aria-live="polite">
          {copyState === "copied"
            ? "The deployment prompt was copied to the clipboard."
            : copyState === "failed"
              ? "The prompt could not be copied. Select and copy the visible text."
              : ""}
        </p>
        <p className="mt-4 text-[13px] leading-6 text-fd-muted-foreground">
          Every variable, every decision point, and a verification for every step. The same manifest
          this page reads, written for a model to follow.
        </p>
        <a
          href={OPEN_PROMPT}
          className="mt-1 flex min-h-11 w-max items-center text-xs text-fd-primary transition-colors duration-150 hover:text-fd-primary/80"
        >
          read it yourself →
        </a>
      </div>
    </div>
  );
}
