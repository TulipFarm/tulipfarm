"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy } from "@/components/icons";
import { SITE_URL } from "@/lib/site";

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

export function DeployCommand({ label }: { label: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [ready, setReady] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function copyCommand() {
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
      return;
    }

    resetTimer.current = setTimeout(() => setCopyState("idle"), 2500);
  }

  useEffect(() => {
    setReady(true);
    return () => {
      clearTimeout(resetTimer.current);
    };
  }, []);

  return (
    <div className="deploy-prompt">
      <div className="prompt-heading">
        <p>{label}</p>
        <button type="button" onClick={copyCommand} disabled={!ready} className="prompt-copy">
          {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          {copyState === "copied" ? "Copied" : "Copy prompt"}
        </button>
      </div>
      {copyState === "failed" && (
        <p className="prompt-error" role="alert">
          Could not copy. Select and copy the prompt text below.
        </p>
      )}
      <pre>
        <code>
          {TOKENS.map((token) => (
            <span key={token.key} className={token.className}>
              {token.value}
            </span>
          ))}
        </code>
      </pre>
      <p className="sr-only" aria-live="polite">
        {copyState === "copied" ? "The deployment prompt was copied to the clipboard." : ""}
      </p>
      <a href={OPEN_PROMPT} className="prompt-guide text-link">
        Read the deployment guide <ArrowRight size={15} />
      </a>
    </div>
  );
}
