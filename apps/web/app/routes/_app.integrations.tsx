import type { MetaFunction } from "@remix-run/react";
import { SectionShell } from "~/components/section-shell";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

/**
 * The integration catalog and its detail pages, on the same shell as their Business siblings.
 * Grouped under Operate: connecting a provider changes what the whole workspace can reach, not
 * what one person sees.
 */
export default function IntegrationsLayout() {
  return <SectionShell />;
}
