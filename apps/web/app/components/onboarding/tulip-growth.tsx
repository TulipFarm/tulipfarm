import { cn } from "~/lib/utils";

export type TulipStage = 0 | 1 | 2 | 3;

export interface TulipGrowthProps {
  /** How many of the four setup questions are answered. Drives which parts render. */
  stage: TulipStage;
  className?: string;
  /** Rendered size in px; keeps the 120x160 aspect ratio. Defaults to the full pre-login size. */
  width?: number;
  height?: number;
}

/**
 * Growth reports real progress through setup — one answered question, one stage — so it stays
 * inside the "motion reports real state" rule rather than being ornamental. `stage` decides which
 * parts *render*; CSS in app.css only animates the transition between them, so a reduced-motion
 * visitor still lands on the correct stage instead of an animation that never completes.
 *
 * The bloom is the brand mark's three-petal face: two outer petals with a deeper centre petal
 * over them, whose tips sit low enough to leave a notch on each side. Petals drawn as one flat
 * fill, or tipped at the same height, merge into a single blob that no longer reads as a tulip.
 */
export function TulipGrowth({ stage, className, width = 120, height = 160 }: TulipGrowthProps) {
  return (
    <svg
      viewBox="0 0 120 160"
      className={cn("tulip-growth", className)}
      data-stage={stage}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <line x1={30} y1={148} x2={90} y2={148} stroke="var(--border)" strokeWidth={1} />
      <ellipse cx={60} cy={142} rx={7} ry={5} fill="var(--tulip-seed)" />

      <path
        className="tulip-stem-path"
        d="M60,140 L60,72"
        pathLength={1}
        fill="none"
        stroke="var(--tulip-stem)"
        strokeWidth={3}
        strokeLinecap="round"
      />

      <path
        className="tulip-grow"
        data-from={1}
        d="M60,120 C45,116 35,103 38,87 C52,95 59,106 60,120 Z"
        fill="var(--tulip-stem)"
      />
      <path
        className="tulip-grow"
        data-from={1}
        d="M60,128 C75,124 85,111 82,95 C68,103 61,114 60,128 Z"
        fill="var(--tulip-stem)"
      />

      <path
        className="tulip-grow tulip-bud"
        data-from={2}
        d="M60,36 C68,45 72,57 72,66 C72,75 67,80 60,81 C53,80 48,75 48,66 C48,57 52,45 60,36 Z"
        fill="var(--primary)"
      />

      <g className="tulip-grow" data-from={3}>
        <path
          d="M58,80 C44,79 33,71 30,58 C27,45 32,32 41,26 C50,36 56,54 58,80 Z"
          fill="var(--primary)"
        />
        <path
          d="M62,80 C76,79 87,71 90,58 C93,45 88,32 79,26 C70,36 64,54 62,80 Z"
          fill="var(--primary)"
        />
        <path
          d="M60,14 C70,26 76,42 76,56 C76,70 69,78 60,80 C51,78 44,70 44,56 C44,42 50,26 60,14 Z"
          fill="var(--tulip-petal-deep)"
        />
        <g className="tulip-eyes">
          <ellipse cx={54} cy={58} rx={5} ry={6.5} fill="var(--primary-foreground)" />
          <ellipse cx={66} cy={58} rx={5} ry={6.5} fill="var(--primary-foreground)" />
        </g>
      </g>
    </svg>
  );
}
