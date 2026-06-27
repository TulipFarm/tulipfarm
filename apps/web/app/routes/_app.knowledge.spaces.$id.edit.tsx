import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { SpaceForm } from "~/components/knowledge/space-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getSpace, type SpaceInput, updateSpace } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Edit · Spaces · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing space id");
  const space = await getSpace(id);
  return { space };
}

export default function SpaceEdit() {
  const { space } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const detailPath = `/knowledge/spaces/${encodeURIComponent(space.id)}`;

  async function onSubmit(body: SpaceInput) {
    setSubmitting(true);
    setFormError(null);
    try {
      await updateSpace(space.id, body);
      window.dispatchEvent(new Event("okf:space-changed")); // reflect the renamed space in the tree
      navigate(detailPath);
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "a space with that name already exists"
          : err instanceof Error
            ? err.message
            : "request failed";
      setFormError(message);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: space.name, to: detailPath },
    { label: "settings" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <SpaceForm
        mode="edit"
        initial={{ name: space.name, description: space.description }}
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
        cancelTo={detailPath}
      />
    </ResourcePanel>
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
