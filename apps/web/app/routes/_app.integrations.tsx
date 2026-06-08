import type { MetaFunction } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

export default function IntegrationsPage() {
  return (
    <EmptyState
      section="integrations"
      title="Integrations"
      hint="No integrations connected. Slack, GitHub, and third-party services connect here."
    />
  );
}
