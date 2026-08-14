import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useOutletContext,
} from "@remix-run/react";
import { Network, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { deleteSpace, listAllPages, navigateSpace } from "~/lib/knowledge-api";
import { rewriteOkfLinks } from "~/lib/okf-listing";
import { buildPageResolver } from "~/lib/page-href";
import type { SpaceOutletContext } from "~/routes/_app.knowledge.spaces.$id";

export const meta: MetaFunction = () => [{ title: "Space · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing space id");
  // The root index.md (authored override or synthesized contents) is the space front page.
  // listAllPages → resolver so the index's page links resolve to stable UUID routes.
  const [{ listing }, pages] = await Promise.all([
    navigateSpace(id, ""),
    listAllPages().then((r) => r.items),
  ]);
  return { listing, pages };
}

export default function SpaceHome() {
  const { space } = useOutletContext<SpaceOutletContext>();
  const { listing, pages } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const base = `/knowledge/spaces/${encodeURIComponent(space.id)}`;

  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteSpace(space.id);
      window.dispatchEvent(new Event("okf:space-changed"));
      navigate("/knowledge");
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
      setDeleting(false);
    }
  }

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{space.name}</h1>
        {space.description ? (
          <p className="text-sm text-muted-foreground">{space.description}</p>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-y border-border py-2.5">
        <Button asChild size="sm" className="cursor-pointer">
          <Link to={`${base}/pages/new`}>
            <Plus aria-hidden />
            New page
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="cursor-pointer">
          <Link to={`${base}/pages/new?path=index`}>
            <Pencil aria-hidden />
            Edit front page
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="cursor-pointer">
          <Link to={`${base}/graph`}>
            <Network aria-hidden />
            Graph
          </Link>
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-8 cursor-pointer"
            aria-label="Space settings"
            title="Space settings"
          >
            <Link to={`${base}/edit`}>
              <Settings aria-hidden />
            </Link>
          </Button>

          <Divider />
          {confirming ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                className="cursor-pointer"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? "deleting…" : "Confirm delete"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirming(true)}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">error: {error}</p> : null}

      {/* wikiLinks: the rewritten `/knowledge/...` page links render as in-SPA <Link>s, not new tabs. */}
      <MarkdownView wikiLinks>
        {rewriteOkfLinks(listing, space.id, buildPageResolver(pages))}
      </MarkdownView>
    </article>
  );
}

// Thin vertical rule that visually groups the toolbar's primary actions from the space-level ones.
function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}
