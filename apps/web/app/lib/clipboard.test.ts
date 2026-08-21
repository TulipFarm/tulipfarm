import { afterEach, describe, expect, it, vi } from "vitest";
import { copyImageBlob, copyText } from "~/lib/clipboard";

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

describe("copyImageBlob", () => {
  it("writes ClipboardItem when API and ClipboardItem are present", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    class MockClipboardItem {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      constructor(public data: any) {}
    }
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    const blob = new Blob(["test"], { type: "image/png" });
    await expect(copyImageBlob(blob)).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0][0]).toBeInstanceOf(MockClipboardItem);
  });

  it("returns false when ClipboardItem is missing or clipboard API is missing", async () => {
    vi.stubGlobal("navigator", {});
    const blob = new Blob(["test"], { type: "image/png" });
    await expect(copyImageBlob(blob)).resolves.toBe(false);
  });

  it("returns false when clipboard write throws", async () => {
    class MockClipboardItem {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      constructor(public data: any) {}
    }
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", {
      clipboard: { write: vi.fn().mockRejectedValue(new Error("Permission denied")) },
    });

    const blob = new Blob(["test"], { type: "image/png" });
    await expect(copyImageBlob(blob)).resolves.toBe(false);
  });
});
