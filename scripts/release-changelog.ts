import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isReleaseVersion } from "./request-release.ts";

const REPOSITORY_URL = "https://github.com/TulipFarm/tulipfarm.git";
const SOURCE_SHA_TRAILER = "TulipFarm-Source-SHA";

const CHANGELOG_TYPES = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
  { type: "revert", section: "Reverts" },
  { type: "docs", section: "Documentation" },
  { type: "refactor", section: "Code Refactoring" },
  { type: "test", section: "Tests" },
  { type: "build", section: "Build System" },
  { type: "ci", section: "Continuous Integration" },
  { type: "style", section: "Styles" },
  { type: "chore", section: "Maintenance" },
] as const;

const ALLOWED_COMMIT_TYPES = new Set(CHANGELOG_TYPES.map(({ type }) => type));
const CONVENTIONAL_SUBJECT = /^([a-z]+)(?:\([^)]+\))?!?:\s+\S/;
const RELEASE_SUBJECT = /^chore\(release\): v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?: \(#\d+\))?$/m;

interface RootPackage {
  name?: string;
  repository?: unknown;
  version: string;
  [key: string]: unknown;
}

export interface ReleaseCommit {
  sha: string;
  subject: string;
  type: string;
}

export interface GeneratedRelease {
  previousTag: string;
  sourceSha: string;
  section: string;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function assertCommitExists(sha: string, cwd: string): void {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`Release source boundary is not a commit: ${sha}`);
  }
}

function assertAncestor(ancestor: string, descendant: string, cwd: string): void {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`Release source boundary ${ancestor} is not an ancestor of ${descendant}.`);
  }
}

function parseRootPackage(value: unknown): RootPackage {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("package.json must contain a string version.");
  }
  return value as RootPackage;
}

async function readRootPackage(cwd: string): Promise<RootPackage> {
  const contents = await readFile(path.join(cwd, "package.json"), "utf8");
  return parseRootPackage(JSON.parse(contents) as unknown);
}

export function releaseTag(version: string): string {
  return `v${version}`;
}

export function sourceShaTagMessage(tag: string, sourceSha: string): string {
  return `Release ${tag}\n\n${SOURCE_SHA_TRAILER}: ${sourceSha}`;
}

export function resolvePreviousSource(previousTag: string, cwd = process.cwd()): string {
  const ref = `refs/tags/${previousTag}`;
  const tagExists = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd,
    stdio: "ignore",
  });
  if (tagExists.status !== 0) {
    throw new Error(`Previous release tag does not exist: ${previousTag}`);
  }

  const contents = runGit(["for-each-ref", "--format=%(contents)", ref], cwd);
  const trailerPattern = new RegExp(`^${SOURCE_SHA_TRAILER}: ([0-9a-f]{40,64})$`, "m");
  const sourceSha =
    trailerPattern.exec(contents)?.[1] ?? runGit(["rev-parse", `${ref}^{commit}`], cwd);

  assertCommitExists(sourceSha, cwd);
  assertAncestor(sourceSha, "HEAD", cwd);
  return sourceSha;
}

export function collectReleaseCommits(sourceSha: string, cwd = process.cwd()): ReleaseCommit[] {
  const output = runGit(["log", "--no-merges", "--format=%H%x1f%s%x1e", `${sourceSha}..HEAD`], cwd);
  if (!output) return [];

  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\x1f");
      const sha = separator === -1 ? "" : entry.slice(0, separator);
      const subject = separator === -1 ? entry : entry.slice(separator + 1);

      if (RELEASE_SUBJECT.test(subject)) {
        return undefined;
      }

      const match = CONVENTIONAL_SUBJECT.exec(subject);
      const type = match?.[1];
      if (!sha || !type || !ALLOWED_COMMIT_TYPES.has(type)) {
        throw new Error(
          `Commit ${sha || "(unknown)"} is not an allowed Conventional Commit: ${subject}`
        );
      }

      return { sha, subject, type };
    })
    .filter((commit): commit is ReleaseCommit => commit !== undefined);
}

