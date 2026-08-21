import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueUrl, captureScreenshot, downloadBlob, GITHUB_REPO_URL } from "~/lib/report-bug";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildIssueUrl", () => {
  it("builds default issue URL with bug label and attachment prompt", () => {
    const urlString = buildIssueUrl();
    const url = new URL(urlString);
    expect(url.origin + url.pathname).toBe(`${GITHUB_REPO_URL}/issues/new`);
    expect(url.searchParams.get("labels")).toBe("bug");
    expect(url.searchParams.get("title")).toBeNull();
    expect(url.searchParams.get("body")).toBe(
      "(Attach the screenshot copied to your clipboard or downloaded)"
    );
  });

  it("includes title and user description when provided", () => {
    const urlString = buildIssueUrl({
      title: "Sidebar toggle is broken on mobile",
      description: "Steps to reproduce:\n1. Click menu\n2. Nothing happens",
    });
    const url = new URL(urlString);
    expect(url.searchParams.get("title")).toBe("Sidebar toggle is broken on mobile");
    expect(url.searchParams.get("body")).toBe(
      "Steps to reproduce:\n1. Click menu\n2. Nothing happens\n\n(Attach the screenshot copied to your clipboard or downloaded)"
    );
    expect(url.searchParams.get("labels")).toBe("bug");
  });
});

describe("downloadBlob", () => {
  it("creates an anchor and triggers download", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:test-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "a") {
        el.click = clickSpy;
      }
      return el;
    });

    const blob = new Blob(["image-data"], { type: "image/png" });
    downloadBlob(blob, "custom-screenshot.png");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();
  });
});

describe("captureScreenshot", () => {
  it("returns null when mediaDevices is missing", async () => {
    vi.stubGlobal("navigator", {});
    const result = await captureScreenshot();
    expect(result).toBeNull();
  });

  it("returns null when getDisplayMedia rejects (user cancelled)", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn().mockRejectedValue(new Error("Permission denied / cancelled")),
      },
    });
    const result = await captureScreenshot();
    expect(result).toBeNull();
  });

  it("captures screenshot, stops tracks, and returns blob with dataUrl", async () => {
    const stopTrack = vi.fn();
    const mockTrack = { stop: stopTrack };
    const mockStream = {
      getVideoTracks: vi.fn().mockReturnValue([mockTrack]),
      getTracks: vi.fn().mockReturnValue([mockTrack]),
    };

    const getDisplayMedia = vi.fn().mockResolvedValue(mockStream);
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia },
    });

    // Mock HTMLMediaElement play & video load
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "video") {
        const video = el as HTMLVideoElement;
        Object.defineProperty(video, "videoWidth", { value: 800, configurable: true });
        Object.defineProperty(video, "videoHeight", { value: 600, configurable: true });
        video.play = vi.fn().mockResolvedValue(undefined);
        // Trigger metadata loaded on next tick
        setTimeout(() => {
          if (video.onloadedmetadata) {
            // biome-ignore lint/suspicious/noExplicitAny: event mock
            video.onloadedmetadata({} as any);
          }
        }, 0);
      } else if (tag === "canvas") {
        const canvas = el as HTMLCanvasElement;
        const mockCtx = {
          drawImage: vi.fn(),
        };
        // biome-ignore lint/suspicious/noExplicitAny: mock
        canvas.getContext = vi.fn().mockReturnValue(mockCtx) as any;
        canvas.toDataURL = vi.fn().mockReturnValue("data:image/png;base64,mockpng");
        canvas.toBlob = vi.fn().mockImplementation((cb: (b: Blob | null) => void) => {
          cb(new Blob(["mockblob"], { type: "image/png" }));
        });
      }
      return el;
    });

    const result = await captureScreenshot();
    expect(result).not.toBeNull();
    expect(result?.dataUrl).toBe("data:image/png;base64,mockpng");
    expect(result?.blob).toBeInstanceOf(Blob);
    expect(stopTrack).toHaveBeenCalled();
  });
});
