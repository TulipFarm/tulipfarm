import { type MetaFunction, useLocation } from "@remix-run/react";
import { SectionShell } from "~/components/section-shell";

export const meta: MetaFunction = () => [{ title: "Business · tulipfarm" }];

/**
 * Workspace configuration, grouped under Operate. Separate from Settings because the audience is
 * different: these pages change what the whole business runs on, not one person's preferences.
 */
export default function BusinessLayout() {
  const { pathname } = useLocation();
  const focused = [
    "/business/profile",
    "/business/models",
    "/business/secrets",
    "/business/guardrails",
    "/business/about",
  ].some((path) => pathname === path || pathname.startsWith(`${path}/`));

  return <SectionShell contentClassName={focused ? "mx-auto max-w-4xl" : undefined} />;
}
