import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  Outlet,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getSpace, type KnowledgeSpace } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Space · Knowledge · tulipfarm" }];

export type SpaceOutletContext = { space: KnowledgeSpace };

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing space id");
  const space = await getSpace(id);
  return { space };
}

/*
 * Per-space wrapper: loads the space and hands it to the nested page routes (front page, a page,
 * the graph, or a form) via the outlet context. The page-tree rail lives in the shell
 * (_app.knowledge.tsx) and persists across spaces, so this route holds no chrome of its own.
 */
export default function SpaceWorkspace() {
  const { space } = useLoaderData<typeof clientLoader>();
  return <Outlet context={{ space } satisfies SpaceOutletContext} />;
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
