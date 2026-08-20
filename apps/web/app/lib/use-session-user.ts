import { useRouteLoaderData } from "@remix-run/react";
import type { SessionUser } from "~/lib/api";

export function useSessionUser(): SessionUser | undefined {
  const data = useRouteLoaderData("routes/_app") as { user?: SessionUser } | undefined;
  return data?.user;
}

/**
 * Whether this person may reach the admin surfaces, as the API decided it.
 *
 * Never derive this from `role`: that is the account's own level, and the `Owner` access level —
 * the product's only way to promote a second person — grants authority without rewriting it
 * (#408). An API that says nothing is treated as "not an admin", so a stale client narrows.
 */
export function isBusinessAdmin(user: SessionUser | undefined): boolean {
  return user?.isAdmin === true;
}

export function useIsAdmin(): boolean {
  return isBusinessAdmin(useSessionUser());
}
