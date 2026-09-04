import { type MetaFunction, Outlet, useParams } from "@remix-run/react";
import { Paperclip, Plus } from "~/components/icons";
import { CommandPalette } from "~/components/knowledge/command-palette";
import { KnowledgeTree } from "~/components/knowledge/space-tree";
import { Link } from "~/components/ui/link";
import { Tooltip } from "~/components/ui/tooltip";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

/*
 * Knowledge owns its own tree. The app sidebar is one flat list of destinations with no second
 * layer to swap in, so the space/page hierarchy lives inside the section it belongs to — which is
 * also the only place it was ever useful.
 */
export default function KnowledgeLayout() {
  // `params.id` is the active space on space routes (home/new/graph); page-reader routes carry
  // `pageId` instead, so the scope toggle defaults to all-spaces there.
  const params = useParams();
  return (
    <div className="flex h-full min-h-0">
      <div className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
          <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            Spaces
          </h2>
          <Tooltip content="Files">
            <Link
              to="/knowledge/files"
              aria-label="Files"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Paperclip className="size-4" aria-hidden />
            </Link>
          </Tooltip>
          <Tooltip content="New space">
            <Link
              to="/knowledge/spaces/new"
              aria-label="New space"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" aria-hidden />
            </Link>
          </Tooltip>
        </div>
        <KnowledgeTree />
      </div>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
      <CommandPalette spaceId={params.id} />
    </div>
  );
}
