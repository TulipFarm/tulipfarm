import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { AgentGlyph } from "~/components/agent-glyph";
import { AutonomyChip } from "~/components/autonomy-chip";
import type { MentionEntry } from "./use-mention-catalog";

const KIND_LABEL: Record<MentionEntry["kind"], string> = {
  agent: "Agent",
  skill: "Skill",
  resource: "Resource type",
  knowledge: "Knowledge",
  file: "File",
};

function MentionChip({ entry, children }: { entry?: MentionEntry; children: ReactNode }) {
  // No catalog match (e.g. the entity was deleted) → plain chip, no card.
  if (!entry) return <span className="tf-mention">{children}</span>;
  const showAgentMeta = entry.kind === "agent" && (entry.domain || entry.autonomy);
  return (
    <span className="group/mention relative inline-block">
      <span className="tf-mention">{children}</span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 flex w-64 max-w-[70vw] -translate-x-1/2 flex-col gap-1.5 rounded-sm border border-border bg-popover p-2.5 text-left text-popover-foreground opacity-0 shadow-md transition-opacity duration-100 group-hover/mention:opacity-100 group-focus-within/mention:opacity-100"
      >
        <span className="flex items-center gap-2">
          {entry.kind === "agent" ? (
            <AgentGlyph
              name={entry.id}
              domain={entry.domain}
              autonomy={entry.autonomy}
              size="sm"
              decorative
              className="shrink-0"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {entry.label}
          </span>
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {KIND_LABEL[entry.kind]}
          </span>
        </span>
        {entry.description ? (
          <span className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
            {entry.description}
          </span>
        ) : null}
        {showAgentMeta ? (
          <span className="flex items-center gap-2 text-[0.625rem] text-muted-foreground">
            {entry.domain ? <span className="truncate">{entry.domain}</span> : null}
            {entry.autonomy ? <AutonomyChip autonomy={entry.autonomy} size="xs" /> : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  return "";
}

/** react-markdown component override: turn the rehype-injected `.tf-mention` spans into chips. */
export function mentionComponents(byPhrase: Map<string, MentionEntry>): Components {
  return {
    span: ({ node: _node, className, children, ...rest }) => {
      if (typeof className === "string" && className.split(" ").includes("tf-mention")) {
        return <MentionChip entry={byPhrase.get(extractText(children))}>{children}</MentionChip>;
      }
      return (
        <span className={className} {...rest}>
          {children}
        </span>
      );
    },
  };
}
