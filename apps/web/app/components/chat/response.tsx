import { useEffect, useRef } from "react";
import { MarkdownView } from "~/components/markdown-view";
import type { StreamWordCounter } from "~/lib/rehype-stream-words";

/**
 * Assistant text rendered as terminal-native markdown (reuses the shared MarkdownView so code, lists,
 * and tables match the rest of the app): each newly streamed word blurs into place, settled words
 * stay put, and a blinking ruby cursor trails the edge while the turn streams.
 */
export function Response({
  text,
  streaming,
  citations,
}: {
  text: string;
  streaming?: boolean;
  /** Inline `[n]` → cited-page link map, derived from the message's sources part. */
  citations?: { ref: number; url: string }[];
}) {
  // `revealed` has to lag one render behind `counter.total`: this render still needs the *previous*
  // pass's word count to know which words are new, so the ref only advances after commit.
  const revealed = useRef(0);
  const counter = useRef<StreamWordCounter>({ total: 0 });
  useEffect(() => {
    revealed.current = counter.current.total;
  });

  return (
    <div>
      {text ? (
        <MarkdownView
          citations={citations}
          streamWords={streaming ? { from: revealed.current, counter: counter.current } : undefined}
        >
          {text}
        </MarkdownView>
      ) : null}
      {streaming ? (
        <span aria-hidden className="animate-cursor text-primary">
          ▍
        </span>
      ) : null}
    </div>
  );
}
