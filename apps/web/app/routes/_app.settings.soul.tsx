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

  return (
    <div className="flex h-[70vh] min-h-0 gap-4">
      <aside className="w-64 shrink-0 overflow-y-auto rounded-sm border border-border bg-card px-1">
        <SoulTree root={root} selected={selected} onSelect={setSelected} />
      </aside>
      <section className="min-w-0 flex-1 overflow-hidden rounded-sm border border-border bg-card">
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
