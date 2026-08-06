import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { cn } from "~/lib/utils";
import type { MentionEntry } from "./use-mention-catalog";

export type UserMessageBubbleProps = {
  messageText: string;
  mentions?: MentionEntry[];
};

/**
 * User Message Bubble: Renders user prompts with automatic height clamping, bottom gradient fade,
 * and an expand/collapse toggle for long messages (matches Screenshot 2 design).
 */
export function UserMessageBubble({ messageText, mentions }: UserMessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = messageText.length > 220 || messageText.split("\n").length > 4;

  return (
    <div className="group relative flex flex-col items-end gap-1 w-full">
      <div
        className={cn(
          "relative w-full max-w-[85%] rounded-2xl border border-border/60 bg-muted/60 px-4 py-3 text-sm text-foreground transition-all dark:bg-zinc-900/80 dark:border-zinc-800",
          !expanded && isLong && "max-h-[140px] overflow-hidden"
        )}
      >
        <div className="[&_:first-child]:mt-0 [&_:last-child]:mb-0">
          <MarkdownView mentions={mentions}>{messageText}</MarkdownView>
        </div>

        {/* Gradient Overlay & Expand Button for Long Messages */}
        {isLong && !expanded ? (
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-center bg-gradient-to-t from-muted via-muted/80 to-transparent pb-1.5 pt-8 dark:from-zinc-900 dark:via-zinc-900/80">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-foreground shadow-sm hover:bg-accent transition-colors"
            >
              <span>Show full message</span>
              <ChevronDown className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      {isLong && expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mr-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <span>Show less</span>
          <ChevronUp className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
