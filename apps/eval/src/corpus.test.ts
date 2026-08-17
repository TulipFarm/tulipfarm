import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import { CorpusError, corpusHash, loadCorpus } from "./corpus.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function corpusDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-corpus-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const valid = (id: string): EvalCase => ({
  id,
  tier: "l2",
  agent: "triage",
  context: { memory: [], governancePages: [] },
  input: [{ role: "user", content: "hello" }],
  expect: [{ kind: "loop_status", status: "completed" }],
});

describe("corpusHash", () => {
  it("is stable across key order and whitespace", () => {
    const a = corpusHash([valid("one")]);
    const reordered = { ...valid("one") };
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as EvalCase;
    expect(corpusHash([shuffled])).toBe(a);
  });

  it("changes when a Case changes semantically", () => {
    const a = corpusHash([valid("one")]);
    const changed: EvalCase = {
      ...valid("one"),
      expect: [{ kind: "loop_status", status: "failed" }],
    };
    expect(corpusHash([changed])).not.toBe(a);
  });

  it("changes when a Case is added", () => {
    expect(corpusHash([valid("one"), valid("two")])).not.toBe(corpusHash([valid("one")]));
  });

  it("does not change when Cases are listed in a different order", () => {
    expect(corpusHash([valid("two"), valid("one")])).toBe(corpusHash([valid("one"), valid("two")]));
  });
});

describe("loadCorpus", () => {
  it("loads every Case file and sorts them by id", async () => {
    const dir = corpusDir({ "b.json": valid("beta"), "a.json": valid("alpha") });
    const corpus = await loadCorpus(dir);
    expect(corpus.cases.map((c) => c.id)).toEqual(["alpha", "beta"]);
    expect(corpus.hash).toHaveLength(64);
  });

  it("ignores files that are not .json", async () => {
    const dir = corpusDir({ "a.json": valid("alpha"), "README.md": "not a case" });
    expect((await loadCorpus(dir)).cases).toHaveLength(1);
  });

  it("names the offending file when JSON is malformed", async () => {
    const dir = corpusDir({ "broken.json": "{ not json" });
    await expect(loadCorpus(dir)).rejects.toThrow(CorpusError);
    await expect(loadCorpus(dir)).rejects.toThrow(/broken\.json/);
  });

  it("rejects a Case missing a required field, naming the field", async () => {
    const { agent: _agent, ...noAgent } = valid("alpha");
    const dir = corpusDir({ "a.json": noAgent });
    await expect(loadCorpus(dir)).rejects.toThrow(/agent/);
  });

  it("rejects a duplicate Case id, because a Scorecard keys on it", async () => {
    const dir = corpusDir({ "a.json": valid("same"), "b.json": valid("same") });
    await expect(loadCorpus(dir)).rejects.toThrow(/same/);
  });

  it("rejects an unknown assertion kind rather than silently passing it", async () => {
    const bad = { ...valid("alpha"), expect: [{ kind: "definitely_not_real" }] };
    const dir = corpusDir({ "a.json": bad });
    await expect(loadCorpus(dir)).rejects.toThrow(/definitely_not_real/);
  });

  it("rejects a tier it cannot run", async () => {
    const dir = corpusDir({ "a.json": { ...valid("alpha"), tier: "l3" } });
    await expect(loadCorpus(dir)).rejects.toThrow(/l3/);
  });

  it("fails loudly on an empty directory rather than reporting a vacuous pass", async () => {
    const dir = corpusDir({});
    await expect(loadCorpus(dir)).rejects.toThrow(/no Eval Cases/);
  });

  it("rejects a Case that asserts nothing, because it would always pass", async () => {
    const dir = corpusDir({ "a.json": { ...valid("alpha"), expect: [] } });
    await expect(loadCorpus(dir)).rejects.toThrow(/asserts nothing/);
  });

  it("rejects an assertion missing the field its kind needs", async () => {
    const cases: Record<string, unknown>[] = [
      { kind: "output_matches" },
      { kind: "prompt_contains" },
      { kind: "tool_argument_equals", name: "t", path: "a" },
      { kind: "output_field_equals", value: 1 },
      { kind: "tool_call_count" },
      { kind: "tool_call_order", names: [] },
    ];
    for (const assertion of cases) {
      const dir = corpusDir({ "a.json": { ...valid("alpha"), expect: [assertion] } });
      await expect(loadCorpus(dir)).rejects.toThrow(new RegExp(String(assertion.kind)));
    }
  });

  it("accepts an equality assertion whose expected value is null, false or zero", async () => {
    const dir = corpusDir({
      "a.json": {
        ...valid("alpha"),
        expect: [
          { kind: "output_field_equals", path: "a", value: null },
          { kind: "output_field_equals", path: "b", value: false },
          { kind: "tool_call_count", count: 0 },
        ],
      },
    });
    await expect(loadCorpus(dir)).resolves.toBeDefined();
  });
});
