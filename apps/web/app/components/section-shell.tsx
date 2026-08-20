import { Outlet, useLocation } from "@remix-run/react";
import { sectionForPath } from "~/lib/nav";
import { cn } from "~/lib/utils";

/**
 * The description belongs to the section's own page, not to whatever is drilled into from it:
 * on a detail page it would describe the list the reader has already left.
 */
export function SectionShell() {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);
  const ownPage = section !== undefined && pathname === section.to;
  const description = ownPage ? section?.description : undefined;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className={cn("w-full px-6 py-8 md:px-8", !section?.wide && "max-w-3xl")}>
        {/* The top bar owns page identity visually, so this heading is for assistive technology
            only: without it a section page starts at h2 and screen-reader heading navigation has
            no "page starts here". A page drilled into from here names itself. */}
        {ownPage && section ? <h1 className="sr-only">{section.label}</h1> : null}
        {description ? (
          <p className="mb-6 max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
        <Outlet />
      </div>
    </div>
  );
}
