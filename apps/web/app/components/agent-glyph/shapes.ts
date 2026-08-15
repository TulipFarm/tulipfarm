import type { GlyphBase } from "./derive";

/* Kept as a documented seam, not dead markup. */

export interface ShapeData {
  paths: string[];
  circles?: { cx: number; cy: number; r: number }[];
}

export const GLYPH_VIEWBOX = "0 0 24 24";

export const SHAPES: Record<GlyphBase, ShapeData> = {
  burst: {
    paths: [
      "M15 12L21 12 M14.1 14.1L18.4 18.4 M12 15L12 21 M9.9 14.1L5.6 18.4 M9 12L3 12 M9.9 9.9L5.6 5.6 M12 9L12 3 M14.1 9.9L18.4 5.6",
    ],
  },
  cross: {
    paths: ["M12 3L12 21 M3 12L21 12", "M12 6L18 12L12 18L6 12Z"],
  },
  poly: {
    paths: [
      "M12 3L19.79 7.5L19.79 16.5L12 21L4.21 16.5L4.21 7.5Z",
      "M12 3L12 21 M19.79 7.5L4.21 16.5 M19.79 16.5L4.21 7.5",
    ],
  },
  vector: {
    paths: ["M4 6L20 6L20 18L4 18Z", "M9 9L13 12L9 15 M13 9L17 12L13 15"],
  },
  graph: {
    paths: ["M7 7L17 7 M7 7L7 17 M17 7L7 17"],
    circles: [
      { cx: 7, cy: 7, r: 1.6 },
      { cx: 17, cy: 7, r: 1.6 },
      { cx: 7, cy: 17, r: 1.6 },
    ],
  },
  radial: {
    paths: ["M12 2L12 5 M22 12L19 12 M12 22L12 19 M2 12L5 12 M9 12L15 12 M12 9L12 15"],
    circles: [
      { cx: 12, cy: 12, r: 9 },
      { cx: 12, cy: 12, r: 5 },
    ],
  },
  lattice: {
    paths: ["M6 6L18 6 M6 12L18 12 M6 18L18 18 M6 6L6 18 M12 6L12 18 M18 6L18 18"],
    circles: [
      { cx: 6, cy: 6, r: 1.2 },
      { cx: 12, cy: 6, r: 1.2 },
      { cx: 18, cy: 6, r: 1.2 },
      { cx: 6, cy: 12, r: 1.2 },
      { cx: 12, cy: 12, r: 1.2 },
      { cx: 18, cy: 12, r: 1.2 },
      { cx: 6, cy: 18, r: 1.2 },
      { cx: 12, cy: 18, r: 1.2 },
      { cx: 18, cy: 18, r: 1.2 },
    ],
  },
};
