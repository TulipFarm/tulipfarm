import type { ReactNode } from "react";

/*
 * Shared empty state for shell section pages, framed as a small terminal window: a hairline
 * "title bar" + a faux `tulipfarm <section> --list` command resolving to `0 results`. Depth comes
 * from the border + card surface (no shadow). Body content is mocked in V1 (UI-V1-003). The public
 * API (section/title/hint/children) is unchanged so section routes need no edits.
 */
export function EmptyState({
  section,
  title,
  hint,
  children,
}: {
  section: string;
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <section className="mx-auto flex h-full max-w-xl flex-col justify-center px-6 py-16">
      <div className="rounded-sm border border-border bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium uppercase tracking-[0.2em]">
            <span className="text-primary">[</span>
            {section}
            <span className="text-primary">]</span>
          </span>
          <span aria-hidden className="ml-auto opacity-60">
            tulipfarm
          </span>
        </div>
        <div className="flex flex-col gap-4 px-4 py-6 text-sm">
          <div className="flex flex-col gap-1 text-muted-foreground">
            <p>
              <span aria-hidden className="text-primary">
                ${" "}
              </span>
              tulipfarm {section} --list
            </p>
            <p className="opacity-70">0 results</p>
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground">{title}</h1>
            <p className="mt-1 text-muted-foreground">{hint}</p>
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}
