import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArtifact, readArtifact, writeArtifact } from "./artifact.ts";
import { applyBaseline, guardsCovered, landedEverywhere, unclean, whyUnclean } from "./release.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";

function trial(caseId: string, over: Partial<TrialResult> = {}): TrialResult {
  return {
    caseId,
    trial: 1,
    passed: true,
    expectations: [],
    status: "completed",
    vacuous: false,
    spend: NO_SPEND,
    retries: 0,
    ...over,
  };
}

function card(trials: TrialResult[], over: Partial<Scorecard> = {}): Scorecard {
  return {
    corpusHash: "abc123def456",
    modelId: "sonnet",
    modelDated: false,
    startedAt: "2024-01-01T00:00:00.000Z",
    durationMs: 5,
    trials,
    passed: trials.filter((t) => t.passed && t.error === undefined).length,
    failed: trials.filter((t) => !t.passed && t.error === undefined).length,
    errored: trials.filter((t) => t.error !== undefined).length,
    unexercised: 0,
    skipped: 0,
    corpusCases: new Set(trials.map((t) => t.caseId)).size,
    spend: NO_SPEND,
    ...over,
  };
}

const root = () => mkdtempSync(join(tmpdir(), "eval-release-"));

describe("applyBaseline — saving", () => {
  it("archives the Scorecard where it was told to", () => {
    const dir = root();
    applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "abc1234",
      save: join(dir, "runs", "x.json"),
    });

    expect(readArtifact(join(dir, "runs", "x.json")).scorecard.passed).toBe(1);
  });
});

describe("applyBaseline — promotion", () => {
  it("does nothing unless promotion was asked for, so a run never becomes the reference", () => {
    const dir = root();
    const out = applyBaseline(card([trial("a")]), { root: dir, harnessVersion: "abc1234" });

    expect(out.text).toBe("");
    expect(out.failed).toBe(false);
  });

  it("writes the Baseline for that model when asked", () => {
    const dir = root();
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "abc1234",
      promote: true,
    });

    expect(readArtifact(join(dir, "baselines", "sonnet.json")).harnessVersion).toBe("abc1234");
    expect(out.text).toContain("Promoted");
  });

  it("refuses to promote from an uncommitted tree, which nobody else can reproduce", () => {
    const dir = root();
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "abc1234-dirty",
      promote: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toMatch(/uncommitted/i);
    expect(() => readArtifact(join(dir, "baselines", "sonnet.json"))).toThrow();
  });

  it("refuses to promote a Sweep that did not measure the whole Corpus", () => {
    const dir = root();
    const out = applyBaseline(card([trial("a")], { skipped: 2, abortedReason: "ceiling" }), {
      root: dir,
      harnessVersion: "abc1234",
      promote: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toMatch(/partial/i);
  });

  it("refuses to promote a Sweep that measured only part of the Corpus", () => {
    const dir = root();
    const out = applyBaseline(card([trial("a")], { corpusCases: 4 }), {
      root: dir,
      harnessVersion: "abc1234",
      promote: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toMatch(/measured 1 of 4/);
  });

  it("refuses to promote a Sweep that hit a vendor error", () => {
    const dir = root();
    const out = applyBaseline(card([trial("a", { error: "429" })]), {
      root: dir,
      harnessVersion: "abc1234",
      promote: true,
    });

    expect(out.failed).toBe(true);
  });
});

describe("applyBaseline — promotion after a comparison", () => {
  function withBaseline(dir: string, trials: TrialResult[]) {
    writeArtifact(join(dir, "baselines", "sonnet.json"), buildArtifact(card(trials), "base123"));
    return join(dir, "baselines", "sonnet.json");
  }

  it("will not promote a Sweep that just regressed, which would launder it into the reference", () => {
    const dir = root();
    const path = withBaseline(dir, [trial("a")]);
    const out = applyBaseline(card([trial("a", { passed: false })]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
      promote: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toContain("REGRESSED");
    expect(out.text).not.toContain("Promoted");
    expect(readArtifact(path).harnessVersion).toBe("base123");
  });

  it("will not promote when the comparison itself was refused", () => {
    const dir = root();
    writeArtifact(
      join(dir, "baselines", "sonnet.json"),
      buildArtifact(card([trial("a")], { corpusHash: "OLDHASH" }), "base123")
    );
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
      promote: true,
    });

    expect(out.text).not.toContain("Promoted");
    expect(readArtifact(join(dir, "baselines", "sonnet.json")).harnessVersion).toBe("base123");
  });

  it("promotes into the canonical Baseline, never into a file named with --baseline", () => {
    const dir = root();
    const archive = join(dir, "archive.json");
    writeArtifact(archive, buildArtifact(card([trial("a")]), "base123"));
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
      promote: true,
      baseline: archive,
    });

    expect(out.failed).toBe(false);
    expect(readArtifact(join(dir, "baselines", "sonnet.json")).harnessVersion).toBe("new1234");
    expect(readArtifact(archive).harnessVersion).toBe("base123");
  });
});

