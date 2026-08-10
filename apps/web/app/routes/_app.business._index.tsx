import { Navigate } from "@remix-run/react";

export default function BusinessIndex() {
  return <Navigate to="/business/profile" replace />;
}
