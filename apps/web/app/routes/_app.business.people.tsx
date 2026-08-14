import { Navigate } from "@remix-run/react";

export default function MovedRoute() {
  return <Navigate to="/business/access" replace />;
}
