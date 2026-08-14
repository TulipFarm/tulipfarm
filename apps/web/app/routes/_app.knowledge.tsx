import { type MetaFunction, Outlet, useParams } from "@remix-run/react";
import { CommandPalette } from "~/components/knowledge/command-palette";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

/* The app sidebar force-collapses under /knowledge; children own their data. */
export default function KnowledgeLayout() {
  // `params.id` is the active space on space routes (home/new/graph); page-reader routes carry
  // `pageId` instead, so the scope toggle defaults to all-spaces there.
  const params = useParams();
  return (
    <div className="h-full min-h-0">
      <Outlet />
      <CommandPalette spaceId={params.id} />
    </div>
  );
}
