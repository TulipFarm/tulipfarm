import type { MetaFunction } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

export default function KnowledgePage() {
  return (
    <EmptyState
      section="knowledge"
      title="Knowledge"
      hint="No documents indexed yet. Authored docs and synced resources will be searchable here."
    />
  );
}
