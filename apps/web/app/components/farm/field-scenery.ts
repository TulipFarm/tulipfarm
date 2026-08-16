import { clamp, type Field, FONT_STACK, indexSeed } from "./field-layout";

/*
 * The farmstead: everything beyond the crop. It is scenery, so it never touches the categorical
 * palette and never encodes a count — the one fact it carries is whether the farm is running.
 */

/** Radians per millisecond. Slow enough that the sails read as sails, not as a fan. */
const MILL_SPEED = 0.0005;

/*
 * Land beyond the crop. None of this encodes anything — it is the horizon a field is seen against,
 * so it is drawn in the ground ink at low alpha and never touches the categorical palette. The one
 * thing it does report is whether the farm is running: the mill turns while something is planted
 * and stands still over bare soil.
 */
export type Scenery = {
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

export function makeScenery(
  field: Field,
  width: number,
  height: number,
  farmName: string
): Scenery {
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

/**
 * Lays the horizon down before the crop, so tulips stand in front of the ridge and the mill and
 * the whole thing reads as one distance rather than as a backdrop pasted behind a foreground.
 */
export function drawScenery(
  ctx: CanvasRenderingContext2D,
  scenery: Scenery,
  planted: boolean,
  time: number
) {
  ctx.globalAlpha = 0.38;
  ctx.font = `${scenery.unit * 0.8}px ${FONT_STACK}`;
  for (const tree of scenery.trees) ctx.fillText(tree.ch, tree.x, tree.y);
  // A farm with a crop is a farm at work; bare soil parks the sails crossed.
  const turn = planted ? time * MILL_SPEED : Math.PI / 4;
  if (scenery.mill) drawWindmill(ctx, scenery.mill, turn, 0.68);
  if (scenery.barn) drawBarn(ctx, scenery.barn, 0.62);
}
