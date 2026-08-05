import { describe, expect, it } from "vitest";
import { coerceDataset, DatasetError } from "./dataset";

describe("coerceDataset", () => {
  it("parses a well-formed dataset", () => {
    const dataset = coerceDataset(
      {
        suite: "quality",
        suiteVersion: "1",
        cases: [
          {
            caseId: "c1",
            version: "1",
            severity: "advisory",
            input: { prompt: "hi" },
            expected: ["a"],
            tags: ["quality"],
            runs: 5,
          },
        ],
      },
      "quality"
    );
    expect(dataset.suite).toBe("quality");
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]).toMatchObject({ caseId: "c1", severity: "advisory", runs: 5 });
  });

  it("defaults severity to blocking", () => {
    const dataset = coerceDataset(
      { suite: "s", suiteVersion: "1", cases: [{ caseId: "c", version: "1", input: {} }] },
      "s"
    );
    expect(dataset.cases[0].severity).toBe("blocking");
  });

  it("throws on missing required fields", () => {
    expect(() => coerceDataset({ suiteVersion: "1", cases: [] }, "s")).toThrow(DatasetError);
    expect(() =>
      coerceDataset({ suite: "s", suiteVersion: "1", cases: [{ version: "1", input: {} }] }, "s")
    ).toThrow(DatasetError);
  });
});
