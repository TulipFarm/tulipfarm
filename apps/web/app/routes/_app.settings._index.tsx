import { Navigate } from "@remix-run/react";
import { visibleSettingsGroups } from "~/lib/nav";
import { useSessionUser } from "~/lib/use-session-user";

/**
 * The Settings sidebar is the hub. Entering Settings opens the first destination the current
 * account may reach instead of repeating the same navigation as a grid in the workspace.
 */
export default function SettingsIndex() {
  const user = useSessionUser();
  const groups = visibleSettingsGroups({
    isDev: import.meta.env.DEV,
    visiblePaths: user?.navigation?.visiblePaths,
  });

  const first = groups.flatMap((group) => group.items)[0];
  return <Navigate to={first?.to ?? "/"} replace />;
}
