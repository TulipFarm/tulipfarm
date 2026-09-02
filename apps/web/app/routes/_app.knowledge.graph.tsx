import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { KnowledgeGraphView } from "~/components/knowledge/knowledge-graph";
import { ErrorState, NotFoundState } from "~/components/states";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { getKnowledgeGraph } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Graph · Knowledge · tulipfarm" }];

export async function clientLoader() {
  return { graph: await getKnowledgeGraph() };
}

export default function KnowledgeGraphRoute() {
  const { graph } = useLoaderData<typeof clientLoader>();

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground"
        >
          <Link to="/knowledge" className="transition-colors hover:text-foreground">
            Knowledge
          </Link>
          <span aria-hidden className="opacity-40">
            /
          </span>
          <span className="text-foreground">graph</span>
        </nav>
        <header className="flex flex-col gap-1">
          <h1 className="text-base font-bold text-foreground">How your knowledge is connected</h1>
          <p className="text-sm text-muted-foreground">
            Every page you can read, and the links between them, across all spaces.
          </p>
        </header>
        <KnowledgeGraphView graph={graph} />
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
