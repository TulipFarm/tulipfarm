import { beforeEach, describe, expect, it } from "vitest";
import { brandIconPath, clearBrandIconCache } from "./brand-icon";

beforeEach(() => {
  clearBrandIconCache();
});

describe("brandIconPath", () => {
  it("resolves a known brand to its path data", async () => {
    const path = await brandIconPath("github");
    expect(path).toBeTruthy();
    // Every Simple Icons mark is a 24x24 path starting with a moveto.
    expect(path?.startsWith("M")).toBe(true);
  });

  it("returns null for a brand the icon set does not carry", async () => {
    // Slack asked to be removed from Simple Icons, so the integration on every operator's screen
    // today has no mark. A miss has to be an ordinary answer, not a thrown error, or the catalog
    // page fails to render over a missing logo.
    expect(await brandIconPath("slack")).toBeNull();
  });

  it("returns null when no icon is declared", async () => {
    expect(await brandIconPath(undefined)).toBeNull();
    expect(await brandIconPath("")).toBeNull();
  });

  it("refuses a slug that is not lowercase alphanumeric", async () => {
    // The slug reaches a file read, so anything that could redirect that read is refused before
    // it gets there rather than sanitized on the way.
    for (const slug of [
      "../../../../etc/passwd",
      "github/../../package",
      "git hub",
      "GitHub",
      "github.svg",
      "a".repeat(33),
    ]) {
      expect(await brandIconPath(slug)).toBeNull();
    }
  });

  it("reads a slug it has already resolved from cache", async () => {
    const first = await brandIconPath("github");
    expect(await brandIconPath("github")).toBe(first);
  });
});
