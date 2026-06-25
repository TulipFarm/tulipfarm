import { type MetaFunction, Outlet } from "@remix-run/react";
import { KnowledgeTree } from "~/components/knowledge/space-tree";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

/*
 * Knowledge wiki shell (Notion/Confluence-style). A persistent forest tree rail (all spaces + their
 * pages) on the left, the selected page in the content outlet on the right — the rail stays put while
 * pages swap. The main app sidebar auto-collapses to its icon rail whenever the path is under
 * /knowledge (wired in _app.tsx via `forceCollapsed`), giving the tree rail the freed space. On mobile
 * the tree stacks above the content. Children own their data; the tree self-fetches + refreshes on the
 * `okf:bundle-changed` event.
 */
export default function KnowledgeLayout() {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-[45vh] shrink-0 flex-col border-b border-border bg-sidebar text-sidebar-foreground md:max-h-none md:w-64 md:border-b-0 md:border-r">
        <KnowledgeTree />
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
