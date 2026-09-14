/** Relative static leaf keeps this module usable during Fumadocs bundling. */
export { SITE_URL } from "../../../packages/constants/src/site";

export const appName = "tulipfarm docs";
/** Fallback meta description for routes that set none. */
export const siteDescription =
  "Self-host TulipFarm: build your business operations by chatting, and let agents run them.";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const gitConfig = {
  user: "TulipFarm",
  repo: "tulipfarm",
  branch: "main",
};
