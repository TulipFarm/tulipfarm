import { describe, expect, it } from "vitest";
import { formatDispatchError, isReleaseVersion, parseReleaseVersion } from "./request-release";

describe("release request", () => {
  it.each([
    "0.5.0",
    "1.0.0",
    "0.5.0-alpha.0",
    "12.34.56-rc.1",
  ])("accepts a release version: %s", (version) => {
    expect(isReleaseVersion(version)).toBe(true);
    expect(parseReleaseVersion([version])).toBe(version);
  });

  it.each([
    "",
    "v0.5.0",
    "0.5",
    "01.5.0",
    "0.5.0-",
    "0.5.0-01",
    "0.5.0+build.1",
    "minor",
  ])("rejects an invalid or ambiguous version: %s", (version) => {
    expect(isReleaseVersion(version)).toBe(false);
  });

  it("requires exactly one version argument", () => {
    expect(() => parseReleaseVersion([])).toThrow("Usage: pnpm release <version>");
    expect(() => parseReleaseVersion(["0.5.0", "0.6.0"])).toThrow("Usage: pnpm release <version>");
  });

  it("explains when the remote workflow has not been upgraded yet", () => {
    expect(
      formatDispatchError(
        'could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ["version"]',
        1
      )
    ).toContain("Merge the release-automation changes to main");
  });

  it("reports other workflow dispatch failures without guessing", () => {
    expect(formatDispatchError("network error", 1)).toBe(
      "Could not start the release workflow (gh exited with status 1)."
    );
  });
});
