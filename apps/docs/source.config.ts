import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkPrompt } from "./lib/remark-prompt";

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
    // Prepend remarkPrompt so ```prompt blocks become <PromptBlock> before the
    // syntax highlighter runs. Keep fumadocs' built-in remark plugins (`v`).
    remarkPlugins: (v) => [remarkPrompt, ...v],
  },
});
