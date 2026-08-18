import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactError,
  baselinePath,
  buildArtifact,
  readArtifact,
  SCHEMA_VERSION,
  scorecardPath,
  writeArtifact,
} from "./artifact.ts";
import type { Scorecard } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";

function card(overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    corpusHash: "abc123",
    modelId: "sonnet",
    modelDated: false,
    startedAt: "2024-01-01T00:00:00.000Z",
    durationMs: 10,
    trials: [],
    passed: 1,
    failed: 0,
    errored: 0,
    unexercised: 0,
    skipped: 0,
    corpusCases: 0,
    spend: NO_SPEND,
    ...overrides,
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "eval-artifact-"));

describe("buildArtifact", () => {
  it("stamps the schema and harness version onto the Scorecard", () => {
    const artifact = buildArtifact(card(), "deadbeef");

    expect(artifact.schemaVersion).toBe(SCHEMA_VERSION);
    expect(artifact.harnessVersion).toBe("deadbeef");
    expect(artifact.scorecard.corpusHash).toBe("abc123");
  });

  it("records when it was saved, so an archived Scorecard can be ordered", () => {
    expect(Date.parse(buildArtifact(card(), "deadbeef").savedAt)).not.toBeNaN();
  });
});

describe("writeArtifact / readArtifact", () => {
  it("round-trips a Scorecard through the filesystem", () => {
    const path = join(dir(), "run.json");
    writeArtifact(path, buildArtifact(card({ passed: 4 }), "deadbeef"));

    expect(readArtifact(path).scorecard.passed).toBe(4);
  });

  it("creates the directory it was given, so a first promotion needs no setup", () => {
    const path = join(dir(), "baselines", "sonnet.json");
    writeArtifact(path, buildArtifact(card(), "deadbeef"));

    expect(readArtifact(path).harnessVersion).toBe("deadbeef");
  });

  it("writes readable JSON, because a Baseline is reviewed in a pull request", () => {
    const path = join(dir(), "run.json");
    writeArtifact(path, buildArtifact(card(), "deadbeef"));

    expect(readFileSync(path, "utf8")).toContain('\n  "harnessVersion"');
  });

  it("refuses an artifact written by a newer schema rather than misreading it", () => {
    const path = join(dir(), "run.json");
    writeFileSync(path, JSON.stringify({ ...buildArtifact(card(), "x"), schemaVersion: 99 }));

    expect(() => readArtifact(path)).toThrow(ArtifactError);
    expect(() => readArtifact(path)).toThrow(/schema 99/);
  });

  it("refuses a Baseline a hand edit left incomplete, naming the file", () => {
    const path = join(dir(), "run.json");
    const artifact = buildArtifact(card(), "x") as unknown as Record<string, unknown>;
    const scorecard = { ...(artifact.scorecard as object) } as Record<string, unknown>;
    scorecard.trials = undefined;
    writeFileSync(path, JSON.stringify({ ...artifact, scorecard }));

    expect(() => readArtifact(path)).toThrow(ArtifactError);
    expect(() => readArtifact(path)).toThrow(/run\.json/);
  });

  it("refuses a file that is not an artifact at all", () => {
    const path = join(dir(), "run.json");
    writeFileSync(path, JSON.stringify({ passed: 3 }));

    expect(() => readArtifact(path)).toThrow(ArtifactError);
  });

  it("names the file when it does not exist, since the usual cause is a first run", () => {
    expect(() => readArtifact(join(dir(), "missing.json"))).toThrow(/missing\.json/);
  });
});

describe("baselinePath", () => {
  it("stores one Baseline per model, because two models are never comparable", () => {
    expect(baselinePath("/root", "sonnet")).toBe("/root/baselines/sonnet.json");
    expect(baselinePath("/root", "luna")).toBe("/root/baselines/luna.json");
  });

  it("refuses a model id that would escape the Baseline directory", () => {
    expect(() => baselinePath("/root", "../../etc/passwd")).toThrow(ArtifactError);
    expect(() => baselinePath("/root", "vendor/model")).toThrow(ArtifactError);
  });
});

describe("scorecardPath", () => {
  it("names a Matrix Scorecard after the model that produced it", () => {
    expect(scorecardPath("/out", "sonnet")).toBe("/out/sonnet.json");
    expect(scorecardPath("/out", "luna")).toBe("/out/luna.json");
  });

  it("refuses a model id that would escape the directory it was given", () => {
    expect(() => scorecardPath("/out", "../../etc/passwd")).toThrow(ArtifactError);
  });
});
