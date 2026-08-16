import { useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CROPS, type CropKind, type Planting, plantingSeed } from "~/lib/farm";
import { cn } from "~/lib/utils";

/*
 * One artifact, one tulip, typed into a field. The tulip is the mono glyph the docs home page
 * draws — `(@)` on a `|` stem with a `/` leaf — not vector art, so it reads as a mark rather than
 * as a bad likeness of a flower. Everything here reports a fact the caller already knows:
 *
 *   colour    -> crop kind, from the categorical data palette
 *   bed       -> kinds are planted together, so each crop is a stripe of its real width
 *   bloom     -> `(@)` can act; `@` is a closed bud, a real dormant state for that kind
 *   growth    -> the plant typing itself in on arrival, under the same "motion reports state"
 *                contract the onboarding TulipGrowth works to
 *   footprint -> the planted patch widens as the farm fills, so a young farm has bare ground
 *                around it and a full one carpets the frame
 *
 * Every glyph in a field is set at one size. ASCII reads as ASCII because the character cell is
 * constant, so distance is spent on alpha, stem height and pitch instead of on font size.
 *
 * Position and sway come from a hash of the planting id, never `Math.random`, so a farm keeps its
 * shape between visits and a new tulip joins the field instead of reshuffling it.
 *
 * The canvas is `aria-hidden`: it is a picture of data the page also publishes as real links, so a
 * keyboard or screen-reader visitor gets that list rather than an unreachable drawing.
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
const SPROUT_MS = 900;
/** Radians per millisecond. Slow enough that the sails read as sails, not as a fan. */
const MILL_SPEED = 0.0005;
const SPROUT_STAGGER_MS = 34;
const MAX_ROWS = 8;

/*
 * The tulip is type, not vector art. This is the same field the docs home page draws: a `(@)` head
 * on a `|` stem with a `/` or `\\` leaf, set in the mono face. Drawn shapes were tried and read as
 * crowns and buckets; the glyph reads as a tulip because it is a mark, not a bad likeness.
 */
const HEAD_OPEN = "(@)";
/** A closed bud: the artifact exists but nothing can start it. */
const HEAD_BUD = "@";
/**
 * Vertical px per stem row at scale 1, held just under the font size so consecutive `|` glyphs
 * touch. Set them equal and the stem draws as a dashed line, which grows into gaps as the type
 * scales up.
 */
const ROW_PX = 11;
const FONT_PX = 13;
const FONT_STACK = '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace';
const GROUND_CHARS = [",", ".", "'", "`"] as const;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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

