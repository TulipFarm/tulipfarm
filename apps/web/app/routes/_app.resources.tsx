import type { MetaFunction } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

export default function ResourcesPage() {
  return (
    <EmptyState
      section="resources"
      title="Resources"
      hint="No resource types defined yet. Connect a soul to populate schema-driven CRUD."
    />
  );
}
