import { CROPS, type CropKind, type Planting, plantingSeed } from "~/lib/farm";

/*
 * Where every mark in the field stands. This module holds the character grid and the perspective
 * that places plantings on it; it draws nothing and knows nothing about canvas.
 *
 * Every glyph in a field is set at one size. ASCII reads as ASCII because the character cell is
 * constant, so distance is spent on alpha, stem height and pitch instead of on font size.
 *
 * Position comes from a hash of the planting id, never `Math.random`, so a farm keeps its shape
 * between visits and a new tulip joins the field instead of reshuffling it.
 */

/** Gap between the front row and the bottom edge, so the nearest tulips are not cropped. */
const FRONT_MARGIN = 0.06;
/** Gap between neighbours at scale 1. Spacing scales with the type so leaves never interleave. */
const PITCH_PER_SCALE = 36;
/** How much wider than its natural pitch a row may be spread before it reads as scattered. */
const MAX_PITCH_STRETCH = 1.5;
/** Ground gained per row of depth, in stem rows. Sets how tall the planted band grows. */
const DEPTH_PER_ROW = 2.4;
/** The band never eats the whole frame; a field wants sky above it. */
const MAX_BAND = 0.55;
/** Tallest stem any tulip grows to, in rows. The height fit sizes the type against this. */
const MAX_STEM = 8;
/**
 * How much of the band a row's middle gives up to its edges. Rows bow away from the viewer in the
 * centre, so a bed reads as a sweeping arc rather than as a ruled line, the way a real field does.
 */
const ROW_ARC = 0.17;
export const SPROUT_MS = 900;
export const SPROUT_STAGGER_MS = 34;
const MAX_ROWS = 8;

/*
 * The tulip is type, not vector art. This is the same field the docs home page draws: a `(@)` head
 * on a `|` stem with a `/` or `\\` leaf, set in the mono face. Drawn shapes were tried and read as
 * crowns and buckets; the glyph reads as a tulip because it is a mark, not a bad likeness.
 */
export const HEAD_OPEN = "(@)";
/** A closed bud: the artifact exists but nothing can start it. */
export const HEAD_BUD = "@";
/**
 * Vertical px per stem row at scale 1, held just under the font size so consecutive `|` glyphs
 * touch. Set them equal and the stem draws as a dashed line, which grows into gaps as the type
 * scales up.
 */
export const ROW_PX = 11;
export const FONT_PX = 13;
export const FONT_STACK =
  '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace';
const GROUND_CHARS = [",", ".", "'", "`"] as const;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export type Stalk = {
  planting: Planting;
  /** Cross-field position in [-0.5, 0.5], before perspective narrows the far rows. */
  u: number;
  /** 0 at the front row, approaching 1 at the horizon. */
  depth: number;
  /** Perspective factor: 1 at the front row, smaller further back. */
  p: number;
  x: number;
  /** Ground point the plant is rooted at. */
  y: number;
  /** Type size, uniform across the field. Held per stalk so drawing never reaches for the field. */
  scale: number;
  /** Stem height in character rows. Far rows are shorter, which is what reads as distance. */
  rows: number;
  /** Which row carries the leaf, and which way it points. */
  leafRow: number;
  leafDir: 1 | -1;
  phase: number;
  speed: number;
  /** Sway reach in CSS px, already scaled. Far rows sway less. */
  amp: number;
  sproutDelay: number;
  /** Eased pointer displacement in CSS px, integrated per frame. */
  push: number;
  /** Eased hover emphasis, so a tulip lifts and settles instead of snapping. */
  focus: number;
  /** Bloom centre in CSS px, written each frame and read by hit testing. NaN until it opens. */
  headX: number;
  headY: number;
  headR: number;
};

/** A contiguous planting of one kind, which is what makes the field read as coloured stripes. */
export type Bed = { kind: CropKind; count: number; from: number; to: number };

export type Field = {
  stalks: Stalk[];
  beds: Bed[];
  /** Top of the planted band. Rows recede toward it; nothing is planted above it. */
  horizonY: number;
  /** Top of the tallest bloom. Scenery stands on this, so nothing distant crosses the crop. */
  skyY: number;
  frontY: number;
  plantedWidth: number;
  centerX: number;
  rows: number;
  /** Type size for the whole field, ground specks included. */
  scale: number;
};

export const EMPTY_FIELD: Field = {
  stalks: [],
  beds: [],
  horizonY: 0,
  skyY: 0,
  frontY: 0,
  plantedWidth: 0,
  centerX: 0,
  rows: 0,
  scale: 1,
};

export type Speck = { x: number; y: number; ch: string; p: number };

