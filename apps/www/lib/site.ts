import { DOCS_URL, SITE_URL } from "@tulipfarm/constants/site";

export { DOCS_URL, SITE_URL };
export const GITHUB_URL = "https://github.com/TulipFarm/tulipfarm";
export const siteName = "TulipFarm";
export const siteHeadline = "Your business. Built in chat.";
export const siteDescription =
  "Build your business operations through chat, then let agents run the work. Self-hosted, with your infrastructure and model providers.";

export function docsUrl(path = "/docs"): string {
  return new URL(path, DOCS_URL).href;
}
