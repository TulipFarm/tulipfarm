import { beforeEach, describe, expect, it } from "vitest";
import { brandIcon, clearBrandIconCache } from "./brand-icon";

beforeEach(() => {
  clearBrandIconCache();
});

describe("brandIcon", () => {
  it("resolves a known brand to its path data and its own colour", async () => {
    const icon = await brandIcon("github");
    // Every Simple Icons mark is a 24x24 path starting with a moveto.
    expect(icon?.path.startsWith("M")).toBe(true);
    // The brand's hex verbatim, with no leading `#` and no legibility adjustment — GitHub's
    // near-black only needs lightening on a dark canvas, which this module cannot see.
    expect(icon?.hex).toBe("181717");
  });

  it("resolves a colour for a brand whose slug differs from its title", async () => {
    // "Google Docs" is filed under `googledocs`; deriving the key any other way misses the hex
    // and would ship a mark with no colour.
    expect((await brandIcon("googledocs"))?.hex).toBe("4285F4");
  });

  it("returns null for a brand the icon set does not carry", async () => {
    // Slack asked to be removed from Simple Icons, so the integration on every operator's screen
    // today has no mark. A miss has to be an ordinary answer, not a thrown error, or the catalog
    // page fails to render over a missing logo.
    expect(await brandIcon("slack")).toBeNull();
  });

  it("returns null when no icon is declared", async () => {
    expect(await brandIcon(undefined)).toBeNull();
    expect(await brandIcon("")).toBeNull();
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
      expect(await brandIcon(slug)).toBeNull();
    }
  });

  it("reads a slug it has already resolved from cache", async () => {
    const first = await brandIcon("github");
    expect(await brandIcon("github")).toBe(first);
  });
});
