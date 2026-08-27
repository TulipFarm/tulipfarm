import { renderDeploymentSurfaces } from "@tulipfarm/deploy-render";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { Metadata } from "next";
import { baseOptions } from "@/lib/layout.shared";
import { SITE_URL } from "@/lib/shared";
import { collectDeploymentInput } from "../../scripts/generate-deploy-docs";
import { DeployWizard } from "./deploy-wizard";
import { resolveSiteUrl } from "./model";

export const metadata: Metadata = {
  title: "Deploy TulipFarm: guided, verified, self-hosted",
  alternates: { canonical: "/deploy" },
  description:
    "Answer a few questions and walk deterministic, verified steps to a running TulipFarm instance. No secret is ever entered; the page makes no network request after it loads.",
};

// The wizard model is built at export time from the same manifest the docs and /deploy.txt render
// from, so the page ships as static HTML with the whole model inlined. Nothing is fetched at
// runtime — the read below happens once, during `next build`.
export default function DeployPage() {
  const { wizard } = renderDeploymentSurfaces(collectDeploymentInput());
  return (
    <HomeLayout {...baseOptions()}>
      <DeployWizard model={resolveSiteUrl(wizard, SITE_URL)} />
    </HomeLayout>
  );
}
