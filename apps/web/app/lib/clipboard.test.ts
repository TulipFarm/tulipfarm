import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "~/lib/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  // A non-secure context (plain http on a LAN IP) does not expose `navigator.clipboard` at all.
  it("falls back to execCommand when the clipboard API is missing", async () => {
    vi.stubGlobal("navigator", {});
    const exec = vi.fn().mockReturnValue(true);
    // biome-ignore lint/suspicious/noExplicitAny: execCommand is deprecated and untyped in lib.dom
    (document as any).execCommand = exec;

    await expect(copyText("hello")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull(); // temp node cleaned up
  });

  it("reports failure when both paths fail", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) },
    });
    // biome-ignore lint/suspicious/noExplicitAny: execCommand is deprecated and untyped in lib.dom
    (document as any).execCommand = vi.fn().mockReturnValue(false);
    await expect(copyText("hello")).resolves.toBe(false);
  });
});
