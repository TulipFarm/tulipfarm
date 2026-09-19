/** Relative static leaf keeps this module usable during Fumadocs bundling. */
export { DOCS_URL, SITE_URL } from "../../../packages/constants/src/site";

export const appName = "tulipfarm docs";
/** Fallback meta description for routes that set none. */
export const siteDescription =
  "Learn to use, administer, and self-host TulipFarm, with step-by-step guides and reference documentation.";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const gitConfig = {
  user: "TulipFarm",
  repo: "tulipfarm",
  branch: "main",
};
