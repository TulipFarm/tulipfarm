import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { SoulFileViewer } from "~/components/soul/soul-file-viewer";
import { SoulGitConfigPanel } from "~/components/soul/soul-git-config";
import { SoulTree } from "~/components/soul/soul-tree";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getGitConfig, getSoulTree } from "~/lib/soul";

// Read-only Soul Explorer: a VS Code-style file tree of the whole soul repo + Shiki source viewer,
// plus a git remote config + sync status panel.
export async function clientLoader() {
  const [root, gitConfig] = await Promise.all([getSoulTree(), getGitConfig()]);
  return { root, gitConfig };
}

export default function SettingsSoul() {
  const { root, gitConfig } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <SoulGitConfigPanel config={gitConfig} onSaved={() => revalidator.revalidate()} />

      {root.length === 0 ? (
        <p className="rounded-sm border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          The soul repo is empty or not initialized.
        </p>
      ) : (
        // One unified explorer shell (VS Code-style): a single hairline border wraps the tree +
        // viewer, split by one internal divider — no floating cards, no gap. Stacks the tree above
        // the viewer on mobile; side-by-side on md+. Fills the remaining viewport height on desktop.
        <div className="flex h-[32rem] min-h-0 flex-col overflow-hidden rounded-sm border border-border bg-card md:h-[calc(100svh-11rem)] md:flex-row">
          <aside className="flex max-h-56 shrink-0 flex-col overflow-y-auto border-b border-border px-1 py-1 md:max-h-none md:w-64 md:border-b-0 md:border-r">
            <SoulTree root={root} selected={selected} onSelect={setSelected} />
          </aside>
          <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <SoulFileViewer path={selected} />
          </section>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
