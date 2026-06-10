import { MarkdownView } from "~/components/markdown-view";

/**
 * Assistant text rendered as terminal-native markdown (reuses the shared MarkdownView so code, lists,
 * and tables match the rest of the app), with a blinking ruby cursor appended while the turn streams.
 */
export function Response({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="text-sm">
      {text ? <MarkdownView>{text}</MarkdownView> : null}
      {streaming ? (
        <span aria-hidden className="animate-cursor text-primary">
          ▍
        </span>
      ) : null}
    </div>
  );
}