const EMPTY_FIELD: Field = {
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

type Speck = { x: number; y: number; ch: string; p: number };

type Palette = {
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

function makeSoil(field: Field, width: number): Speck[] {
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

/*
 * Land beyond the crop. None of this encodes anything — it is the horizon a field is seen against,
 * so it is drawn in the ground ink at low alpha and never touches the categorical palette. The one
 * thing it does report is whether the farm is running: the mill turns while something is planted
 * and stands still over bare soil.
 */
type Scenery = {
  /** Type size of the far ground, which the buildings are then sized against. */
  unit: number;
  /** A distant treeline. Marks, not a line: a continuous stroke reads as a divider rule. */
  trees: { x: number; y: number; ch: string }[];
  mill: { x: number; y: number; unit: number } | null;
  /** The farmstead sign. Absent rather than invented when the instance has no business name. */
  barn: { x: number; y: number; unit: number; rows: string[] } | null;
};

/** Two out-of-phase waves, so the far ground rolls rather than stepping. */
function ridgeAt(i: number): number {
  return Math.sin(i * 0.055) * 0.6 + Math.sin(i * 0.019 + 1.7) * 0.4;
}

/** Centres a label in a fixed cell run, because every row of the barn has to be the same width. */
function centred(text: string, width: number, fill = " "): string {
  const left = Math.floor((width - text.length) / 2);
  return (
    fill.repeat(Math.max(0, left)) + text + fill.repeat(Math.max(0, width - text.length - left))
  );
}

/*
 * A gambrel barn, sized to the name painted on it. The sign is the instance's own business name,
 * so an unnamed instance gets a barn with a blank board rather than a placeholder someone might
 * read as real.
 */
export function barnRows(name: string): string[] {
  const label = name.trim().toUpperCase().slice(0, 16);
  const width = Math.max(label.length + 2, 9);
  const total = width + 2;
  const door = `|${"X".repeat(Math.max(1, Math.round(width / 5)))}|`;
  // Horizontals are underscores, never hyphens: only `_` fills its whole cell, so only `_` joins.
  const pitches = Math.max(2, Math.round(width / 6));
  const roof: string[] = [centred("_".repeat(Math.round(width / (pitches + 1))), total)];
  for (let step = 1; step <= pitches; step++) {
    const span = Math.round((width * (step + 1)) / (pitches + 1));
    roof.push(centred(`/${"_".repeat(span)}\\`, total));
  }

  return [
    ...roof,
    `|${centred(label, width)}|`,
    `|${centred(door, width)}|`,
    // The doors stand on the sill rather than one row above it, or they read as windows.
    `|${centred(door, width, "_")}|`,
  ];
}

function makeScenery(field: Field, width: number, height: number, farmName: string): Scenery {
  /*
   * Scenery stands on the skyline, above the tallest bloom rather than among the rows. Sharing the
   * crop's ground line put the mill and the barn inside the planting, where they read as debris
   * tangled in the stems instead of as distance.
   */
  const headroom = Math.max(0, field.skyY - height * 0.03);
  // Sized to the frame, not to the space going spare: scenery that grows when the crop is
  // sparse stops reading as distance and starts competing with the first tulip.
  const unit = clamp(Math.min(height * 0.026, headroom / 12), 8, 18);
  const step = unit * 0.7;
  const cells = Math.ceil(width / step) + 1;
  const relief = unit * 1.2;
  const base = field.skyY - unit * 0.4;
  // Always at or above the skyline: a negative swing would drop the far ground into the crop.
  const groundAt = (x: number) => base - (0.5 + 0.5 * ridgeAt(x / step)) * relief;
  const trees: Scenery["trees"] = [];

  for (let i = 0; i < cells; i++) {
    // Broken and uneven: a run of equal marks at one height reads as a comb, not as a treeline.
    if (indexSeed(i, 4) < 0.34) continue;
    trees.push({
      x: i * step,
      y: groundAt(i * step) - indexSeed(i, 5) * unit * 0.8,
      ch: "^",
    });
  }

  // Nothing built when the crop leaves no skyline to build on; the treeline alone still reads.
  if (headroom < unit * 11) return { unit, trees, mill: null, barn: null };

  // Left of centre, the way the banner sets its farmstead, and always inside the frame.
  const millX = clamp(width * 0.2, unit * 6, width - unit * 6);
  const rows = barnRows(farmName);
  const barnUnit = unit * 0.85;
  const barnX = millX + unit * 3.2 + ((rows[1]?.length ?? 0) * barnUnit) / 3.2;

  return {
    unit,
    trees,
    mill: { x: millX, y: groundAt(millX), unit },
    barn:
      barnX < width - barnUnit * 4 ? { x: barnX, y: groundAt(barnX), unit: barnUnit, rows } : null,
  };
}

/*
 * A four-sail mill. A glyph cannot be rotated, so each sail is rasterised onto the character grid
 * one cell at a time and each cell takes the glyph of the step that reached it — `=` across, `|`
 * up, `\` or `/` on a corner. Choosing one glyph for a whole arm from its average slope is what
 * made the sails come out as a hatch: every cell landed a fraction off the last instead of
 * continuing it.
 */
const MILL_TOWER = [
  "  ___  ",
  " /===\\ ",
  " |===| ",
  " |===| ",
  "|=====|",
  "|=====|",
  "|=====|",
  "|_____|",
] as const;
const SAIL_ARMS = 4;
const SAIL_REACH = 4.4;
/** Advance width and line height of one monospace cell, as fractions of the type size. */
const CELL_W = 0.6;
const CELL_H = 0.85;

/** Draws a stack of equal-width rows standing on `y`, centred on `x`. */
function drawBuilding(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  x: number,
  y: number,
  unit: number
) {
  const top = y - rows.length * unit;
  rows.forEach((line, i) => {
    ctx.fillText(line, x, top + (i + 0.5) * unit);
  });
  return top;
}

/** The glyph that continues a line by one grid cell in this direction. */
function stepGlyph(dc: number, dr: number): string {
  if (dr === 0) return "=";
  if (dc === 0) return "|";
  return dc * dr > 0 ? "\\" : "/";
}

/**
 * One sail, doubled a half-cell to the side over its outer reach so it reads as a framed sail
 * rather than a hairline, and tapers into the hub the way a real one does.
 */
function drawSail(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  unit: number
) {
  const cw = unit * CELL_W;
  const ch = unit * CELL_H;
  const reach = unit * SAIL_REACH;
  const tipC = Math.round((Math.cos(angle) * reach) / cw);
  const tipR = Math.round((Math.sin(angle) * reach) / ch);
  const steps = Math.max(Math.abs(tipC), Math.abs(tipR));
  if (steps === 0) return;

  const span = Math.hypot(tipC * cw, tipR * ch);
  const offX = ((-tipR * ch) / span) * unit * 0.5;
  const offY = ((tipC * cw) / span) * unit * 0.5;

  let col = 0;
  let row = 0;
  for (let i = 1; i <= steps; i++) {
    const nextC = Math.round((tipC * i) / steps);
    const nextR = Math.round((tipR * i) / steps);
    const glyph = stepGlyph(nextC - col, nextR - row);
    col = nextC;
    row = nextR;
    const cx = x + col * cw;
    const cy = y + row * ch;
    ctx.fillText(glyph, cx, cy);
    if (i > steps / 3) ctx.fillText(glyph, cx + offX, cy + offY);
  }
}

function drawWindmill(
  ctx: CanvasRenderingContext2D,
  mill: NonNullable<Scenery["mill"]>,
  turn: number,
  alpha: number
) {
  const { x, y, unit } = mill;
  ctx.font = `${unit}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = alpha;

  const hubY = drawBuilding(ctx, MILL_TOWER, x, y, unit) + unit * 0.6;
  for (let arm = 0; arm < SAIL_ARMS; arm++) {
    drawSail(ctx, x, hubY, turn + (arm * Math.PI * 2) / SAIL_ARMS, unit);
  }
  ctx.fillText("o", x, hubY);
  ctx.globalAlpha = 1;
}

function drawBarn(
  ctx: CanvasRenderingContext2D,
  barn: NonNullable<Scenery["barn"]>,
  alpha: number
) {
  ctx.font = `${barn.unit}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = alpha;
  drawBuilding(ctx, barn.rows, barn.x, barn.y, barn.unit);
  ctx.globalAlpha = 1;
}

function resolvePalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const crops = {} as Record<CropKind, string>;
  for (const crop of CROPS) crops[crop.kind] = read(crop.colorVar, "#8a8a8a");
  return {
    stem: read("--tulip-stem", "#4f7a5c"),
    ground: read("--muted-foreground", "#7d7770"),
    crops,
  };
}

/** Ease-out cubic, so growth decelerates into place rather than arriving at full speed. */
function easeOut(progress: number): number {
  return 1 - (1 - clamp(progress, 0, 1)) ** 3;
}

/** Sub-progress of one growth phase within the whole sprout. */
function phaseOf(grow: number, from: number, to: number): number {
  return easeOut((grow - from) / (to - from));
}

function drawTulip(
  ctx: CanvasRenderingContext2D,
  stalk: Stalk,
  palette: Palette,
  sway: number,
  grow: number
) {
  const stem = phaseOf(grow, 0, 0.55);
  const head = phaseOf(grow, 0.45, 1);
  if (stem <= 0) return;

  const s = stalk.scale;
  const row = ROW_PX * s;

  ctx.font = `${FONT_PX * s}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const grown = Math.max(1, Math.round(stalk.rows * stem));
  // Sway accumulates up the stem, so the head travels and the base stays rooted.
  const bend = (i: number) => sway * (i / stalk.rows) ** 1.7;
  const depthFade = 0.4 + stalk.p * 0.45;

  ctx.fillStyle = palette.stem;
  ctx.globalAlpha = clamp(depthFade * 0.85 + stalk.focus * 0.25, 0, 1);
  for (let i = 1; i < grown; i++) {
    const dx = bend(i);
    const y = stalk.y - i * row;
    ctx.fillText("|", stalk.x + dx, y);
    if (i === stalk.leafRow) {
      ctx.fillText(stalk.leafDir > 0 ? "/" : "\\", stalk.x + dx + stalk.leafDir * 7 * s, y - 3 * s);
    }
  }

  if (head <= 0 || grown < stalk.rows) {
    stalk.headX = Number.NaN;
    stalk.headY = Number.NaN;
    stalk.headR = Number.NaN;
    return;
  }

  const headX = stalk.x + bend(stalk.rows);
  const headY = stalk.y - stalk.rows * row;
  ctx.fillStyle = palette.crops[stalk.planting.kind] ?? palette.stem;
  ctx.globalAlpha = clamp(depthFade + 0.15 + stalk.focus * 0.3, 0, 1);
  ctx.fillText(stalk.planting.bloomed ? HEAD_OPEN : HEAD_BUD, headX, headY);

  stalk.headX = headX;
  stalk.headY = headY;
  stalk.headR = Math.max(12, FONT_PX * s * 1.1);
}

function drawField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  field: Field,
  soil: Speck[],
  scenery: Scenery,
  palette: Palette,
  time: number,
  pointer: { x: number; y: number; active: boolean },
  focusedId: string | null,
  settled: boolean
) {
  ctx.clearRect(0, 0, width, height);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = palette.ground;

  /*
   * Scenery goes down before the crop, so tulips stand in front of the ridge and the mill and the
   * whole thing reads as one distance rather than as a backdrop pasted behind a foreground.
   */
  ctx.globalAlpha = 0.38;
  ctx.font = `${scenery.unit * 0.8}px ${FONT_STACK}`;
  for (const tree of scenery.trees) ctx.fillText(tree.ch, tree.x, tree.y);
  // A farm with a crop is a farm at work; bare soil parks the sails crossed.
  const turn = field.stalks.length > 0 ? time * MILL_SPEED : Math.PI / 4;
  if (scenery.mill) drawWindmill(ctx, scenery.mill, turn, 0.68);
  if (scenery.barn) drawBarn(ctx, scenery.barn, 0.62);

  /*
   * The ground is typed too: a scatter of `,` and `'` along each row's baseline. There is no
   * painted soil plane — the page background is the field, exactly as on the docs home page.
   */
  ctx.fillStyle = palette.ground;
  // Litter is set smaller than the crop: at a showcase scale, em-sized commas read as debris.
  ctx.font = `${FONT_PX * clamp(field.scale, 0.6, 1.4)}px ${FONT_STACK}`;
  for (const speck of soil) {
    ctx.globalAlpha = 0.18 + speck.p * 0.22;
    ctx.fillText(speck.ch, speck.x, speck.y);
  }
  ctx.globalAlpha = 1;

  for (const stalk of field.stalks) {
    const grow = settled ? 1 : easeOut((time - stalk.sproutDelay) / SPROUT_MS);
    if (grow <= 0) {
      stalk.headX = Number.NaN;
      stalk.headY = Number.NaN;
      continue;
    }

    const wanted = stalk.planting.id === focusedId ? 1 : 0;
    stalk.focus = settled ? wanted : stalk.focus + (wanted - stalk.focus) * 0.18;

    let target = 0;
    if (pointer.active) {
      const distance = stalk.x - pointer.x;
      const radius = 140 * stalk.scale;
      if (Math.abs(distance) < radius) {
        const falloff = 1 - Math.abs(distance) / radius;
        target = Math.sign(distance || 1) * falloff * falloff * 26 * stalk.scale;
      }
    }
    stalk.push += (target - stalk.push) * 0.1;

    // A focused tulip stands up and stops swaying, so the label it anchors does not chase it.
    const calm = 1 - stalk.focus;
    const gust = Math.sin(time * 0.00035 + stalk.u * 4) * 5 * stalk.scale;
    const sway =
      (Math.sin(time * stalk.speed + stalk.phase) * stalk.amp + gust + stalk.push) * calm;

    drawTulip(ctx, stalk, palette, sway, grow);
  }

  ctx.globalAlpha = 1;
}

export type FieldFocus = { planting: Planting; x: number; y: number };

export function TulipField({
  plantings,
  farmName = "",
  className,
  onFocusChange,
}: {
  plantings: readonly Planting[];
  /** Painted on the barn. Left blank rather than guessed when the instance has no name yet. */
  farmName?: string;
  className?: string;
  /** Reports the tulip under the pointer, so the page can render its label as real DOM. */
  onFocusChange?: (focus: FieldFocus | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigate = useNavigate();
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Read inside the frame loop, so a hover never re-runs the canvas effect and restarts growth.
  const focusedRef = useRef<Planting | null>(null);
  const reportFocus = useRef(onFocusChange);
  reportFocus.current = onFocusChange;

  const setFocus = useCallback((focus: FieldFocus | null) => {
    focusedRef.current = focus?.planting ?? null;
    setFocusedId(focus?.planting.id ?? null);
    reportFocus.current?.(focus);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");

    const pointer = { x: 0, y: 0, active: false };
    let palette = resolvePalette();
    let width = 0;
    let height = 0;
    let field = EMPTY_FIELD;
    let soil: Speck[] = [];
    let scenery = makeScenery(EMPTY_FIELD, 0, 0, farmName);
    let raf = 0;
    let running = false;
    let visible = false;
    let start = 0;

    const paint = (time: number, settled: boolean) =>
      drawField(
        ctx,
        width,
        height,
        field,
        soil,
        scenery,
        palette,
        time,
        pointer,
        focusedRef.current?.id ?? null,
        settled
      );

    /*
     * Every still frame is drawn settled. Reduced motion and a hidden tab must land on the grown
     * field, never on a half-drawn one waiting for an animation that will not run.
     */
    const paintStill = () => paint(SPROUT_MS + field.stalks.length * SPROUT_STAGGER_MS, true);

    const loop = (now: number) => {
      if (start === 0) start = now;
      paint(now - start, false);
      raf = requestAnimationFrame(loop);
    };

    const syncLoop = () => {
      const shouldRun = visible && !document.hidden && !reduceMotion.matches;
      if (shouldRun && !running) {
        running = true;
        raf = requestAnimationFrame(loop);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
        paintStill();
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      if (width <= 0 || height <= 0) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      field = layoutField(plantings, width, height);
      soil = makeSoil(field, width);
      scenery = makeScenery(field, width, height, farmName);
      if (!running) paintStill();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      syncLoop();
    });
    intersectionObserver.observe(canvas);

    const themeObserver = new MutationObserver(() => {
      palette = resolvePalette();
      if (!running) paintStill();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });

    const onVisibility = () => syncLoop();
    const onMotionChange = () => {
      start = 0;
      syncLoop();
      if (reduceMotion.matches) paintStill();
    };

    const hitTest = (x: number, y: number): Stalk | null => {
      let best: Stalk | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      // Front to back, so the tulip drawn on top is the one the pointer gets.
      for (let i = field.stalks.length - 1; i >= 0; i--) {
        const stalk = field.stalks[i];
        if (!stalk || Number.isNaN(stalk.headX)) continue;
        const distance = Math.hypot(stalk.headX - x, stalk.headY - y);
        if (distance < stalk.headR && distance < bestDistance) {
          best = stalk;
          bestDistance = distance;
        }
      }
      return best;
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.active = finePointer.matches;

      const hit = hitTest(pointer.x, pointer.y);
      canvas.style.cursor = hit ? "pointer" : "default";
      if (hit?.planting.id !== focusedRef.current?.id) {
        // Anchored to the top of the head, not its centre, or the label card clips the bloom.
        setFocus(hit ? { planting: hit.planting, x: hit.headX, y: hit.headY - hit.headR } : null);
      }
      if (!running) paintStill();
    };

    const onPointerLeave = () => {
      pointer.active = false;
      setFocus(null);
      if (!running) paintStill();
    };

    const onClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (hit) navigate(hit.planting.href);
    };

    resize();
    document.addEventListener("visibilitychange", onVisibility);
    reduceMotion.addEventListener("change", onMotionChange);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion.removeEventListener("change", onMotionChange);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, [navigate, setFocus, plantings, farmName]);

  return (
    /*
     * The canvas is absolutely positioned because a sized canvas reports its bitmap as intrinsic
     * height. In flow it would grow its own parent, which the ResizeObserver would then read back
     * as a larger box — a feedback loop that inflates the field on every frame.
     */
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
        aria-hidden
        data-focused={focusedId ?? undefined}
        data-testid="tulip-field"
      />
    </div>
  );
}