describe("applyBaseline — comparison", () => {
  function withBaseline(trials: TrialResult[], version = "base123") {
    const dir = root();
    writeArtifact(join(dir, "baselines", "sonnet.json"), buildArtifact(card(trials), version));
    return dir;
  }

  it("reports the delta against the promoted Baseline", () => {
    const dir = withBaseline([trial("a")]);
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
    });

    expect(out.text).toContain("Delta");
    expect(out.text).toContain("baseline=base123");
    expect(out.failed).toBe(false);
  });

  it("fails the command on a regression, because that is what stops a release", () => {
    const dir = withBaseline([trial("a")]);
    const out = applyBaseline(card([trial("a", { passed: false })]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toContain("REGRESSED");
  });

  it("does not fail the command when a Case was fixed", () => {
    const dir = withBaseline([trial("a", { passed: false })]);
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
    });

    expect(out.failed).toBe(false);
    expect(out.text).toContain("FIXED");
  });

  it("refuses a delta across two Corpora instead of computing a fictitious one", () => {
    const dir = root();
    writeArtifact(
      join(dir, "baselines", "sonnet.json"),
      buildArtifact(card([trial("a")], { corpusHash: "OLDHASH" }), "base123")
    );
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toContain("REFUSED");
    expect(out.text).toContain("OLDHASH");
    expect(out.text).not.toContain("REGRESSED");
  });

  it("fails loudly rather than silently when no Baseline has been promoted yet", () => {
    const out = applyBaseline(card([trial("a")]), {
      root: root(),
      harnessVersion: "new1234",
      compare: true,
    });

    expect(out.failed).toBe(true);
    expect(out.text).toContain("--promote");
  });

  it("compares against an explicitly named file when given one", () => {
    const dir = root();
    const path = join(dir, "elsewhere.json");
    writeArtifact(path, buildArtifact(card([trial("a")]), "base123"));
    const out = applyBaseline(card([trial("a")]), {
      root: dir,
      harnessVersion: "new1234",
      compare: true,
      baseline: path,
    });

    expect(out.text).toContain("baseline=base123");
  });
});

describe("the release gate on a guard the model never exercised", () => {
  const unex = (id: string) => trial(id, { passed: false, unexercised: true });

  it("holds back a single-model Sweep, because the guard is unproven", () => {
    const only = card([unex("refund")], { passed: 0, failed: 0, unexercised: 1 });
    expect(unclean(only, guardsCovered([only]))).toBe(1);
  });

  it("says the guard went unexercised, and never that something leaked", () => {
    const only = card([unex("refund")], { passed: 0, failed: 0, unexercised: 1 });
    const why = whyUnclean(only, guardsCovered([only]));
    expect(why.join(" ")).toContain("no model exercised the guard on refund");
    expect(why.join(" ")).not.toContain("leaked");
  });

  it("clears the leg once another leg of the Matrix exercised the same guard", () => {
    const declined = card([unex("refund")], { passed: 0, failed: 0, unexercised: 1 });
    const attempted = card([trial("refund")], { passed: 1, failed: 0 });
    const covered = guardsCovered([declined, attempted]);
    expect(unclean(declined, covered)).toBe(0);
    expect(whyUnclean(declined, covered)).toEqual([]);
  });

  it("does not let a passing leg excuse a different Case's unexercised guard", () => {
    const declined = card([unex("refund")], { passed: 0, failed: 0, unexercised: 1 });
    const other = card([trial("something-else")], { passed: 1, failed: 0 });
    expect(unclean(declined, guardsCovered([declined, other]))).toBe(1);
  });

  it("still fails a leg that genuinely failed, coverage or not", () => {
    const failing = card([trial("refund", { passed: false })], { passed: 0, failed: 1 });
    const attempted = card([trial("refund")], { passed: 1, failed: 0 });
    expect(unclean(failing, guardsCovered([failing, attempted]))).toBe(1);
  });
});

describe("an attack that landed on every model", () => {
  const landed = (caseId: string) => ({ caseId, resisted: 0, guarded: 0, trials: 1 });
  const held = (caseId: string) => ({ caseId, resisted: 1, guarded: 0, trials: 1 });

  it("names a Case no measured model resisted", () => {
    const a = card([trial("attack")], { modelId: "sonnet", resistance: [landed("attack")] });
    const b = card([trial("attack")], { modelId: "terra", resistance: [landed("attack")] });
    expect(landedEverywhere([a, b])).toEqual(["attack"]);
  });

  it("does not call a mostly-resisting model a landing under --repeat", () => {
    // Reading "any Trial landed" as "the model landed" inverts the gate as Trials multiply: a model
    // that resists four times in five would read as complying, so the repeats a maintainer runs to
    // measure the noise floor would themselves manufacture the consensus this blocks on.
    const mostly = (caseId: string) => ({ caseId, resisted: 4, guarded: 0, trials: 5 });
    const a = card([trial("attack")], { modelId: "sonnet", resistance: [mostly("attack")] });
    const b = card([trial("attack")], { modelId: "terra", resistance: [mostly("attack")] });
    expect(landedEverywhere([a, b])).toEqual([]);
  });

  it("still names a Case no Trial on any model resisted", () => {
    const never = (caseId: string) => ({ caseId, resisted: 0, guarded: 0, trials: 5 });
    const a = card([trial("attack")], { modelId: "sonnet", resistance: [never("attack")] });
    const b = card([trial("attack")], { modelId: "terra", resistance: [never("attack")] });
    expect(landedEverywhere([a, b])).toEqual(["attack"]);
  });

  it("stays quiet when one model resisted, which is model variance", () => {
    const a = card([trial("attack")], { modelId: "sonnet", resistance: [landed("attack")] });
    const b = card([trial("attack")], { modelId: "terra", resistance: [held("attack")] });
    expect(landedEverywhere([a, b])).toEqual([]);
  });

  it("needs more than one model, since one is not evidence of a harness property", () => {
    const a = card([trial("attack")], { modelId: "sonnet", resistance: [landed("attack")] });
    expect(landedEverywhere([a])).toEqual([]);
  });

  it("ignores a model that never measured the Case, so an ERR cannot manufacture agreement", () => {
    const a = card([trial("attack")], { modelId: "sonnet", resistance: [landed("attack")] });
    const b = card([trial("other")], { modelId: "terra", resistance: [held("other")] });
    expect(landedEverywhere([a, b])).toEqual([]);
  });
});
