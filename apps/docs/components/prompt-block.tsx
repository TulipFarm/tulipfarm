"use client";

import { Check, Copy, Sparkles } from "lucide-react";
import { useState } from "react";

/**
 * Renders a ```prompt block: an example message a reader types to the assistant.
 * Distinct from a code block — an AI icon labels it, and a warm ruby→amber
 * gradient underline (the one place gradient is allowed in the otherwise flat,
 * ruby-only design language) marks it as a prompt rather than runnable code.
 */
export function PromptBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

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
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap px-4 pb-4 font-mono text-sm leading-relaxed text-fd-foreground">
        {text}
      </pre>
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-fd-primary via-rose-400 to-amber-400"
      />
    </div>
  );
}