export type Palette = {
  stem: string;
  ground: string;
  crops: Record<CropKind, string>;
};

/*
 * `plantingSeed` is FNV-1a, which avalanches poorly across sequential keys: `tree:0`..`tree:19`
 * come out correlated, so a run of them all pass or all fail the same threshold and the treeline
 * and the soil come out in blocks. Anything keyed by a counter mixes the integer instead.
 */
export function indexSeed(index: number, salt: number): number {
  let hash = Math.imul(index ^ salt, 0x27d4eb2d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 0xffffffff;
}

/** How many rows deep to plant. One row reads as a hedge; a square-ish block reads as a field. */
export function rowCount(total: number): number {
  if (total <= 0) return 0;
  return clamp(Math.ceil(Math.sqrt(total / 1.8)), 1, MAX_ROWS);
}

/** Groups plantings into one bed per kind, in palette order, sized by their real share. */
export function bedsFor(plantings: readonly Planting[]): Bed[] {
  const beds: Bed[] = [];
  let from = -0.5;
  for (const crop of CROPS) {
    const count = plantings.filter((planting) => planting.kind === crop.kind).length;
    if (count === 0) continue;
    const to = from + count / plantings.length;
    beds.push({ kind: crop.kind, count, from, to });
    from = to;
  }
  return beds;
}

/** Perspective factor for a row: everything at this depth is scaled and pulled in by it. */
function depthFactor(depth: number): number {
  return 1 - depth * 0.62;
}

/**
 * How far up the frame a row of the given depth sits, as a fraction of front-to-horizon.
 *
 * The exponent must stay below 1. Above it, equally spaced rows draw *further* apart the deeper
 * they go, and the field reads as stacked bands floating over the ground instead of one plane.
 */
function depthOffset(depth: number): number {
  return depth ** 0.85;
}

/**
 * Ground height at a cross-field position, as a share of the band, on top of the row's own depth.
 *
 * A row is an arc, not a rule: its middle sits further back than its ends. Plants and ground
 * specks run through the same function, so the whole plane bends together instead of the crop
 * floating over a flat floor.
 */
function arcAt(u: number): number {
  return ROW_ARC * (1 - 4 * u * u);
}

/** Ground y for a point at this depth and cross-field position. */
function groundY(field: Field, depth: number, u: number): number {
  const band = field.frontY - field.horizonY;
  return field.frontY - band * clamp(depthOffset(depth) + arcAt(u), 0, 1);
}

/** Projects a cross-field position to a canvas x at the given perspective factor. */
function xAt(field: Field, u: number, p: number): number {
  return field.centerX + u * field.plantedWidth * (0.66 + 0.34 * p);
}

export function layoutField(plantings: readonly Planting[], width: number, height: number): Field {
  if (width <= 0 || height <= 0) return EMPTY_FIELD;

  const frontY = height * (1 - FRONT_MARGIN);
  const centerX = width / 2;

  // A farm with nothing planted still has ground, so bare soil still gets its scatter of specks.
  if (plantings.length === 0) {
    return {
      stalks: [],
      beds: [],
      horizonY: frontY - height * 0.3,
      skyY: frontY - height * 0.3,
      frontY,
      plantedWidth: width * 0.98,
      centerX,
      rows: 0,
      scale: 1,
    };
  }

  const rows = rowCount(plantings.length);
  const beds = bedsFor(plantings);

  /*
   * Each bed spreads its own plantings over every row, so a kind is a stripe running away from the
   * viewer rather than a single band sitting at one depth.
   */
  const slots = new Map<string, { row: number; index: number; of: number }>();
  const perRow = new Array<number>(rows).fill(0);

  for (const bed of beds) {
    const members = plantings.filter((planting) => planting.kind === bed.kind);
    let taken = 0;
    for (let row = 0; row < rows; row++) {
      const share = Math.floor(bed.count / rows) + (row < bed.count % rows ? 1 : 0);
      for (let i = 0; i < share; i++) {
        const member = members[taken + i];
        if (member) slots.set(member.id, { row, index: i, of: share });
      }
      taken += share;
      perRow[row] += share;
    }
  }

  const widest = Math.max(1, ...perRow);
  /*
   * The footprint is the honest bit: the patch takes more of the frame the fuller the farm is, so
   * a new instance shows bare ground around a few plants and a mature one carpets it. Pitch falls
   * out of that footprint, and the type is then sized to the pitch, so a sparse farm gets showcase
   * blooms and a full one a fine carpet without either ever colliding.
   */
  const density = clamp((plantings.length - 1) / 28, 0, 1);
  const footprint = clamp(0.3 + 0.75 * density, 0.3, 0.96);
  const spread = (width * footprint) / widest;
  /*
   * Sized to fit both ways, or a shallow farm draws tulips taller than the frame and a deep one
   * leaves half the canvas empty. `MAX_STEM` rows of plant sit above the deepest row of ground.
   */
  const fitWidth = spread / PITCH_PER_SCALE;
  const fitHeight = (height * 0.72) / ((rows * DEPTH_PER_ROW + MAX_STEM) * ROW_PX);
  const scale = clamp(Math.min(fitWidth, fitHeight), 0.55, 3.4);
  // Past this the row is no longer a row, just plants standing apart, so the patch narrows instead.
  const pitch = Math.min(spread, PITCH_PER_SCALE * scale * MAX_PITCH_STRETCH);
  const plantedWidth = Math.min(width * 0.98, pitch * widest);
  /*
   * The band grows with the number of rows rather than always reaching some fixed horizon, so one
   * row is a hedge along the bottom and eight rows fill the frame. A fixed horizon would strand a
   * shallow field's rows far apart, which is what makes a field read as floating stripes.
   */
  const band = clamp(
    rows * ROW_PX * DEPTH_PER_ROW * scale,
    ((height * MAX_BAND * rows) / MAX_ROWS) * 0.9,
    height * MAX_BAND
  );
  const horizonY = frontY - band;

  const field: Field = {
    stalks: [],
    beds,
    horizonY,
    skyY: horizonY,
    frontY,
    plantedWidth,
    centerX,
    rows,
    scale,
  };

  for (const planting of plantings) {
    const slot = slots.get(planting.id);
    const bed = beds.find((candidate) => candidate.kind === planting.kind);
    if (!slot || !bed) continue;

    const seed = plantingSeed(planting.id);
    const jitter = plantingSeed(`${planting.id}#jitter`);
    const step = (bed.to - bed.from) / slot.of;
    // Alternate rows sit half a step over, the way real planting staggers, so the field reads as
    // rows rather than as a rigid grid seen head-on.
    const bond = slot.row % 2 === 0 ? 0 : step * 0.5;
    const u = clamp(
      bed.from + (slot.index + 0.5) * step + bond + (jitter - 0.5) * step * 0.34,
      bed.from,
      bed.to
    );
    const depth = clamp(slot.row / rows + (seed - 0.5) * (0.55 / rows), 0, 0.96);
    const p = depthFactor(depth);
    // Uneven the way a real bed is, but the depth term always outweighs the jitter, so a far
    // tulip is never taller than a near one.
    const stemRows = 3 + Math.floor(seed * 2) + Math.round(p * 4);

    field.stalks.push({
      planting,
      u,
      depth,
      p,
      x: xAt(field, u, p),
      y: groundY(field, depth, u),
      scale,
      rows: stemRows,
      leafRow: 1 + Math.floor(stemRows * (0.3 + jitter * 0.25)),
      leafDir: seed < 0.5 ? -1 : 1,
      phase: seed * Math.PI * 2,
      speed: 0.0007 + jitter * 0.0006,
      amp: (3 + seed * 4) * scale * (0.55 + 0.45 * p),
      sproutDelay: Math.round(depth * 260 + slot.index * SPROUT_STAGGER_MS),
      push: 0,
      focus: 0,
      headX: Number.NaN,
      headY: Number.NaN,
      headR: Number.NaN,
    });
  }

  for (const stalk of field.stalks) {
    field.skyY = Math.min(field.skyY, stalk.y - stalk.rows * ROW_PX * stalk.scale);
  }

  // Painter's algorithm: the far rows go down first, so near tulips overlap them.
  field.stalks.sort((a, b) => b.depth - a.depth);

  return field;
}

export function makeSoil(field: Field, width: number): Speck[] {
  if (field.plantedWidth <= 0) return [];
  const specks: Speck[] = [];
  const count = Math.round(clamp(width / 2.2, 140, 460));
  for (let i = 0; i < count; i++) {
    const depth = indexSeed(i, 1) * 0.98;
    /*
     * Stratified, not hashed, across the frame. A hash alone leaves visible bald patches and
     * clumps, which read as something meaningful happening in the ground rather than as texture.
     * Clods scatter past the planted patch so the ground reads wider than the crop.
     */
    const u = ((i + indexSeed(i, 2)) / count - 0.5) * 1.02;
    specks.push({
      x: field.centerX + u * width,
      y: groundY(field, depth, u),
      ch: GROUND_CHARS[Math.floor(indexSeed(i, 3) * GROUND_CHARS.length)] ?? ",",
      p: depthFactor(depth),
    });
  }
  return specks;
}
