/*
 * Rehype plugin that highlights plan mode trigger keywords ('plan', 'planning', '/plan')
 * in user message bubbles with the plan mode theme (text-run-active, bg-run-active/10, border-run-active/30).
 */

import { type HastNode, walkTextNodes } from "~/lib/hast-text-walk";

export const PLAN_KEYWORD_PATTERN = /(?<![\w/])(?:\/plan|plan|planning)(?!\w)/gi;

function splitPlanKeywords(text: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  PLAN_KEYWORD_PATTERN.lastIndex = 0;
  for (let m = PLAN_KEYWORD_PATTERN.exec(text); m !== null; m = PLAN_KEYWORD_PATTERN.exec(text)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "tf-plan-keyword",
          "border",
          "border-run-active/30",
          "bg-run-active/10",
          "text-run-active",
          "rounded-[3px]",
          "px-1",
          "py-0.5",
          "font-medium",
        ],
      },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ type: "text", value: text.slice(last) });
  return out;
}

export function rehypePlanKeywords() {
  return (tree: HastNode): void => {
    walkTextNodes(tree, (text) => splitPlanKeywords(text));
  };
}
