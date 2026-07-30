import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectReleaseCommits,
  generateReleaseFiles,
  getReleaseSection,
  resolvePreviousSource,
  sourceShaTagMessage,
} from "./release-changelog";

const repositories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeRootFiles(cwd: string, version: string): void {
  writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "tulipfarm-release-test",
        version,
        repository: {
          type: "git",
          url: "https://github.com/TulipFarm/tulipfarm.git",
        },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(path.join(cwd, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(path.join(cwd, "changes.txt"), "initial\n");
}

function createRepository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "tulipfarm-release-test-"));
  repositories.push(cwd);
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Release Test");
  git(cwd, "config", "user.email", "release-test@example.com");
  writeRootFiles(cwd, "1.0.0");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "chore: initialize release fixture");
  git(cwd, "tag", "--annotate", "v1.0.0", "--message", "Release v1.0.0");
  return cwd;
}

function commitChange(cwd: string, subject: string): string {
  const changesPath = path.join(cwd, "changes.txt");
  const current = readFileSync(changesPath, "utf8");
  writeFileSync(changesPath, `${current}${subject}\n`);
  git(cwd, "add", "changes.txt");
  git(cwd, "commit", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("release changelog generation", () => {
  it("includes every allowed Conventional Commit type", async () => {
    const cwd = createRepository();
    const changes = [
      ["feat(core): add a capability", "Features"],
      ["fix(api): repair a regression", "Bug Fixes"],
      ["perf(worker): reduce dispatch latency", "Performance Improvements"],
      ["revert(core): restore the previous behavior", "Reverts"],
      ["docs: document the release flow", "Documentation"],
      ["refactor(storage): simplify the repository", "Code Refactoring"],
      ["test(api): cover the failure path", "Tests"],
      ["build: update the container build", "Build System"],
      ["ci: enforce release verification", "Continuous Integration"],
      ["style(web): normalize spacing", "Styles"],
      ["chore: maintain dependencies", "Maintenance"],
    ] as const;

    for (const [subject] of changes) {
      commitChange(cwd, subject);
    }

    const generated = await generateReleaseFiles("1.1.0", cwd);

    for (const [subject, heading] of changes) {
      expect(generated.section).toContain(`### ${heading}`);
      expect(generated.section).toContain(subject.split(": ").at(-1));
    }
    expect(generated.previousTag).toBe("v1.0.0");
    expect(JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"))).toMatchObject({
      version: "1.1.0",
    });
    expect(getReleaseSection(readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8"), "1.1.0")).toBe(
      generated.section
    );
  });

  it("rejects commits that would otherwise disappear silently", async () => {
    const cwd = createRepository();
    commitChange(cwd, "unknown: omit me");

    await expect(generateReleaseFiles("1.0.1", cwd)).rejects.toThrow(
      "is not an allowed Conventional Commit"
    );
  });

  it("rejects an empty release section", () => {
    expect(() =>
      getReleaseSection(
        [
          "# Changelog",
          "",
          "## [1.0.1](https://example.com/compare/v1.0.0...v1.0.1) (2026-07-30)",
          "",
          "## [1.0.0] (2026-07-29)",
        ].join("\n"),
        "1.0.1"
      )
    ).toThrow("contains no changelog entries");
  });

  it("uses the tagged source boundary so later main commits move to the next release", async () => {
    const cwd = createRepository();
    commitChange(cwd, "feat(core): include the frozen feature");
    const frozenSource = git(cwd, "rev-parse", "HEAD");

    git(cwd, "switch", "-c", "release/v1.1.0");
    const firstRelease = await generateReleaseFiles("1.1.0", cwd);
    git(cwd, "add", "package.json", "CHANGELOG.md");
    git(cwd, "commit", "-m", "chore(release): v1.1.0");
    git(
      cwd,
      "tag",
      "--annotate",
      "v1.1.0",
      "--message",
      sourceShaTagMessage("v1.1.0", frozenSource)
    );

    git(cwd, "switch", "main");
    commitChange(cwd, "fix(ci): land after release preparation");
    git(cwd, "checkout", "release/v1.1.0", "--", "package.json", "CHANGELOG.md");
    git(cwd, "add", "package.json", "CHANGELOG.md");
    git(cwd, "commit", "-m", "chore(release): v1.1.0 (#123)");
    commitChange(cwd, "docs: explain the next release");

    expect(firstRelease.section).toContain("include the frozen feature");
    expect(firstRelease.section).not.toContain("land after release preparation");
    expect(resolvePreviousSource("v1.1.0", cwd)).toBe(frozenSource);
    expect(collectReleaseCommits(frozenSource, cwd).map(({ subject }) => subject)).toEqual([
      "docs: explain the next release",
      "fix(ci): land after release preparation",
    ]);

    const secondRelease = await generateReleaseFiles("1.2.0", cwd);
    expect(secondRelease.section).toContain("land after release preparation");
    expect(secondRelease.section).toContain("explain the next release");
    expect(secondRelease.section).not.toContain("include the frozen feature");
    expect(secondRelease.section).not.toContain("**release:**");
  }, 15_000);
});
