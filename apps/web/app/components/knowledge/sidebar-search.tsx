/* Opens the shared CommandPalette instead of duplicating search state. */
import { Search } from "lucide-react";
import { OPEN_SEARCH_EVENT } from "./command-palette";

export function SidebarSearch() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
      aria-label="Search knowledge"
      className="mx-2 mb-1 flex cursor-pointer items-center gap-2 rounded-sm border border-border bg-background/40 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Search className="size-3.5 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded-sm border border-border px-1 py-0.5 font-mono text-[0.625rem] leading-none">
        ⌘K
      </kbd>
    </button>
  );
}
