import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  Outlet,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getBundle, type KnowledgeBundle } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Bundle · Knowledge · tulipfarm" }];

export type BundleOutletContext = { bundle: KnowledgeBundle };

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing bundle id");
  const bundle = await getBundle(id);
  return { bundle };
}

/*
 * Per-space wrapper: loads the bundle and hands it to the nested page routes (front page, a concept,
 * the graph, or a form) via the outlet context. The page-tree rail lives in the shell
 * (_app.knowledge.tsx) and persists across spaces, so this route holds no chrome of its own.
 */
export default function BundleWorkspace() {
  const { bundle } = useLoaderData<typeof clientLoader>();
  return <Outlet context={{ bundle } satisfies BundleOutletContext} />;
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
