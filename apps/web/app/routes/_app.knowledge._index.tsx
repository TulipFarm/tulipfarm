import { Navigate } from "@remix-run/react";

// /knowledge has no pane of its own — land on the documents tab (codebase index-redirect convention).
export default function KnowledgeIndex() {
  return <Navigate to="/knowledge/documents" replace />;
}
