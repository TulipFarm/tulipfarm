import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus.ts";
import { type EvalSoul, loadEvalSoul } from "./eval-soul.ts";

let soul: EvalSoul;

beforeAll(async () => {
  soul = await loadEvalSoul();
});

afterAll(() => soul.dispose());

import { runSweep } from "./runner.ts";
import { scriptedBinding } from "./scripted.ts";

const CORPUS_DIR = path.join(__dirname, "..", "corpus");

/**
 * Guards the shipped Corpus itself, not the framework.
 *
 * Without this, a malformed Case or one whose script no longer drives its Expectations would only
 * surface when a maintainer ran the CLI — which, for a pre-release gate, is far too late.
 */
describe("shipped corpus", () => {
  it("loads, and every Case passes under the scripted binding", async () => {
    const corpus = await loadCorpus(CORPUS_DIR, soul);
    expect(corpus.cases.length).toBeGreaterThan(0);

    const card = await runSweep({ corpus, model: scriptedBinding() });
    const bad = card.trials.filter((t) => !t.passed);
    expect(bad.map((t) => `${t.caseId}: ${t.error ?? JSON.stringify(t.expectations)}`)).toEqual([]);
    expect(card.errored).toBe(0);
    // Each L3 Case drives a real Run against a real git-backed Soul, so the whole sweep outgrew
    // the 5s default as soon as the Corpus did.
  }, 60_000);

  it("has no vacuous Case, because one would pass without checking anything", async () => {
    const corpus = await loadCorpus(CORPUS_DIR, soul);
    expect(corpus.cases.filter((c) => c.expect.length === 0).map((c) => c.id)).toEqual([]);
  });

  it("names each file after the Case it holds, so a Scorecard id locates its source", async () => {
    const corpus = await loadCorpus(CORPUS_DIR, soul);
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(CORPUS_DIR)).filter((n) => n.endsWith(".json")).sort();
    expect(files).toEqual(corpus.cases.map((c) => `${c.id}.json`).sort());
  });
});
