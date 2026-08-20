import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { boundImage, DEFAULT_MAX_IMAGE_DIMENSION } from "./bound";
import { imageSize } from "./dimensions";

const rasters = new Map<string, Promise<Uint8Array>>();

/**
 * Real PNG bytes for a size, encoded at most once. Several tests assert different things about the
 * same image, and encoding a raster dominates this file's runtime under the coverage job. Callers
 * only ever read the result, so one buffer can serve them all.
 */
function png(width: number, height: number): Promise<Uint8Array> {
  const key = `${width}x${height}`;
  const cached = rasters.get(key);
  if (cached !== undefined) return cached;
  const encoding = new Jimp({ width, height, color: 0x336699ff })
    .getBuffer("image/png")
    .then((buffer) => new Uint8Array(buffer));
  rasters.set(key, encoding);
  return encoding;
}

/**
 * A 200px ceiling, so a resize test moves thousands of pixels rather than millions. `boundImage`
 * reads the limit from one place and never branches on which limit it got, so an explicit small
 * one exercises exactly the code the default would — at a fraction of the cost. That matters:
 * jimp resizes in pure JS, and under the coverage job on a two-core runner a megapixel resize is
 * slow enough to be reported as a hang. The default itself is asserted separately, once.
 */
const DOWNSCALE_TO = { maxImageDimension: 200, downscaleImages: true } as const;

describe("boundImage", () => {
  it("passes a non-image through untouched, because a resize means nothing for one", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

    await expect(boundImage(pdf, "application/pdf")).resolves.toEqual({
      kind: "accepted",
      data: pdf,
      mediaType: "application/pdf",
    });
  });

  it("accepts an image inside the limit without re-encoding it", async () => {
    const bytes = await png(320, 200);

    const outcome = await boundImage(bytes, "image/png");

    expect(outcome).toMatchObject({ kind: "accepted", data: bytes });
    expect(outcome.kind === "accepted" && outcome.downscaledFrom).toBeUndefined();
  });

  it("refuses an oversized image by default rather than silently editing it", async () => {
    const outcome = await boundImage(await png(1_600, 8), "image/png");

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toContain("1600×8");
  });

  it("names the limit in the refusal so the person knows what to resize to", async () => {
    const outcome = await boundImage(await png(1_600, 8), "image/png");

    expect(outcome.kind === "refused" && outcome.reason).toContain(
      `${DEFAULT_MAX_IMAGE_DIMENSION}px`
    );
  });

  it("bounds on the longest edge, so a tall thin image is caught as well as a wide one", async () => {
    const outcome = await boundImage(await png(8, 1_600), "image/png");

    expect(outcome.kind).toBe("refused");
  });

  it("downscales to fit when the operator turned it on", async () => {
    const outcome = await boundImage(await png(400, 200), "image/png", DOWNSCALE_TO);

    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(imageSize(outcome.data, "image/png")).toEqual({ width: 200, height: 100 });
  });

  it("reports what it downscaled from, so the edit can be disclosed rather than hidden", async () => {
    const outcome = await boundImage(await png(400, 200), "image/png", DOWNSCALE_TO);

    expect(outcome.kind === "accepted" && outcome.downscaledFrom).toEqual({
      width: 400,
      height: 200,
    });
  });

  it("applies the default limit when the operator names none", async () => {
    const outcome = await boundImage(await png(DEFAULT_MAX_IMAGE_DIMENSION + 40, 40), "image/png", {
      downscaleImages: true,
    });

    expect(outcome.kind === "accepted" && imageSize(outcome.data, "image/png")?.width).toBe(
      DEFAULT_MAX_IMAGE_DIMENSION
    );
  });

  it("honours a business's own limit over the default", async () => {
    const outcome = await boundImage(await png(80, 60), "image/png", {
      maxImageDimension: 40,
      downscaleImages: true,
    });

    expect(outcome.kind === "accepted" && imageSize(outcome.data, "image/png")).toEqual({
      width: 40,
      height: 30,
    });
  });

  it("refuses a format jimp cannot re-encode rather than dropping it to another format", async () => {
    const webp = new Uint8Array(30);
    webp.set([...Buffer.from("RIFF")], 0);
    webp.set([...Buffer.from("WEBP")], 8);
    webp.set([...Buffer.from("VP8 ")], 12);
    webp.set([0x9d, 0x01, 0x2a], 23);
    webp[26] = 0x10;
    webp[27] = 0x27; // 10000
    webp[28] = 0x2c;
    webp[29] = 0x01; // 300

    const outcome = await boundImage(webp, "image/webp", { downscaleImages: true });

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toContain("image/webp");
  });

  it("accepts an image whose dimensions cannot be read, which the byte cap still bounds", async () => {
    const truncated = (await png(100, 100)).subarray(0, 16);

    const outcome = await boundImage(truncated, "image/png");

    expect(outcome).toMatchObject({ kind: "accepted", data: truncated });
  });

  it("refuses when the bytes are not the image the header claims", async () => {
    // A valid PNG header declaring an oversized image, with no pixel data behind it. Everything
    // past the IHDR is discarded, so the source is a single band of pixels rather than a square:
    // the refusal comes from bytes that cannot be decoded, not from how many of them there were.
    const header = await png(2_000, 8);
    const lying = header.subarray(0, 64);

    const outcome = await boundImage(lying, "image/png", { downscaleImages: true });

    expect(outcome.kind).toBe("refused");
  });
});
