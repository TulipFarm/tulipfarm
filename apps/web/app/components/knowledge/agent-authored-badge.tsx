import { Bot } from "lucide-react";
import type { ReactElement } from "react";

/**
 * Marks a Page an Agent wrote.
 *
 * A reader weighs a document differently depending on whether a colleague wrote it or an Agent
 * generated it, so this carries an icon *and* a word rather than a tint — tone alone would make the
 * distinction invisible to anyone who cannot see it, which is exactly the readers who need it.
 *
 * A Page with an unknown author renders nothing. Absence of the badge means "not known to be
 * Agent-written", never "written by a person".
 */
export function AgentAuthoredBadge({
  authorKind,
  compact = false,
}: {
  authorKind?: string | null;
  compact?: boolean;
}): ReactElement | null {
  if (authorKind !== "agent") return null;

  if (compact) {
    return (
      <span
        className="inline-flex shrink-0 items-center text-muted-foreground"
        title="Written by an Agent"
      >
        <Bot className="size-3" aria-hidden />
        <span className="sr-only">Written by an Agent</span>
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
      <Bot className="size-3" aria-hidden />
      Agent
    </span>
  );
}
