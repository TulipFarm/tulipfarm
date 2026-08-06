import { Check, ChevronDown, ChevronUp, Globe, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

export type SearchStepItem = {
  id: string;
  title: string;
  domain?: string;
  url?: string;
  status: "done" | "searching" | "pending";
  iconType?: "check" | "grid" | "circle";
};

export type SearchProgressBlockProps = {
  query: string;
  items: SearchStepItem[];
  isSearching?: boolean;
  onStop?: () => void;
  initialExpanded?: boolean;
};

/**
 * Search Progress Block: Renders live search query and step-by-step sources/status
 * with execution indicators (matches Screenshot 1 design).
 */
export function SearchProgressBlock({
  query,
  items,
  isSearching = false,
  onStop,
  initialExpanded = true,
}: SearchProgressBlockProps) {
  const [expanded, setExpanded] = useState(initialExpanded);

  return (
    <div className="w-full space-y-2 py-1 font-sans">
      {/* Header Bar */}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex flex-1 items-center gap-2 text-left font-medium text-foreground hover:opacity-85"
        >
          <Sparkles className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">
            Searching <span className="font-semibold text-foreground">"{query}"</span>
          </span>
          <span className="text-muted-foreground">
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </span>
        </button>

        {isSearching && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            Stop
          </button>
        ) : null}
      </div>

      {/* Step items list */}
      {expanded ? (
        <div className="ml-1 space-y-1.5 border-l-2 border-border/60 pl-3.5 text-xs">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-muted-foreground">
              {/* Status Icon */}
              <span className="flex size-4 shrink-0 items-center justify-center">
                {item.status === "done" ? (
                  <span className="flex size-3.5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <Check className="size-2.5" />
                  </span>
                ) : item.status === "searching" ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                ) : (
                  <span className="size-2 rounded-full border border-muted-foreground/40" />
                )}
              </span>

              {/* Globe & Domain detail */}
              <Globe className="size-3.5 shrink-0 text-muted-foreground/70" />

              <div className="flex min-w-0 items-center gap-1.5 truncate">
                <span
                  className={cn(
                    "truncate font-medium",
                    item.status === "done" ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {item.title}
                </span>

                {item.domain ? (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-muted-foreground hover:text-primary hover:underline"
                      >
                        {item.domain}
                      </a>
                    ) : (
                      <span className="truncate text-muted-foreground/80">{item.domain}</span>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
