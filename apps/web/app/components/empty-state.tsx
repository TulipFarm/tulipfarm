import type { ReactNode } from "react";

/**
 * The body of a page that loaded fine and has nothing in it yet.
 *
 * It is content, not a frame: the page keeps its own breadcrumb, title and column, so having no
 * records does not move the page to a different width than having one. `section` names the page
 * for a screen reader that lands here, since the visible heading is the shell's.
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
    <section
      aria-label={section}
      className="flex flex-col items-start gap-4 rounded-sm border border-dashed border-border px-4 py-10"
    >
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-base text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}
