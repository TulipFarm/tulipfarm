import { describe, expect, it, vi } from "vitest";
import { resolveModelSelector } from "./model-selector";

describe("resolveModelSelector", () => {
  it("asks for auto when the request chose nothing", () => {
    // Auto is the default a participant should get: the system picks, the picker is an override.
    expect(resolveModelSelector({})).toBe("auto");
    expect(resolveModelSelector({ model: "" })).toBe("auto");
  });

  it("passes an effort preset straight through", () => {
    expect(resolveModelSelector({ model: "thorough" })).toBe("thorough");
  });

  it("translates a retired tier name and says so once", () => {
    const log = vi.fn();

    expect(resolveModelSelector({ model: "complex" }, log)).toBe("thorough");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("complex");
  });

  it("maps every retired tier name, so no old client silently loses its choice", () => {
    const log = vi.fn();

    expect(resolveModelSelector({ model: "quick" }, log)).toBe("fast");
    expect(resolveModelSelector({ model: "standard" }, log)).toBe("balanced");
    expect(resolveModelSelector({ model: "complex" }, log)).toBe("thorough");
  });

  it("passes a ModelProfile ref through untouched", () => {
    expect(resolveModelSelector({ model: "eu-resident-balanced" })).toBe("eu-resident-balanced");
  });

  it("passes a raw provider model id through, so an old Run still replays", () => {
    // Request Artifacts are immutable; a Run minted before profiles existed must keep resolving.
    expect(resolveModelSelector({ model: "claude-sonnet-4-6" })).toBe("claude-sonnet-4-6");
  });

  it("does not warn for a selector that was never a tier name", () => {
    const log = vi.fn();

    resolveModelSelector({ model: "balanced" }, log);

    expect(log).not.toHaveBeenCalled();
  });
});
