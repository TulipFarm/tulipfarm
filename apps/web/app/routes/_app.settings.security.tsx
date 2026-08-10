import { Navigate } from "@remix-run/react";

// Moved. Kept so existing links and bookmarks resolve instead of 404ing.
export default function MovedRoute() {
  return <Navigate to="/settings/auth" replace />;
}
