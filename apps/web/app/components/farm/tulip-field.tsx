import { useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CROPS, type CropKind, type Planting } from "~/lib/farm";
import { cn } from "~/lib/utils";
import {
  clamp,
  EMPTY_FIELD,
  type Field,
  FONT_PX,
  FONT_STACK,
  HEAD_BUD,
  HEAD_OPEN,
  layoutField,
  makeSoil,
  type Palette,
  ROW_PX,
  SPROUT_MS,
  SPROUT_STAGGER_MS,
  type Speck,
  type Stalk,
} from "./field-layout";
import { drawScenery, makeScenery, type Scenery } from "./field-scenery";

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

  drawScenery(ctx, scenery, field.stalks.length > 0, time);

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
