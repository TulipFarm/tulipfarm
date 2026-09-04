import { Outlet, useLocation } from "@remix-run/react";
import { sectionForPath } from "~/lib/nav";
import { cn } from "~/lib/utils";
import { PAGE_COLUMN, PAGE_SCROLLER, PageShell } from "./page-shell";

/**
 * The frame for a section layout route (`/settings`, `/business`, `/integrations`).
 *
 * On the section's own page it renders `PageShell`, so a section is titled the same way every other
 * page in the app is. On a page drilled into from it the child names itself, and this contributes
 * only the scroller and column — nesting two headers would title the page twice.
 *
 * The description belongs to the section's own page, not to whatever is drilled into from it: on a
 * detail page it would describe the list the reader has already left.
 */
export function SectionShell({ contentClassName }: { contentClassName?: string } = {}) {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);

  if (section && pathname === section.to) {
    return (
      <PageShell
        title={section.label}
        description={section.description}
        contentClassName={contentClassName}
      >
        <Outlet />
      </PageShell>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={PAGE_SCROLLER}>
        <div className={cn(PAGE_COLUMN, contentClassName)}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
