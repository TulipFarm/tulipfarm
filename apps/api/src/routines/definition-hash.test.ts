import { describe, expect, it } from "vitest";
import { definitionHash } from "./definition-hash";

describe("definitionHash", () => {
  it("ignores object key insertion order recursively", () => {
    const first = {
      id: "ordered",
      metadata: { labels: { team: "ops", priority: 1 }, enabled: true },
      states: [{ name: "Done", type: "inject", data: { b: 2, a: 1 }, end: true }],
    };
    const reordered = {
      states: [{ end: true, data: { a: 1, b: 2 }, type: "inject", name: "Done" }],
      metadata: { enabled: true, labels: { priority: 1, team: "ops" } },
      id: "ordered",
    };

    expect(definitionHash(first)).toBe(definitionHash(reordered));
    expect(definitionHash(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves semantic array order", () => {
    const first = {
      id: "ordered",
      states: [
        { name: "First", type: "inject", data: {}, transition: "Second" },
        { name: "Second", type: "inject", data: {}, end: true },
      ],
    };
    const reversed = { ...first, states: [...first.states].reverse() };

    expect(definitionHash(first)).not.toBe(definitionHash(reversed));
  });
});
