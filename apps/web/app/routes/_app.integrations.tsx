import type { MetaFunction } from "@remix-run/react";
import { SectionShell } from "~/components/section-shell";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

export default function IntegrationsLayout() {
  return <SectionShell />;
}
