import { describe, expect, it } from "vitest";
import { brandInk } from "./brand";

/** The lightness out of an `oklch(L C H)` string. */
function lightness(css: string): number {
  const match = /^oklch\(([\d.]+) /.exec(css);
  if (!match) throw new Error(`not an oklch() colour: ${css}`);
  return Number(match[1]);
}

/** The hue out of an `oklch(L C H)` string. */
function hue(css: string): number {
  const match = /^oklch\([\d.]+ [\d.]+ ([\d.]+)\)$/.exec(css);
  if (!match) throw new Error(`not an oklch() colour: ${css}`);
  return Number(match[1]);
}

describe("brandInk", () => {
  it("lifts a near-black brand off the dark canvas", () => {
    // GitHub's own `#181717` sits at OKLCH lightness 0.21, which is barely above the 0.17 canvas.
    // Rendered as given it reads as a missing icon rather than as a logo.
    const ink = brandInk("181717");
    expect(lightness(ink?.dark ?? "")).toBeGreaterThanOrEqual(0.72);
  });

  it("leaves a dark brand alone on the light canvas", () => {
    // The correction is per-canvas, not global. Dark ink on white was already right, and
    // "adjusting" it anyway would drift every brand away from itself for no legibility gain.
    expect(brandInk("181717")?.light).toBe("oklch(0.206 0.0016 17.3)");
  });

  it("pulls a bright brand down on the light canvas", () => {
    // Telegram's `#26A5E4` is lighter than the ceiling, so it washes out on white.
    expect(lightness(brandInk("26A5E4")?.light ?? "")).toBeLessThanOrEqual(0.62);
  });

  it("holds hue and chroma while moving lightness", () => {
    // The point of correcting in OKLCH rather than mixing toward white: mixing drains chroma and
    // Slack's aubergine arrives as a pale lilac. Only lightness may move.
    const ink = brandInk("4A154B");
    expect(hue(ink?.light ?? "")).toBe(hue(ink?.dark ?? ""));
    expect(ink?.light).toContain(" 0.1083 ");
    expect(ink?.dark).toContain(" 0.1083 ");
  });

  it("keeps a grey brand grey when it lightens it", () => {
    // Pure black carries no hue, and atan2 over rounding noise would invent one — a black mark
    // must not surface as a faintly tinted one.
    expect(brandInk("000000")?.dark).toBe("oklch(0.720 0.0000 0.0)");
  });

  it("accepts a leading hash as well as a bare hex", () => {
    expect(brandInk("#4285F4")).toEqual(brandInk("4285f4"));
  });

  it("refuses anything that is not a six-digit hex", () => {
    // The value crosses the wire from a registry file an operator edits by hand, so a typo has to
    // fall back to the uncoloured treatment rather than emit invalid CSS.
    for (const bad of ["", "fff", "12345g", "4A154B4A", "rebeccapurple"]) {
      expect(brandInk(bad)).toBeNull();
    }
    expect(brandInk(null)).toBeNull();
    expect(brandInk(undefined)).toBeNull();
  });
});
