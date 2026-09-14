import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { PLAN_KEYWORD_PATTERN } from "../plan-highlight";

export function createPlanKeywordPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("planKeywordHighlight"),
    props: {
      decorations(state) {
        const { doc } = state;
        const decorations: Decoration[] = [];

        doc.descendants((node, pos) => {
          if (!node.isText || !node.text) return;
          const text = node.text;
          PLAN_KEYWORD_PATTERN.lastIndex = 0;
          for (;;) {
            const match = PLAN_KEYWORD_PATTERN.exec(text);
            if (match === null) break;
            const from = pos + match.index;
            const to = from + match[0].length;
            decorations.push(
              Decoration.inline(from, to, {
                class: "tf-plan-keyword",
              })
            );
          }
        });

        return DecorationSet.create(doc, decorations);
      },
    },
  });
}

export const PlanKeywordHighlight = Extension.create({
  name: "planKeywordHighlight",

  addProseMirrorPlugins() {
    return [createPlanKeywordPlugin()];
  },
});
