/*
 * Shared hast text-node walker for the rendered-markdown post-processors (`rehypeMentions`,
 * `rehypeCitations`). Both walk the rendered tree, skip code/pre/anchor subtrees, and replace each
 * text node with a per-plugin split of its content — only the split rule differs. This module holds
 * the common tree type + walk so the two plugins stay one implementation.
 */

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Never rewrite inside code spans, code blocks, or existing links.
const SKIP_TAGS = new Set(["code", "pre", "a"]);

/**
 * Walk `tree`, replacing each descendant text node with the nodes `split` returns for its value.
 * Subtrees under code/pre/a are left untouched. Mutates the tree in place.
 */
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
