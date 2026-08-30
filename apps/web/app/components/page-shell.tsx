import { Link } from "@remix-run/react";
import type { ReactNode } from "react";

export type Crumb = { label: string; to?: string };

/**
 * The scroll container and the one content column every page sits in. Exported so a layout route
 * that renders a child's frame rather than its own still lands on the same column — a second set
 * of gutters, or a second max-width, is how the two-frame problem grows back.
 *
 * There is a single width on purpose. Per-page widths meant the title moved horizontally on every
 * navigation (`/agents` 288px, `/agents/:name` 368px, an empty `/routines` 481px), which reads as
 * the page reloading into a different app. Content that needs a narrower measure caps itself —
 * a form, a paragraph — rather than pulling the whole page in around it.
 */
export const PAGE_SCROLLER = "h-full min-h-0 overflow-y-auto";
export const PAGE_COLUMN = "mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 md:px-8";

/**
 * The frame every page in the app renders into: breadcrumb, `h1`, optional meta and actions, then
 * the page's own content.
 *
 * There is one of these on purpose. Two frames drift — they disagree on width, on breadcrumb
 * styling, and on whether a page states its own name — and the reader pays for that on every
 * navigation between them.
 *
 * The last crumb is not rendered: `title` is that crumb, at a size a person can read. Every page
 * therefore has exactly one `h1`, which is what a screen reader's heading list is for.
 */
export function PageShell({
  crumbs,
  title,
  description,
  meta,
  actions,
  children,
}: {
  readonly crumbs?: ReadonlyArray<Crumb>;
  readonly title: string;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const trail = (crumbs ?? []).slice(0, -1);

  return (
    <div className={PAGE_SCROLLER}>
      <div className={PAGE_COLUMN}>
        <header className="flex flex-col gap-3">
          {trail.length > 0 ? (
            <nav aria-label="Breadcrumb">
              <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {trail.map((crumb) => (
                  <li key={crumb.label} className="flex items-center gap-1.5">
                    {crumb.to ? (
                      <Link
                        to={crumb.to}
                        className="rounded-sm transition-colors duration-150 hover:text-foreground"
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span>{crumb.label}</span>
                    )}
                    <span aria-hidden className="opacity-40">
                      /
                    </span>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}

          {/* Wraps rather than truncates: a long title must never push the actions off-screen. */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
              {description ? (
                <div className="max-w-prose text-sm text-muted-foreground">{description}</div>
              ) : null}
              {meta ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{meta}</div>
              ) : null}
            </div>
            {actions ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
