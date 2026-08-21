import { type MetaFunction, Outlet, useLocation } from "@remix-run/react";
import { sectionForPath } from "~/lib/nav";

export const meta: MetaFunction = () => [{ title: "Access · Business · tulipfarm" }];

// Thin layout for the Access subtree (groups / grants / check). Each child owns its data.
export default function AccessLayout() {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);
  // The section shell names only a section's own page, and these tabs are deeper paths of the same
  // page — so without this the tab routes would start their heading order at h2.
  const tabPage = section !== undefined && pathname !== section.to;

  return (
    <>
      {tabPage && section ? <h1 className="sr-only">{section.label}</h1> : null}
      <Outlet />
    </>
  );
}
