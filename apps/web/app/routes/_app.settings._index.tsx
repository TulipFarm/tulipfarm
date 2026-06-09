import { Navigate } from "@remix-run/react";

// /settings has no pane of its own (dark mode lives in the sidebar) — land on the first tab.
export default function SettingsIndex() {
  return <Navigate to="/settings/secrets" replace />;
}
