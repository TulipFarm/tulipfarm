import { renderDeploymentSurfaces } from "@tulipfarm/deploy-render";
import type { Metadata } from "next";
import { DOCS_URL, SITE_URL } from "@/lib/site";
import { collectDeploymentInput } from "../../../../scripts/public-site/deployment-input";
import { DeployWizard } from "./deploy-wizard";
import { resolveSiteUrl } from "./model";
import "./deploy.css";

export const metadata: Metadata = {
  title: "Set up TulipFarm on your infrastructure",
  alternates: { canonical: "/deploy" },
  description:
    "Choose your host and follow its setup guide, or give your AI assistant the installation prompt. Your choices stay in your browser. No secrets are collected.",
  openGraph: {
    title: "Deploy TulipFarm",
    url: `${SITE_URL}/deploy`,
    description:
      "A guided checklist or an installation prompt for your AI assistant. Your host, your instance.",
    images: ["/opengraph-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Deploy TulipFarm",
    description:
      "A guided checklist or an installation prompt for your AI assistant. Your host, your instance.",
    images: ["/opengraph-image.png"],
  },
};

/** The model is built once at export; the browser never fetches deployment configuration. */
export default function DeployPage() {
  const { wizard } = renderDeploymentSurfaces(collectDeploymentInput());
  return <DeployWizard model={resolveSiteUrl(wizard, SITE_URL, DOCS_URL)} />;
}
