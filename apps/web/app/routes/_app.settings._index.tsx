import { Navigate } from "@remix-run/react";

// Settings has no pane of its own, so it lands on the first section. Profile rather than the old
// target of Secrets, which every non-admin was sent to and immediately 403'd on.
export default function SettingsIndex() {
  return <Navigate to="/settings/profile" replace />;
}
