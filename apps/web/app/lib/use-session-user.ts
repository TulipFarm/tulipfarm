import { useRouteLoaderData } from "@remix-run/react";
import type { SessionUser } from "~/lib/api";

export function useSessionUser(): SessionUser | undefined {
  const data = useRouteLoaderData("routes/_app") as { user?: SessionUser } | undefined;
  return data?.user;
}

export function useIsAdmin(): boolean {
  return useSessionUser()?.role === "admin";
}
