/**
 * Rewrites ```prompt fenced blocks into a <PromptBlock> component before the
 * code reaches the syntax highlighter. Example prompts are natural language a
 * reader types to the assistant, not code — so they get a distinct treatment
 * (AI icon + gradient underline) instead of Shiki tokens. Running at the remark
 * (mdast) stage means the highlighter never sees the unknown `prompt` language.
 */

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
