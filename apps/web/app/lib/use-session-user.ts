import { useRouteLoaderData } from "@remix-run/react";
import type { SessionUser } from "~/lib/api";

/**
 * The signed-in user, read from the `_app` route's loader.
 *
 * Every page under the app shell is a descendant of `_app`, which has already loaded the session
 * to decide whether to redirect to `/login`. Reading it back here avoids a second request per
 * page, and gives write-gated pages the `isAdmin` they need to render read-only rather than
 * offering a control the server will refuse.
 */
export function useSessionUser(): SessionUser | undefined {
  const data = useRouteLoaderData("routes/_app") as { user?: SessionUser } | undefined;
  return data?.user;
}

export function useIsAdmin(): boolean {
  return useSessionUser()?.role === "admin";
}
