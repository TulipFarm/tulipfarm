import { Outlet, useLocation } from "@remix-run/react";
import { sectionForPath } from "~/lib/nav";
import { cn } from "~/lib/utils";

/**
 * The shell shared by Settings and the business cluster.
 *
 * It renders the section's description and nothing else above the outlet. The top bar already
 * names the page and the sidebar already marks it active, so a title here would be the third
 * copy — which is what the old Settings header did.
 *
 * The description belongs to the section's own page, not to whatever is drilled into from it: on
 * a detail page it would describe the list the reader has already left.
 */
export function SectionShell() {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);
  const description = section && pathname === section.to ? section.description : undefined;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className={cn("w-full px-6 py-8 md:px-8", !section?.wide && "max-w-3xl")}>
        {description ? (
          <p className="mb-6 max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
        <Outlet />
      </div>
    </div>
  );
}
