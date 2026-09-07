import { useEffect, useRef, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import type { StreamWordCounter } from "~/lib/rehype-stream-words";

/**
 * `.tf-word-in` runs a 420ms transition plus up to `--word-delay` per word (`app.css`); this is
 * how long the pipeline stays in streaming mode after `streaming` itself goes false, so the last
 * batch's spans can finish before the rebuild to plain text happens on an already-settled pass.
 */
const STREAM_WORD_SETTLE_MS = 600;

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

  // `streaming` flips false in the same commit that seals the message. Dropping the streamWords
  // plugin on that same render rebuilds every already-transitioning `.tf-word-in` span straight to
  // plain text mid-animation — the outgoing glyphs visibly smear. Holding the pipeline in streaming
  // mode for one settle period lets that last batch finish before the rebuild happens.
  const [settled, setSettled] = useState(streaming !== true);
  useEffect(() => {
    if (streaming) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), STREAM_WORD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [streaming]);

  const animating = streaming === true || !settled;

  return (
    <div>
      {text ? (
        <MarkdownView
          citations={citations}
          streamWords={animating ? { from: revealed.current, counter: counter.current } : undefined}
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
