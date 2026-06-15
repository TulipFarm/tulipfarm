import type { ReactNode } from "react";

/*
 * Shared empty state for shell section pages: a quiet section eyebrow on a hairline-bordered card,
 * then the title + hint that communicate emptiness, plus an optional action slot. Depth comes from
 * the border + card surface (no shadow). The public API (section/title/hint/children) is unchanged
 * so section routes need no edits.
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
        <p className="border-b border-border px-4 py-2 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {section}
        </p>
        <div className="flex flex-col gap-4 px-4 py-6 text-sm">
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
