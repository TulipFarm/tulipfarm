import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "~/components/ui/link";
import { useActionSlot, usePublishPageTitle } from "~/lib/page-chrome-context";
import { cn } from "~/lib/utils";

export type Crumb = { label: string; to?: string };

/**
 * The scroll region beneath the bar, and the one workspace every page sits in. Exported so a
 * layout route that renders a child's frame rather than its own still lands on the same gutters —
 * a second inset is how the two-frame problem grows back.
 *
 * `PAGE_SCROLLER` is a flex child, not `h-full`: it must be the only thing that scrolls, with the
 * bar held out of it as a sibling. A parent therefore has to be `flex h-full min-h-0 flex-col`.
 *
 * The workspace is fluid on purpose. Dense lists and canvases need the available room; focused
 * content such as forms and prose caps itself rather than pulling the whole page in around it.
 */
export const PAGE_SCROLLER = "min-h-0 flex-1 overflow-y-auto";
export const PAGE_COLUMN = "flex w-full flex-col gap-5 px-4 py-5 sm:px-6 md:px-8";

/**
 * The fixed chrome bar every page is titled in lives in the app shell, not here — see
 * `AppShell`. It is a sibling of the route outlet so that it survives navigation, and it already
 * carries the page's icon and name. A page contributes its actions to it through
 * `usePageActionSlot`, and contributes nothing else.
 *
 * This constant is the shape that bar and the sidebar's own header share, so the two line up
 * across the seam between them. 40px: enough for a 28px control with 6px of air.
 */
export const PAGE_BAR = "flex h-10 shrink-0 items-center";

/**
 * The frame every page in the app renders into: a fixed bar carrying the breadcrumb, the `h1` and
 * the page's actions, then a scrolling column for the page's own content.
 *
 * There is one of these on purpose. Two frames drift — they disagree on width, on breadcrumb
 * styling, and on whether a page states its own name — and the reader pays for that on every
 * navigation between them.
 *
 * The title is `text-sm`, the same size as the breadcrumb beside it, because at this size the bar
 * is chrome rather than content. A page announces itself by being the thing on screen; restating
 * that in 20px display type is the "competing for attention it has not earned" that the rest of
 * this system is built to avoid.
 *
 * The last crumb is not rendered: `title` is that crumb. Every page therefore has exactly one
 * `h1`, which is what a screen reader's heading list is for — the size it is painted at does not
 * change that, so demoting it visually costs nothing semantically.
 */
export function PageShell({
  crumbs,
  title,
  description,
  meta,
  actions,
  contentClassName,
  children,
}: {
  readonly crumbs?: ReadonlyArray<Crumb>;
  readonly title: string;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly contentClassName?: string;
  readonly children: ReactNode;
}) {
  const trail = (crumbs ?? []).slice(0, -1);
  const actionSlot = useActionSlot();
  usePublishPageTitle(title);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Portalled into the app header when there is one. Rendered in place when there is not,
       * so a page's actions degrade to the top of its own content rather than disappearing —
       * which is what they did when the slot was treated as guaranteed. */}
      {actions && actionSlot ? createPortal(actions, actionSlot) : null}

      <div className={PAGE_SCROLLER}>
        <div className={cn(PAGE_COLUMN, contentClassName)}>
          {/* The bar names the page visibly. This keeps the heading in the accessibility tree,
           * where a screen reader's heading list still needs exactly one per page. */}
          <h1 className="sr-only">{title}</h1>

          {actions && !actionSlot ? (
            <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
          ) : null}

          {trail.length > 0 ? (
            <nav aria-label="Breadcrumb">
              <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                {trail.map((crumb) => (
                  <li key={crumb.label} className="flex items-center gap-1.5">
                    {crumb.to ? (
                      <Link to={crumb.to} className="rounded-sm hover:text-foreground">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span>{crumb.label}</span>
                    )}
                    <span aria-hidden className="text-muted-foreground/50">
                      /
                    </span>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}

          {description || meta ? (
            <div className="flex flex-col gap-1.5">
              {description ? (
                <div className="max-w-prose text-sm text-muted-foreground">{description}</div>
              ) : null}
              {meta ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{meta}</div>
              ) : null}
            </div>
          ) : null}

          {children}
        </div>
      </div>
    </div>
  );
}
