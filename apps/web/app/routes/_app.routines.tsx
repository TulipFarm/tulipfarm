import type { MetaFunction } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";

export const meta: MetaFunction = () => [{ title: "Routines · tulipfarm" }];

export default function RoutinesPage() {
  return (
    <EmptyState
      section="routines"
      title="Routines"
      hint="No routines yet. Durable automations appear here once defined."
    />
  );
}
