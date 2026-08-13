import { Navigate } from "@remix-run/react";

/*
 * Merged into Access. Inviting someone, turning their account off and deciding what they can do
 * were three halves of one job spread across two pages, and the same person appeared on both,
 * described two different ways. Kept as a redirect so bookmarks and older links still resolve.
 */
export default function MovedRoute() {
  return <Navigate to="/business/access" replace />;
}