export function getReleaseSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const headingPrefix = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${version}.`);
  }

  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const end = next === -1 ? lines.length : next;
  const section = lines.slice(start, end).join("\n").trim();
  assertReleaseSectionHasEntries(section, version);
  return `${section}\n`;
}

export function assertReleaseSectionHasEntries(section: string, version: string): void {
  if (!section.startsWith(`## [${version}]`)) {
    throw new Error(`Release section does not start with the ${version} heading.`);
  }
  if (!/^### \S/m.test(section) || !/^\* \S/m.test(section)) {
    throw new Error(`Release section for ${version} contains no changelog entries.`);
  }
}

function prependReleaseSection(changelog: string, section: string): string {
  const header = "# Changelog";
  if (!changelog.startsWith(header)) {
    throw new Error("CHANGELOG.md must start with '# Changelog'.");
  }

  const remainder = changelog.slice(header.length).trimStart();
  return `${header}\n\n${section.trim()}\n\n${remainder}`;
}

async function generateSection(
  version: string,
  previousTag: string,
  sourceSha: string,
  cwd: string,
  packageJson: RootPackage
): Promise<string> {
  const { ConventionalChangelog } = await import("conventional-changelog");
  const context = {
    version,
    previousTag,
    currentTag: releaseTag(version),
    host: "https://github.com",
    owner: "TulipFarm",
    repository: "tulipfarm",
  };
  const generator = new ConventionalChangelog(cwd)
    .loadPreset({
      name: "conventionalcommits",
      types: CHANGELOG_TYPES,
      ignoreCommits: RELEASE_SUBJECT,
    })
    .package({
      ...packageJson,
      version,
    })
    .repository(REPOSITORY_URL)
    .options({ releaseCount: 1 })
    .context(context)
    .commits({ from: sourceSha, to: "HEAD" });

  const chunks: string[] = [];
  for await (const chunk of generator.write()) {
    chunks.push(chunk);
  }

  const section = chunks.join("").trim();
  assertReleaseSectionHasEntries(section, version);
  return section;
}

export async function generateReleaseFiles(
  version: string,
  cwd = process.cwd()
): Promise<GeneratedRelease> {
  const { default: semver } = await import("semver");
  if (!isReleaseVersion(version) || !semver.valid(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }

  const dirty = runGit(["status", "--porcelain"], cwd);
  if (dirty) {
    throw new Error("Release generation requires a clean working tree.");
  }

  const packageJson = await readRootPackage(cwd);
  if (!semver.valid(packageJson.version) || !semver.gt(version, packageJson.version)) {
    throw new Error(
      `Release version ${version} must be greater than package version ${packageJson.version}.`
    );
  }

  const previousTag = releaseTag(packageJson.version);
  const sourceSha = resolvePreviousSource(previousTag, cwd);
  const commits = collectReleaseCommits(sourceSha, cwd);
  if (commits.length === 0) {
    throw new Error(`No releasable commits exist after ${previousTag}.`);
  }

  const section = await generateSection(version, previousTag, sourceSha, cwd, packageJson);
  const changelogPath = path.join(cwd, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");

  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`
  );
  await writeFile(changelogPath, prependReleaseSection(changelog, section));

  return { previousTag, sourceSha, section: `${section}\n` };
}

async function readReleaseSection(version: string, cwd: string): Promise<string> {
  const changelog = await readFile(path.join(cwd, "CHANGELOG.md"), "utf8");
  return getReleaseSection(changelog, version);
}

async function main(): Promise<void> {
  const [command, version, ...rest] = process.argv.slice(2);
  if (!command || !version || rest.length > 0) {
    throw new Error(
      "Usage: node scripts/release-changelog.ts <generate|section|validate> <version>"
    );
  }

  if (command === "generate") {
    const generated = await generateReleaseFiles(version);
    console.log(`Generated ${version} from ${generated.previousTag} at ${generated.sourceSha}.`);
    return;
  }

  if (command === "section") {
    process.stdout.write(await readReleaseSection(version, process.cwd()));
    return;
  }

  if (command === "validate") {
    await readReleaseSection(version, process.cwd());
    return;
  }

  throw new Error(`Unknown release changelog command: ${command}`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
