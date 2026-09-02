import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useOutletContext,
  useRouteError,
} from "@remix-run/react";
import { SpaceGraphView } from "~/components/knowledge/space-graph";
import { ErrorState, NotFoundState } from "~/components/states";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { getSpaceGraph, listAllPages } from "~/lib/knowledge-api";
import type { SpaceOutletContext } from "~/routes/_app.knowledge.spaces.$id";

export const meta: MetaFunction = () => [{ title: "Graph · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing space id");
  const [graph, pages] = await Promise.all([
    getSpaceGraph(id),
    listAllPages().then((r) => r.items),
  ]);
  return { graph, pages };
}

export default function SpaceGraphRoute() {
  const { graph, pages } = useLoaderData<typeof clientLoader>();
  const { space } = useOutletContext<SpaceOutletContext>();
  const base = `/knowledge/spaces/${encodeURIComponent(space.id)}`;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground"
        >
          <Link to={base} className="transition-colors hover:text-foreground">
            {space.name}
          </Link>
          <span aria-hidden className="opacity-40">
            /
          </span>
          <span className="text-foreground">graph</span>
        </nav>
        <h1 className="text-base font-bold text-foreground">Cross-link graph</h1>
        <SpaceGraphView graph={graph} pages={pages} />
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="knowledge" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
