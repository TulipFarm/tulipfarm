import { describe, expect, it } from "vitest";
import { SURFACE_COMPONENT_TOOLS } from "./tools";

function getTool(name: string) {
  const tool = SURFACE_COMPONENT_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool;
}

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

describe("SURFACE_COMPONENT_TOOLS authorization declarations", () => {
  const createTool = getTool("surface_component_create");
  const updateTool = getTool("surface_component_update");
  const getComponentTool = getTool("surface_component_get");
  const listTool = getTool("surface_component_list");

  it("uses the canonical Soul Surface component target type", () => {
    for (const tool of [createTool, updateTool, getComponentTool]) {
      expect(tool.targetsFor({ slug: "deal-card" }), tool.name).toEqual([
        { type: "soul.surface_component", id: "deal-card" },
      ]);
    }
    expect(listTool.targetsFor({})).toEqual([]);
  });

  it("keeps target derivation total for raw model output", () => {
    const rawInputs: unknown[] = [{}, { unexpected: true }, { slug: 7 }, null, []];
    for (const tool of [createTool, updateTool, getComponentTool]) {
      for (const input of rawInputs) {
        expect(() => tool.targetsFor(input), `${tool.name} target derivation`).not.toThrow();
        expectNoNullishTargetText(tool.targetsFor(input));
      }
    }
  });
});
