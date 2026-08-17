import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scorecard } from "./runner.ts";

/**
 * Bumped whenever a stored Scorecard's shape changes.
 *
 * A Baseline outlives the code that wrote it — it is committed, and it is read months later. An
 * artifact from a newer schema is refused rather than parsed optimistically, because a field this
 * version does not understand is exactly how a delta becomes confidently wrong.
 */
export const SCHEMA_VERSION = 1;

export interface ScorecardArtifact {
  readonly schemaVersion: number;
  /** The harness commit that produced it. `<sha>-dirty` when the tree had uncommitted changes. */
  readonly harnessVersion: string;
  readonly savedAt: string;
  readonly scorecard: Scorecard;
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

/** A model id safe to use as a filename — no separators, no traversal, no surprises. */
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

export function buildArtifact(scorecard: Scorecard, harnessVersion: string): ScorecardArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    harnessVersion,
    savedAt: new Date().toISOString(),
    scorecard,
  };
}

/**
 * The harness commit, marked `-dirty` when the tree carries uncommitted changes.
 *
 * The mark is the whole point: a Scorecard from a dirty tree cannot be reproduced by anyone else,
 * so it may be archived but never promoted.
 */
export function harnessVersion(cwd: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const sha = git(["rev-parse", "HEAD"]);
    return git(["status", "--porcelain"]) === "" ? sha : `${sha}-dirty`;
  } catch {
    return "unknown";
  }
}

export function isDirty(version: string): boolean {
  return version.endsWith("-dirty") || version === "unknown";
}

export function writeArtifact(path: string, artifact: ScorecardArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function readArtifact(path: string): ScorecardArtifact {
  if (!existsSync(path)) {
    throw new ArtifactError(`no Scorecard at ${path} — promote one with --promote first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ArtifactError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const artifact = parsed as Partial<ScorecardArtifact>;
  if (artifact?.schemaVersion !== SCHEMA_VERSION) {
    throw new ArtifactError(
      `${path} was written by schema ${String(artifact?.schemaVersion)}, and this harness reads schema ${SCHEMA_VERSION}`
    );
  }
  const card = artifact.scorecard as Partial<Scorecard> | undefined;
  // Checked field by field because this file is committed, reviewed and merged by hand. A dropped
  // `trials` array would otherwise only surface as a TypeError deep inside the comparison, naming
  // no file for the reader to go and fix.
  if (
    typeof card?.corpusHash !== "string" ||
    typeof card.modelId !== "string" ||
    !Array.isArray(card.trials) ||
    !["passed", "failed", "errored", "skipped", "corpusCases"].every(
      (k) => typeof (card as Record<string, unknown>)[k] === "number"
    )
  ) {
    throw new ArtifactError(`${path} does not carry a complete Scorecard`);
  }
  return artifact as ScorecardArtifact;
}

/** Where the promoted Baseline for one model lives. One file per model, committed to the repo. */
export function baselinePath(root: string, modelId: string): string {
  if (!SAFE_ID.test(modelId)) {
    throw new ArtifactError(`model id "${modelId}" cannot be used as a Baseline filename`);
  }
  return join(root, "baselines", `${modelId}.json`);
}
