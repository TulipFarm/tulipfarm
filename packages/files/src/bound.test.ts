import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { boundImage, DEFAULT_MAX_IMAGE_DIMENSION } from "./bound";
import { imageSize } from "./dimensions";

async function png(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0x336699ff });
  return new Uint8Array(await image.getBuffer("image/png"));
}

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
    const outcome = await boundImage(await png(2_000, 400), "image/png");

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toContain("2000×400");
  });

  it("names the limit in the refusal so the person knows what to resize to", async () => {
    const outcome = await boundImage(await png(2_000, 400), "image/png");

    expect(outcome.kind === "refused" && outcome.reason).toContain(
      `${DEFAULT_MAX_IMAGE_DIMENSION}px`
    );
  });

  it("bounds on the longest edge, so a tall thin image is caught as well as a wide one", async () => {
    const outcome = await boundImage(await png(100, 4_000), "image/png");

    expect(outcome.kind).toBe("refused");
  });

  it("downscales to fit when the operator turned it on", async () => {
    const outcome = await boundImage(await png(2_000, 1_000), "image/png", {
      downscaleImages: true,
    });

    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(imageSize(outcome.data, "image/png")).toEqual({
      width: DEFAULT_MAX_IMAGE_DIMENSION,
      height: DEFAULT_MAX_IMAGE_DIMENSION / 2,
    });
  });

  it("reports what it downscaled from, so the edit can be disclosed rather than hidden", async () => {
    const outcome = await boundImage(await png(2_000, 1_000), "image/png", {
      downscaleImages: true,
    });

    expect(outcome.kind === "accepted" && outcome.downscaledFrom).toEqual({
      width: 2_000,
      height: 1_000,
    });
  });

  it("honours a business's own limit over the default", async () => {
    const outcome = await boundImage(await png(800, 600), "image/png", {
      maxImageDimension: 400,
      downscaleImages: true,
    });

    expect(outcome.kind === "accepted" && imageSize(outcome.data, "image/png")).toEqual({
      width: 400,
      height: 300,
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
    // A valid PNG header declaring a huge image, with no pixel data behind it.
    const header = await png(4_000, 4_000);
    const lying = header.subarray(0, 64);

    const outcome = await boundImage(lying, "image/png", { downscaleImages: true });

    expect(outcome.kind).toBe("refused");
  });
});
