import { describe, expect, it } from "vitest";
import { isNewerVersion, runningVersion } from "./version";

describe("isNewerVersion", () => {
  it("compares stable semvers numerically", () => {
    expect(isNewerVersion("0.2.1", "0.3.0")).toBe(true);
    expect(isNewerVersion("0.2.1", "0.2.2")).toBe(true);
    expect(isNewerVersion("0.2.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("0.2.1", "0.2.1")).toBe(false);
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(false);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(false);
  });

  it("tolerates a leading v on either side", () => {
    expect(isNewerVersion("v0.2.1", "v0.3.0")).toBe(true);
  });

  it("never reports an update for non-semver versions (dev, latest, prereleases)", () => {
    expect(isNewerVersion("dev", "0.3.0")).toBe(false);
    expect(isNewerVersion("latest", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.2.1", "0.3.0-alpha.1")).toBe(false);
  });
});

describe("runningVersion", () => {
  it("falls back to TULIPFARM_VERSION env, then dev", () => {
    const prev = process.env.TULIPFARM_VERSION;
    process.env.TULIPFARM_VERSION = "9.9.9";
    expect(runningVersion()).toBe("9.9.9");
    delete process.env.TULIPFARM_VERSION;
    expect(runningVersion()).toBe("dev");
    if (prev !== undefined) process.env.TULIPFARM_VERSION = prev;
  });
});
