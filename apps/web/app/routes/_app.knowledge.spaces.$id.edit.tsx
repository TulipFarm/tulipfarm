import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { RestrictDialog } from "~/components/knowledge/restrict-dialog";
import { SpaceDeleteDialog } from "~/components/knowledge/space-delete-dialog";
import { SpaceForm } from "~/components/knowledge/space-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  deleteSpace,
  getSpace,
  getSpaceRestriction,
  listSpacePages,
  listSubjects,
  type PageVisibility,
  restrictSpace,
  type SpaceInput,
  type SubjectDirectory,
  unrestrictSpace,
  updateSpace,
} from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Settings · Spaces · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing space id");
  const [space, pages] = await Promise.all([getSpace(id), listSpacePages(id)]);
  return { space, pageCount: pages.items.length };
}

export default function SpaceEdit() {
  const { space, pageCount } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [spaceVisibility, setSpaceVisibility] = useState<PageVisibility | null>(null);
  const [directory, setDirectory] = useState<SubjectDirectory | null>(null);

  async function openShare() {
    const [r, d] = await Promise.all([getSpaceRestriction(space.id), listSubjects()]);
    const all = [...d.users, ...d.teams, ...d.roles];
    // A Space sits at the top of its own chain, so its restriction is always its own — never
    // inherited, and there is nothing above it to name.
    setSpaceVisibility({
      restricted: r.restricted,
      scope: r.restricted ? "own" : "business",
      own: r.subjects.map(
        (sub) =>
          all.find((c) => c.kind === sub.kind && c.id === sub.id) ?? { ...sub, label: sub.id }
      ),
      inheritedFrom: null,
      readers: [],
    });
    setDirectory(d);
    setSharing(true);
  }

  const detailPath = `/knowledge/spaces/${encodeURIComponent(space.id)}`;

  async function onSubmit(body: SpaceInput) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await updateSpace(space.id, body);
      window.dispatchEvent(new Event("okf:space-changed")); // reflect the renamed space in the tree
      navigate(detailPath);
    } catch (err) {
      // A taken name is a problem with the name, so it belongs against the name field. A banner
      // makes the reader hunt for which input to correct.
      if (err instanceof ApiError && err.status === 409) {
        setFieldErrors({ name: "a space with that name already exists" });
      } else {
        setFormError(err instanceof Error ? err.message : "request failed");
      }
      setSubmitting(false);
    }
  }

  async function onDelete() {
    await deleteSpace(space.id);
    window.dispatchEvent(new Event("okf:space-changed"));
    navigate("/knowledge");
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
        fieldErrors={fieldErrors}
        formError={formError}
        cancelTo={detailPath}
      />

      <section className="mt-8 flex flex-col gap-2 rounded-sm border border-destructive/30 p-4">
        <h2 className="text-sm font-medium text-foreground">Delete this space</h2>
        <p className="text-sm text-muted-foreground">
          {pageCount === 0
            ? "This space has no pages."
            : `Its ${pageCount} ${pageCount === 1 ? "page" : "pages"} will be deleted with it.`}
        </p>
        <div>
          <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-6">
        <h2 className="text-sm font-medium text-foreground">Who can read this space</h2>
        <p className="text-sm text-muted-foreground">
          Restricting a space restricts every page in it, including pages created later.
        </p>
        <div>
          <Button type="button" variant="ghost" onClick={() => void openShare()}>
            Choose who can read it
          </Button>
        </div>
      </section>

      {spaceVisibility && directory ? (
        <RestrictDialog
          open={sharing}
          subjectLabel={space.name}
          visibility={spaceVisibility}
          directory={directory}
          onRestrict={async (subjects) => {
            await restrictSpace(space.id, subjects);
            navigate(".", { replace: true });
          }}
          onClear={async () => {
            await unrestrictSpace(space.id);
            navigate(".", { replace: true });
          }}
          onClose={() => setSharing(false)}
        />
      ) : null}

      <SpaceDeleteDialog
        open={confirming}
        space={{ id: space.id, name: space.name, pageCount }}
        onConfirm={onDelete}
        onClose={() => setConfirming(false)}
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
