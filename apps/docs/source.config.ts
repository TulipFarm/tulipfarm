import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkPrompt } from "./lib/remark-prompt";
import { remarkSiteUrl } from "./lib/remark-site-url";

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    // Prepend our plugins so ```prompt blocks become <PromptBlock> and {{SITE_URL}}
    // resolves before the syntax highlighter runs. Keep fumadocs' built-ins (`v`).
    remarkPlugins: (v) => [remarkPrompt, remarkSiteUrl, ...v],
  },
});
