import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

export function isReleaseVersion(value: string): boolean {
  if (value.includes("+")) return false;

  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? undefined : value.slice(separator + 1);
  const coreIdentifiers = core.split(".");

  if (
    coreIdentifiers.length !== 3 ||
    coreIdentifiers.some(
      (identifier) =>
        !isNumericIdentifier(identifier) || (identifier.length > 1 && identifier.startsWith("0"))
    )
  ) {
    return false;
  }

  if (prerelease === undefined) return true;
  if (prerelease.length === 0) return false;

  return prerelease.split(".").every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    return !isNumericIdentifier(identifier) || identifier === "0" || !identifier.startsWith("0");
  });
}

export function parseReleaseVersion(args: readonly string[]): string {
  if (args.length !== 1 || !isReleaseVersion(args[0] ?? "")) {
    throw new Error(
      "Usage: pnpm release <version> (for example: pnpm release 0.5.0 or pnpm release:canary 0.5.0-beta.0)"
    );
  }

  return args[0] ?? "";
}

export function formatDispatchError(stderr: string, status: number | null): string {
  if (stderr.includes("Unexpected inputs provided") && stderr.includes('"version"')) {
    return [
      "The release workflow on GitHub's main branch does not accept a version input yet.",
      "Merge the release-automation changes to main before running pnpm release.",
    ].join(" ");
  }

  return `Could not start the release workflow (gh exited with status ${status ?? "unknown"}).`;
}

function main(): void {
  const version = parseReleaseVersion(process.argv.slice(2));

  execFileSync("gh", ["auth", "status"], { stdio: "inherit" });
  const dispatch = spawnSync(
    "gh",
    ["workflow", "run", "release.yml", "--ref", "main", "-f", `version=${version}`],
    { encoding: "utf8" }
  );

  if (dispatch.stdout) process.stdout.write(dispatch.stdout);
  if (dispatch.stderr) process.stderr.write(dispatch.stderr);
  if (dispatch.error) throw dispatch.error;
  if (dispatch.status !== 0) {
    throw new Error(formatDispatchError(dispatch.stderr, dispatch.status));
  }

  console.log(`Release v${version} requested.`);
  console.log("The workflow will open a release PR; merging it starts publication automatically.");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
