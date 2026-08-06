import { Check, ChevronDown, ChevronUp, FileCode } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

export type CodeContextLine = {
  lineNumber: number;
  content: string;
  isRelevant?: boolean;
  annotation?: string;
};

export type CodeContextCardProps = {
  filePath: string;
  language?: string;
  lines: CodeContextLine[];
  initialExpanded?: boolean;
};

/**
 * Code Context Card: Displays code snippets with flagged relevant lines, file path header,
 * syntax layout, and line annotation tags (matches Screenshot 1 design).
 */
export function CodeContextCard({
  filePath,
  language = "ts",
  lines,
  initialExpanded = true,
}: CodeContextCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const relevantCount = lines.filter((l) => l.isRelevant).length;

  return (
    <div className="w-full overflow-hidden rounded-xl border border-border/80 bg-[#121212] text-zinc-100 shadow-sm transition-all dark:bg-[#0c0c0e]">
      {/* Card Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2 text-xs">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex flex-1 items-center gap-2 text-left font-mono text-zinc-300 transition-colors hover:text-white"
        >
          <span className="flex size-4 items-center justify-center rounded-sm bg-emerald-500/20 text-emerald-400">
            <Check className="size-3" />
          </span>
          <span className="flex items-center gap-1.5">
            <FileCode className="size-3.5 text-zinc-400" />
            <span className="font-medium">{filePath}</span>
          </span>
          <span className="text-zinc-500">· {language}</span>
        </button>

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-label={expanded ? "Collapse code context" : "Expand code context"}
          className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>

      {/* Code Block Content */}
      {expanded ? (
        <div className="overflow-x-auto py-2.5 font-mono text-xs leading-relaxed">
          {lines.map((line) => (
            <div
              key={line.lineNumber}
              className={cn(
                "flex items-center justify-between px-3.5 py-0.5 transition-colors",
                line.isRelevant
                  ? "bg-amber-500/10 text-amber-100 dark:bg-amber-500/15"
                  : "hover:bg-white/5 text-zinc-300"
              )}
            >
              <div className="flex items-baseline gap-4 min-w-0">
                <span className="w-6 shrink-0 text-right select-none text-zinc-500 text-[11px]">
                  {line.lineNumber}
                </span>
                <pre className="font-mono text-xs tracking-normal whitespace-pre">
                  {line.content}
                </pre>
              </div>

              {line.isRelevant ? (
                <span className="ml-4 shrink-0 font-sans text-[11px] font-medium text-amber-400/90">
                  {line.annotation ?? "Relevant"}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Footer indicator */}
      {relevantCount > 0 ? (
        <div className="flex items-center gap-1.5 border-t border-white/5 bg-white/[0.02] px-3.5 py-1.5 text-[11px] text-zinc-400">
          <span className="size-1.5 rounded-full bg-amber-400" />
          <span>{relevantCount} relevant lines flagged</span>
        </div>
      ) : null}
    </div>
  );
}
