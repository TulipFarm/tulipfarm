import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * Pixel-grid loader for work whose duration is unknown. Motion reports real state — something is
 * in flight — and the elapsed timer keeps that claim honest once the wait stops feeling short.
 *
 * Variant and word are picked once per mount when the caller does not name them, so a long wait
 * is not always the same wait. Pass `label` wherever the copy has to say something specific.
 */

export const LOADER_VARIANTS = ["drive", "dots", "orbit", "rain"] as const;
export type LoaderVariant = (typeof LOADER_VARIANTS)[number];
/** Right-driving chevron: column sets the wavefront, distance from the middle row bends it. */
const CHEVRON = Array.from(
  { length: 9 },
  (_, i) => ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90
);

/** A comet lapping the perimeter; the centre cell sits out and stays dim. */
const ORBIT_PATH = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const step = ORBIT_PATH.indexOf(i);
  return step === -1 ? null : step * 110;
});

/** Rows falling, lightly staggered across the columns so it reads as rain, not a dropping bar. */
const RAIN = Array.from({ length: 9 }, (_, i) => Math.floor(i / 3) * 180 + (i % 3) * 60);

const PATTERNS: Record<
  LoaderVariant,
  { delays: (number | null)[]; durMs: number; round: boolean }
> = {
  drive: { delays: CHEVRON, durMs: 650, round: false },
  dots: { delays: CHEVRON, durMs: 650, round: true },
  orbit: { delays: ORBIT, durMs: 950, round: false },
  rain: { delays: RAIN, durMs: 780, round: false },
};

/**
 * One or two words, present participle, drawn from the field the product is named for. Each says
 * something is *growing*, which reads as progress rather than delay — a loader that says "Still
 * going" apologizes for a wait the reader had not yet decided was long.
 *
 * `Blooming`, `Planting` and `Harvesting` are deliberately absent: `app/lib/farm.ts` spends all
 * three on real artifact state, and a loader borrowing them would look like it was reporting one.
 */
export const LOADER_LABELS = [
  "Sprouting",
  "Budding",
  "Unfurling",
  "Greening",
  "Taking root",
  "Perking up",
  "Rising",
  "Coming up",
] as const;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function LoaderGrid({ variant }: { variant: LoaderVariant }) {
  const { delays, durMs, round } = PATTERNS[variant];
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          data-idle={delay === null ? "true" : undefined}
          className={cn(
            "tf-loader-pixel size-[4px] bg-foreground",
            round ? "rounded-full" : "rounded-[1px]"
          )}
          style={
            delay === null
              ? undefined
              : ({
                  "--pixel-dur": `${durMs}ms`,
                  "--pixel-delay": `${delay}ms`,
                } as React.CSSProperties)
          }
        />
      ))}
    </span>
  );
}

function formatElapsed(tenths: number) {
  const seconds = tenths / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

function useElapsed() {
  const [tenths, setTenths] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTenths((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, []);
  return formatElapsed(tenths);
}

export type LoadingStateProps = {
  /** Fixed copy for this wait. Omit to draw one from the shared list on mount. */
  label?: string;
  /** Fixed pattern. Omit to draw one on mount. */
  variant?: LoaderVariant;
  /** Hide the elapsed timer where the surface already reports duration. */
  showElapsed?: boolean;
  className?: string;
};

export function LoadingState({ label, variant, showElapsed = true, className }: LoadingStateProps) {
  const [drawn] = useState(() => ({ label: pick(LOADER_LABELS), variant: pick(LOADER_VARIANTS) }));
  const elapsed = useElapsed();
  const resolvedVariant = variant ?? drawn.variant;
  const resolvedLabel = label ?? drawn.label;

  return (
    <div role="status" className={cn("flex w-fit items-center gap-2.5", className)}>
      <LoaderGrid variant={resolvedVariant} />
      {/* The word and the ticking timer are aria-hidden: a live region that re-announced ten times
          a second would be unusable. The status region says one stable thing instead. */}
      <span aria-hidden className="tf-loader-label text-sm font-medium">
        {resolvedLabel}
      </span>
      {showElapsed ? (
        <span aria-hidden className="font-mono text-xs tabular-nums text-muted-foreground">
          {elapsed}
        </span>
      ) : null}
      <span className="sr-only">Loading</span>
    </div>
  );
}
