"use client";

import { useEffect, useRef } from "react";

/** Canvas ASCII tulip field; ruby stays sparse and reduced motion renders one frame. */

type Tulip = {
  x: number;
  h: number; // stem height in rows
  phase: number;
  speed: number;
  amp: number;
  head: string;
  ruby: boolean;
  leafRow: number;
  leafDir: 1 | -1;
  back: boolean;
  push: number; // eased pointer displacement
};

type Speck = { x: number; y: number; ch: string };

type Colors = { ink: string; stem: string; ground: string; ruby: string };

const ROW = 13; // vertical px per stem row
const FONT = '13px "JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace';
const GROUND_CHARS = [",", ".", "'", "`", ","];

function makeField(width: number, height: number): { tulips: Tulip[]; specks: Speck[] } {
  const tulips: Tulip[] = [];
  for (const back of [true, false]) {
    const step = back ? 30 : 42;
    let x = step * Math.random();
    while (x < width + 20) {
      const h = back ? 3 + Math.floor(Math.random() * 3) : 5 + Math.floor(Math.random() * 4);
      tulips.push({
        x,
        h,
        phase: Math.random() * Math.PI * 2,
        speed: 0.0009 + Math.random() * 0.0007,
        amp: back ? 2 + Math.random() * 2.5 : 3 + Math.random() * 4,
        head: Math.random() < 0.3 ? "@" : "(@)",
        ruby: !back && Math.random() < 0.16,
        leafRow: 1 + Math.floor(h * (0.3 + Math.random() * 0.25)),
        leafDir: Math.random() < 0.5 ? 1 : -1,
        back,
        push: 0,
      });
      x += step * (0.7 + Math.random() * 0.6);
    }
  }
  const specks: Speck[] = [];
  for (let x = 4; x < width; x += 7 + Math.random() * 10) {
    specks.push({
      x,
      y: height - 4 - Math.random() * 10,
      ch: GROUND_CHARS[Math.floor(Math.random() * GROUND_CHARS.length)],
    });
  }
  return { tulips, specks };
}

function resolveColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--color-fd-foreground", "#3a342f"),
    stem: v("--color-fd-muted-foreground", "#7d7770"),
    ground: v("--color-fd-muted-foreground", "#7d7770"),
    ruby: v("--color-fd-primary", "#9f1239"),
  };
}

function drawField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tulips: Tulip[],
  specks: Speck[],
  colors: Colors,
  t: number,
  pointer: { x: number; active: boolean }
) {
  ctx.clearRect(0, 0, width, height);
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = colors.ground;
  ctx.globalAlpha = 0.4;
  for (const s of specks) ctx.fillText(s.ch, s.x, s.y);

  for (const tulip of tulips) {
    const baseY = tulip.back ? height - 8 - ROW * 1.8 : height - 8;
    const gust = Math.sin(t * 0.0004 + tulip.x * 0.004) * 5;

    let target = 0;
    if (pointer.active) {
      const d = tulip.x - pointer.x;
      const radius = 140;
      if (Math.abs(d) < radius) {
        const f = 1 - Math.abs(d) / radius;
        target = Math.sign(d || 1) * f * f * 26;
      }
    }
    tulip.push += (target - tulip.push) * 0.1;

    const sway = Math.sin(t * tulip.speed + tulip.phase) * tulip.amp + gust + tulip.push;

    for (let i = 1; i <= tulip.h; i++) {
      const dx = sway * (i / tulip.h) ** 1.7;
      const y = baseY - i * ROW;
      if (i === tulip.h) {
        ctx.fillStyle = tulip.ruby ? colors.ruby : colors.ink;
        ctx.globalAlpha = tulip.back ? 0.35 : tulip.ruby ? 0.95 : 0.75;
        ctx.fillText(tulip.head, tulip.x + dx, y);
      } else {
        ctx.fillStyle = colors.stem;
        ctx.globalAlpha = tulip.back ? 0.3 : 0.7;
        ctx.fillText("|", tulip.x + dx, y);
        if (i === tulip.leafRow) {
          ctx.fillText(tulip.leafDir > 0 ? "/" : "\\", tulip.x + dx + tulip.leafDir * 7, y - 3);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

export function TulipField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    const pointer = { x: 0, active: false };
    let colors = resolveColors();
    let width = 0;
    let height = 0;
    let tulips: Tulip[] = [];
    let specks: Speck[] = [];
    let raf = 0;
    let running = false;
    let visible = false;

    const renderStill = () => drawField(ctx, width, height, tulips, specks, colors, 0, pointer);

    const loop = (t: number) => {
      drawField(ctx, width, height, tulips, specks, colors, t, pointer);
      raf = requestAnimationFrame(loop);
    };

    const syncLoop = () => {
      const shouldRun = visible && !document.hidden && !reduceMotion;
      if (shouldRun && !running) {
        running = true;
        raf = requestAnimationFrame(loop);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ({ tulips, specks } = makeField(width, height));
      if (!running) renderStill();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncLoop();
    });
    io.observe(canvas);

    const onVisibility = () => syncLoop();
    document.addEventListener("visibilitychange", onVisibility);

    // Re-resolve token colors when the theme class flips on <html>.
    const themeObserver = new MutationObserver(() => {
      colors = resolveColors();
      if (!running) renderStill();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const onPointerMove = (e: PointerEvent) => {
      if (reduceMotion || !finePointer) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.active = true;
    };
    const onPointerLeave = () => {
      pointer.active = false;
    };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    // Redraw once the variable font is ready so the field never renders in a fallback face.
    document.fonts.ready.then(() => {
      if (!running) renderStill();
    });

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      io.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
