import { useLoaderData, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { SoulFileViewer } from "~/components/soul/soul-file-viewer";
import { SoulTree } from "~/components/soul/soul-tree";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getSoulTree } from "~/lib/soul";

// Read-only Soul Explorer: a VS Code-style file tree of the whole soul repo + Shiki source viewer.
export async function clientLoader() {
  const root = await getSoulTree();
  return { root };
}

export default function SettingsSoul() {
  const { root } = useLoaderData<typeof clientLoader>();
  const [selected, setSelected] = useState<string | null>(null);

  if (root.length === 0) {
    return (
      <p className="rounded-sm border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        The soul repo is empty or not initialized.
      </p>
    );
  }

  // One unified explorer shell (VS Code-style): a single hairline border wraps the tree + viewer,
  // split by one internal divider — no floating cards, no gap. Stacks the tree above the viewer on
  // mobile; side-by-side on md+. Fills the remaining viewport height on desktop.
  return (
    <div className="flex h-[32rem] min-h-0 flex-col overflow-hidden rounded-sm border border-border bg-card md:h-[calc(100svh-11rem)] md:flex-row">
      <aside className="flex max-h-56 shrink-0 flex-col overflow-y-auto border-b border-border px-1 py-1 md:max-h-none md:w-64 md:border-b-0 md:border-r">
        <SoulTree root={root} selected={selected} onSelect={setSelected} />
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SoulFileViewer path={selected} />
      </section>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
