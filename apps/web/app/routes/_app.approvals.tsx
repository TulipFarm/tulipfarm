import type { MetaFunction } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";

export const meta: MetaFunction = () => [{ title: "Approvals · tulipfarm" }];

export default function ApprovalsPage() {
  return (
    <EmptyState
      section="approvals"
      title="Approvals"
      hint="Pending approvals from routines and agents will list here. Sidebar counts are placeholders in the V1 shell."
    />
  );
}
