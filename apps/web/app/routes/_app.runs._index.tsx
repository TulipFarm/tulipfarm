import { Navigate } from "@remix-run/react";

// Runs are part of the one Activity timeline now; /runs/:id remains the inspector for a single
// Run. Kept so existing links and bookmarks resolve instead of 404ing.
export default function MovedRoute() {
  return <Navigate to="/business/activities?source=run" replace />;
}
