import { MarkdownView } from "~/components/markdown-view";

/**
 * Assistant text rendered as terminal-native markdown (reuses the shared MarkdownView so code, lists,
 * and tables match the rest of the app), with a blinking ruby cursor appended while the turn streams.
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
  return (
    <div className="text-sm">
      {text ? <MarkdownView citations={citations}>{text}</MarkdownView> : null}
      {streaming ? (
        <span aria-hidden className="animate-cursor text-primary">
          ▍
        </span>
      ) : null}
    </div>
  );
}
