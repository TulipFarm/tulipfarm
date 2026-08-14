/** Rewrites ```prompt fences to <PromptBlock> before syntax highlighting. */

interface MdastNode {
  type: string;
  lang?: string | null;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

export function remarkPrompt() {
  return (tree: MdastNode) => {
    transform(tree);
  };
}

function transform(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;

  node.children = node.children.map((child) => {
    if (child.type === "code" && child.lang === "prompt") {
      return {
        type: "mdxJsxFlowElement",
        name: "PromptBlock",
        attributes: [{ type: "mdxJsxAttribute", name: "text", value: child.value ?? "" }],
        children: [],
      } as MdastNode;
    }
    transform(child);
    return child;
  });
}
