import { describe, expect, it } from "vitest";
import { normalizeFilename } from "./filename";
import { ALLOWED_MEDIA_TYPES, isAllowedMediaType, isInlineRenderable } from "./limits";
import { resolveMediaType, sniffMediaType } from "./sniff";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF89 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function webp(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

function svg(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
}

describe("sniffMediaType", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF89, "image/gif"],
    ["pdf", PDF, "application/pdf"],
    ["webp", webp(), "image/webp"],
  ])("recognises %s from its magic bytes", (_name, bytes, expected) => {
    expect(sniffMediaType(bytes)).toBe(expected);
  });

  it("returns null for bytes matching no signature we accept", () => {
    expect(sniffMediaType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it("does not recognise SVG, because it is text and carries no signature", () => {
    expect(sniffMediaType(svg())).toBeNull();
  });

  it("does not mistake a truncated header for a match", () => {
    expect(sniffMediaType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("resolveMediaType", () => {
  it("ignores the claimed type when the bytes carry a signature", () => {
    expect(resolveMediaType(PNG, "image/jpeg")).toBe("image/png");
  });

  // The whole point of sniffing: an extension or a header cannot promote bytes into a type.
  it("refuses a binary that claims to be text, so a claim cannot launder it", () => {
    expect(resolveMediaType(new Uint8Array([0x00, 0x01, 0x02, 0x03]), "text/plain")).toBeNull();
  });

  it("accepts text on its claim, since plain text has no signature to sniff", () => {
    expect(resolveMediaType(new TextEncoder().encode("hello, world"), "text/plain")).toBe(
      "text/plain"
    );
  });

  it("accepts multi-byte UTF-8 text cut off mid-codepoint by the sniff window", () => {
    const long = new TextEncoder().encode("é".repeat(400));
    expect(resolveMediaType(long, "text/markdown")).toBe("text/markdown");
  });

  // SVG reaches this branch as text, so refusal has to come from the allowlist, not the sniffer.
  it("refuses SVG, which claims an image type it cannot prove", () => {
    expect(resolveMediaType(svg(), "image/svg+xml")).toBeNull();
  });

  it("refuses an unclaimed type even when the bytes are clean text", () => {
    expect(resolveMediaType(new TextEncoder().encode("hello"), "text/html")).toBeNull();
  });
});

describe("the allowlist", () => {
  it("does not admit SVG", () => {
    expect(isAllowedMediaType("image/svg+xml")).toBe(false);
    expect(ALLOWED_MEDIA_TYPES).not.toContain("image/svg+xml");
  });

  it("does not admit HTML", () => {
    expect(isAllowedMediaType("text/html")).toBe(false);
  });

  it("serves only images inline, so nothing else gets a script context on our origin", () => {
    expect(isInlineRenderable("image/png")).toBe(true);
    expect(isInlineRenderable("application/pdf")).toBe(false);
    expect(isInlineRenderable("text/html")).toBe(false);
    expect(isInlineRenderable("image/svg+xml")).toBe(false);
  });
});

describe("normalizeFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32", "system32"],
    ["/absolute/path/report.pdf", "report.pdf"],
    ["....//shot.png", "shot.png"],
  ])("strips traversal from %s", (raw, expected) => {
    expect(normalizeFilename(raw)).toBe(expected);
  });

  it("keeps an ordinary name unchanged", () => {
    expect(normalizeFilename("Screenshot 2026-01-01 at 10.32.png")).toBe(
      "Screenshot 2026-01-01 at 10.32.png"
    );
  });

  it("removes the quotes and control characters that would break a header", () => {
    expect(normalizeFilename('a"b\r\nX-Evil: 1.png')).toBe("abX-Evil: 1.png");
  });

  it("falls back to a usable name when nothing survives", () => {
    expect(normalizeFilename("../")).toBe("file");
    expect(normalizeFilename("")).toBe("file");
  });

  it("bounds the length", () => {
    expect(normalizeFilename("a".repeat(500))).toHaveLength(200);
  });
});
