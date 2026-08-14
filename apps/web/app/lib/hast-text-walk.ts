export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP_TAGS = new Set(["code", "pre", "a"]);

/** Never rewrite inside code spans, code blocks, or existing links. */
export function walkTextNodes(tree: HastNode, split: (text: string) => HastNode[]): void {
  const walk = (node: HastNode): void => {
    if (!node.children) return;
    if (node.tagName && SKIP_TAGS.has(node.tagName)) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        next.push(...split(child.value));
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  walk(tree);
}
