"use client";

import { Check, Copy, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

/** One string for one event, so the visible hint and the announced hint cannot drift apart. */
const copyFailedMessage = "Copy failed. Select the prompt and copy it.";

/** Renders ```prompt blocks; the one allowed gradient marks prompts, not runnable code. */
export function PromptBlock({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(resetTimer.current);
    },
    []
  );

  async function copy() {
    clearTimeout(resetTimer.current);

    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      resetTimer.current = setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  return (
    <div className="not-prose relative my-4 overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-fd-muted-foreground">
          <Sparkles className="size-3.5 text-fd-primary" aria-hidden />
          Prompt
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy prompt"
          className="cursor-pointer text-fd-muted-foreground transition-colors hover:text-fd-foreground"
        >
          {copyState === "copied" ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap px-4 pb-4 font-mono text-sm leading-relaxed text-fd-foreground">
        {text}
      </pre>
      {copyState === "failed" && (
        <p className="px-4 pb-3 text-xs text-fd-muted-foreground">{copyFailedMessage}</p>
      )}
      <p className="sr-only" aria-live="polite">
        {copyState === "copied"
          ? "Prompt copied to the clipboard."
          : copyState === "failed"
            ? copyFailedMessage
            : ""}
      </p>
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 bg-linear-to-r/oklab from-fd-primary to-fd-primary/20"
      />
    </div>
  );
}
