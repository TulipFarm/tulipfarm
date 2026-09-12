/* Opens the shared CommandPalette instead of duplicating search state. */
import { Search } from "~/components/icons";
import { OPEN_SEARCH_EVENT } from "./command-palette";

export function SidebarSearch() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
      aria-label="Search knowledge"
      className="mx-2 mb-1 flex min-h-7 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground pointer-coarse:min-h-11"
    >
      <Search className="size-3.5 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded-sm border border-border px-1 py-0.5 font-mono text-[0.625rem] leading-none">
        ⌘K
      </kbd>
    </button>
  );
}
