import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import { createPlanKeywordPlugin } from "./plan-keyword";

const testSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

type InlineDecorationType = {
  attrs?: { class?: string };
};

function decorationClass(dec: Decoration | undefined): string | undefined {
  return (dec as unknown as { type?: InlineDecorationType })?.type?.attrs?.class;
}

function getDecorations(
  state: EditorState,
  plugin: ReturnType<typeof createPlanKeywordPlugin>
): DecorationSet | undefined {
  const decorationsFn = plugin.props.decorations;
  if (typeof decorationsFn !== "function") return undefined;
  return decorationsFn.call(plugin, state) as DecorationSet | undefined;
}

describe("PlanKeywordHighlight extension", () => {
  it("decorates 'plan' and 'planning' keywords in text", () => {
    const plugin = createPlanKeywordPlugin();
    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [
        testSchema.text("Let's plan the project and start planning now."),
      ]),
    ]);
    const state = EditorState.create({ doc, schema: testSchema, plugins: [plugin] });
    const decorations = getDecorations(state, plugin);

    expect(decorations).toBeDefined();
    const found = decorations?.find();
    expect(found).toHaveLength(2);
    expect(decorationClass(found?.[0])).toBe("tf-plan-keyword");
    expect(decorationClass(found?.[1])).toBe("tf-plan-keyword");
  });

  it("decorates '/plan' keyword", () => {
    const plugin = createPlanKeywordPlugin();
    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("/plan review the deployment")]),
    ]);
    const state = EditorState.create({ doc, schema: testSchema, plugins: [plugin] });
    const decorations = getDecorations(state, plugin);

    const found = decorations?.find();
    expect(found).toHaveLength(1);
    expect(decorationClass(found?.[0])).toBe("tf-plan-keyword");
  });

  it("does not decorate unrelated words containing 'plan'", () => {
    const plugin = createPlanKeywordPlugin();
    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("The airplane was near the plant.")]),
    ]);
    const state = EditorState.create({ doc, schema: testSchema, plugins: [plugin] });
    const decorations = getDecorations(state, plugin);

    const found = decorations?.find();
    expect(found).toHaveLength(0);
  });
});
