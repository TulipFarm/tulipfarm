import { type HastNode, walkTextNodes } from "./hast-text-walk";

const WORD_RE = /\S+\s*|\s+/g;

export interface StreamWordCounter {
  /** Visible word count from this render pass; the caller reads it after render to advance `from`. */
  total: number;
}

/**
 * Wraps each word past `from` in a `.tf-word-in` span so newly streamed text blurs into place;
 * words at or before `from` render as plain text since the reader already saw them animate. Hast
 * has no per-word identity across passes to diff against, so `counter.total` carries this pass's
 * count out for the caller to use as next pass's `from`. Runs after every other rehype plugin so
 * link/mention/citation text (already wrapped in `<a>`) stays untouched — `walkTextNodes` skips it.
 */
export function rehypeStreamWords(options: { from: number; counter: StreamWordCounter }) {
  return (tree: HastNode): void => {
    let index = 0;
    walkTextNodes(tree, (text) => {
      const out: HastNode[] = [];
      const chunks = text.match(WORD_RE) ?? [text];
      for (const chunk of chunks) {
        if (chunk.trim() === "") {
          out.push({ type: "text", value: chunk });
          continue;
        }
        const wordIndex = index++;
        if (wordIndex < options.from) {
          out.push({ type: "text", value: chunk });
          continue;
        }
        out.push({
          type: "element",
          tagName: "span",
          properties: {
            className: ["tf-word-in"],
            style: `--word-delay: ${(wordIndex - options.from) * 16}ms`,
          },
          children: [{ type: "text", value: chunk }],
        });
      }
      return out;
    });
    options.counter.total = index;
  };
}
