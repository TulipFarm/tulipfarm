/** Resolve public origins at mdast time so fenced commands stay real code blocks. */

// Must stay a relative import. fumadocs-mdx bundles source.config.ts with esbuild, which
// inlines relative imports but leaves bare specifiers external; the emitted
// .source/source.config.mjs is then evaluated by plain Node, outside webpack, where a
// workspace specifier fails to resolve. Relative keeps the value inlined.
import { DOCS_URL, SITE_URL } from "./shared";

function resolveOrigins(value: string): string {
  return value.replaceAll("{{SITE_URL}}", SITE_URL).replaceAll("{{DOCS_URL}}", DOCS_URL);
}

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
  if (typeof node.value === "string") {
    node.value = resolveOrigins(node.value);
  }
  if (typeof node.url === "string") {
    node.url = resolveOrigins(node.url);
  }
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) transform(child);
}
