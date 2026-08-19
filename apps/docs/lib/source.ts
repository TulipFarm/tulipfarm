import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
});

export function getPageImage(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join("/")}`,
  };
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join("/")}`,
  };
}

/**
 * MDX comments survive `getText("processed")`, so build-time annotations such as `tf-page` and
 * `tf-claim` would otherwise reach every LLM consumer of /llms.mdx and /llms-full.txt.
 */
const MDX_COMMENT = /^[ \t]*\{\/\*[\s\S]*?\*\/\}[ \t]*\r?\n?/gm;

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = (await page.data.getText("processed")).replace(MDX_COMMENT, "");

  return `# ${page.data.title} (${page.url})

${processed}`;
}
