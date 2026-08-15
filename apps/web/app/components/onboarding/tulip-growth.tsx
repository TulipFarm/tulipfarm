import { cn } from "~/lib/utils";

export type TulipStage = 0 | 1 | 2 | 3;

export interface TulipGrowthProps {
  /** How many of the three setup questions are answered. Drives which parts render. */
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
        d="M60,140 L60,70"
        pathLength={1}
        fill="none"
        stroke="var(--tulip-stem)"
        strokeWidth={3}
        strokeLinecap="round"
      />

      <path
        className="tulip-grow"
        data-from={1}
        d="M60,118 C42,113 36,98 45,86 C56,100 60,110 60,118 Z"
        fill="var(--tulip-stem)"
      />
      <path
        className="tulip-grow"
        data-from={1}
        d="M60,124 C78,120 85,105 77,92 C65,106 60,116 60,124 Z"
        fill="var(--tulip-stem)"
      />

      <ellipse
        className="tulip-grow tulip-bud"
        data-from={2}
        cx={60}
        cy={58}
        rx={12}
        ry={18}
        fill="var(--primary)"
      />

      <g className="tulip-grow" data-from={3}>
        <path d="M60,72 L48,36 C48,20 60,10 60,26 Z" fill="var(--primary)" />
        <path d="M60,72 L72,36 C72,20 60,10 60,26 Z" fill="var(--primary)" />
        <path d="M60,72 L60,20 C68,10 74,20 74,32 C74,52 66,66 60,72 Z" fill="var(--primary)" />
        <path d="M60,72 L60,20 C52,10 46,20 46,32 C46,52 54,66 60,72 Z" fill="var(--primary)" />
        <g className="tulip-eyes">
          <ellipse cx={53} cy={46} rx={4} ry={5} fill="var(--primary-foreground)" />
          <ellipse cx={67} cy={46} rx={4} ry={5} fill="var(--primary-foreground)" />
        </g>
      </g>
    </svg>
  );
}
