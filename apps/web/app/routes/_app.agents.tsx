import type { MetaFunction } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";

export const meta: MetaFunction = () => [{ title: "Agents · tulipfarm" }];

export default function AgentsPage() {
  return (
    <EmptyState
      section="agents"
      title="Agents"
      hint="No agents registered. Agents load from your soul repo at startup."
    />
  );
}
