/**
 * The public website. This site is deployed here, and it serves the install assets
 * (`/install.sh`, `/docker-compose.yml`, …) that the installer fetches.
 *
 * The only place the domain is written. `scripts/site-url.test.ts` fails the build if it
 * appears anywhere else in TypeScript or MDX, and holds the shell/PowerShell/Markdown
 * literals — which cannot import it — in sync with this value.
 *
 * Keep this module free of imports: `lib/remark-site-url.ts` pulls it into the bundle
 * that fumadocs-mdx evaluates outside webpack (see `AGENTS.md`).
 */
export const SITE_URL = "https://tulipfarm.site";

export const appName = "tulipfarm docs";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const gitConfig = {
  user: "TulipFarm",
  repo: "tulipfarm",
  branch: "main",
};
