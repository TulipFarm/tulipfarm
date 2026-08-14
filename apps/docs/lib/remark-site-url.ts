/** Replace `{{SITE_URL}}` at mdast time so fenced commands stay real code blocks. */

// Must stay a relative import. fumadocs-mdx bundles source.config.ts with esbuild, which
// inlines relative imports but leaves bare specifiers external; the emitted
// .source/source.config.mjs is then evaluated by plain Node, outside webpack, where a
// workspace specifier fails to resolve. Relative keeps the value inlined.
import { SITE_URL } from "./shared";

const TOKEN = "{{SITE_URL}}";

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

export function remarkSiteUrl() {
  return (tree: MdastNode) => {
    transform(tree);
  };
}

function transform(node: MdastNode): void {
  if (typeof node.value === "string" && node.value.includes(TOKEN)) {
    node.value = node.value.replaceAll(TOKEN, SITE_URL);
  }
  if (typeof node.url === "string" && node.url.includes(TOKEN)) {
    node.url = node.url.replaceAll(TOKEN, SITE_URL);
  }
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) transform(child);
}
