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

  it("rejects an unknown expectation kind rather than silently passing it", async () => {
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

  it("rejects a Case that expects nothing, because it would always pass", async () => {
    const dir = corpusDir({ "a.json": { ...valid("alpha"), expect: [] } });
    await expect(loadCorpus(dir)).rejects.toThrow(/expects nothing/);
  });

  it("rejects an expectation missing the field its kind needs", async () => {
    const cases: Record<string, unknown>[] = [
      { kind: "output_matches" },
      { kind: "prompt_contains" },
      { kind: "tool_argument_equals", name: "t", path: "a" },
      { kind: "output_field_equals", value: 1 },
      { kind: "tool_call_count" },
      { kind: "tool_call_order", names: [] },
    ];
    for (const expectation of cases) {
      const dir = corpusDir({ "a.json": { ...valid("alpha"), expect: [expectation] } });
      await expect(loadCorpus(dir)).rejects.toThrow(new RegExp(String(expectation.kind)));
    }
  });

  it("accepts an equality expectation whose expected value is null, false or zero", async () => {
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

describe("loadCorpus grounding", () => {
  const withExpect = (
    expectations: EvalCase["expect"],
    over: Partial<EvalCase> = {}
  ): EvalCase => ({
    ...valid("c1"),
    expect: [...expectations, { kind: "loop_status", status: "completed" }],
    ...over,
  });

  it("refuses text the model was never given, which it could only produce by guessing", async () => {
    const dir = corpusDir({ "a.json": withExpect([{ kind: "output_contains", text: "9am" }]) });

    await expect(loadCorpus(dir)).rejects.toThrow(/appears nowhere in the Case's context/);
  });

  it("does not let the script ground an expectation", async () => {
    // The exact bug this check exists for. The scripted binding is told to say "9am", so the Case
    // passes for free in CI and only fails against a real model — reading as a regression in the
    // harness rather than as the authoring mistake it is.
    const dir = corpusDir({
      "a.json": withExpect([{ kind: "output_contains", text: "9am" }], {
        script: [{ kind: "text", text: "We open at 9am." }],
      }),
    });

    await expect(loadCorpus(dir)).rejects.toThrow(CorpusError);
  });

  it("accepts text the Context gave the model", async () => {
    const dir = corpusDir({
      "a.json": withExpect([{ kind: "output_contains", text: "9am" }], {
        context: { memory: [{ key: "hours", value: "Opens at 9am." }], governancePages: [] },
      }),
    });

    await expect(loadCorpus(dir)).resolves.toBeDefined();
  });

  it("accepts text a Tool result gave the model", async () => {
    const dir = corpusDir({
      "a.json": withExpect([{ kind: "output_contains", text: "open" }], {
        toolResults: [{ name: "lookup_ticket", output: { status: "open" } }],
      }),
    });

    await expect(loadCorpus(dir)).resolves.toBeDefined();
  });

  it("checks a pattern against what was given, not only a literal", async () => {
    const dir = corpusDir({
      "grounded.json": withExpect([{ kind: "output_matches", pattern: "9\\s*am" }], {
        context: { memory: [{ key: "hours", value: "Opens at 9am." }], governancePages: [] },
      }),
    });
    const bare = corpusDir({
      "bare.json": withExpect([{ kind: "output_matches", pattern: "9\\s*am" }]),
    });

    await expect(loadCorpus(dir)).resolves.toBeDefined();
    await expect(loadCorpus(bare)).rejects.toThrow(CorpusError);
  });

  it("allows a deliberate ungrounded expectation when the author states why", async () => {
    // Refusal wording and output shape are not recalled from the Context. Banning them outright
    // would push authors to weaken real Cases; requiring a reason only bans the silent ones.
    const dir = corpusDir({
      "a.json": withExpect([
        {
          kind: "output_contains",
          text: "cannot",
          ungrounded: "tests refusal wording, not recall",
        },
      ]),
    });

    await expect(loadCorpus(dir)).resolves.toBeDefined();
  });

  it("does not accept a blank reason as a reason", async () => {
    const dir = corpusDir({
      "a.json": withExpect([{ kind: "output_contains", text: "9am", ungrounded: "" }]),
    });

    await expect(loadCorpus(dir)).rejects.toThrow(CorpusError);
  });
});
