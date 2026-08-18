import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { imageSize } from "./dimensions";

async function encoded(
  width: number,
  height: number,
  mime: "image/png" | "image/jpeg" | "image/gif"
): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0x336699ff });
  return new Uint8Array(await image.getBuffer(mime));
}

describe("imageSize", () => {
  it("reads a PNG's dimensions from its IHDR chunk", async () => {
    expect(imageSize(await encoded(640, 480, "image/png"), "image/png")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads a JPEG's dimensions by walking to its frame header", async () => {
    expect(imageSize(await encoded(321, 123, "image/jpeg"), "image/jpeg")).toEqual({
      width: 321,
      height: 123,
    });
  });

  it("reads a GIF's dimensions from its logical screen descriptor", async () => {
    expect(imageSize(await encoded(200, 100, "image/gif"), "image/gif")).toEqual({
      width: 200,
      height: 100,
    });
  });

  it("does not confuse width with height, which a square fixture would hide", async () => {
    const size = imageSize(await encoded(800, 200, "image/png"), "image/png");

    expect(size?.width).toBe(800);
    expect(size?.height).toBe(200);
  });

  it("reads a lossy WebP, whose size sits behind the VP8 sync code", () => {
    // A minimal RIFF/VP8 header: the sync code and the two 14-bit dimension fields are the only
    // parts a size read touches, so the compressed payload can be omitted.
    const bytes = new Uint8Array(30);
    bytes.set([...Buffer.from("RIFF")], 0);
    bytes.set([...Buffer.from("WEBP")], 8);
    bytes.set([...Buffer.from("VP8 ")], 12);
    bytes.set([0x9d, 0x01, 0x2a], 23);
    bytes[26] = 0x90;
    bytes[27] = 0x01; // 400
    bytes[28] = 0x2c;
    bytes[29] = 0x01; // 300

    expect(imageSize(bytes, "image/webp")).toEqual({ width: 400, height: 300 });
  });

  it("reads an extended WebP, whose canvas size is two 24-bit fields", () => {
    const bytes = new Uint8Array(32);
    bytes.set([...Buffer.from("RIFF")], 0);
    bytes.set([...Buffer.from("WEBP")], 8);
    bytes.set([...Buffer.from("VP8X")], 12);
    bytes.set([0x0f, 0x00, 0x00], 24); // 15 → 16
    bytes.set([0x07, 0x00, 0x00], 27); // 7 → 8

    expect(imageSize(bytes, "image/webp")).toEqual({ width: 16, height: 8 });
  });

  it("answers null for a type it cannot read rather than guessing a size", () => {
    expect(imageSize(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf")).toBeNull();
  });

  it("answers null for truncated bytes rather than reading past the end as zero", async () => {
    const truncated = (await encoded(100, 100, "image/png")).subarray(0, 16);

    expect(imageSize(truncated, "image/png")).toBeNull();
  });

  it("answers null for a JPEG whose marker chain ends before any frame header", () => {
    // SOI then EOI: a well-formed marker chain that never declares a frame.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0]);

    expect(imageSize(bytes, "image/jpeg")).toBeNull();
  });

  it("terminates on a JPEG carrying a zero-length segment instead of looping", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00], 0);

    expect(imageSize(bytes, "image/jpeg")).toBeNull();
  });
});
