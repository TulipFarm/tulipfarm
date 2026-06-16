import type { CSSProperties } from "react";
import type { Autonomy } from "~/lib/agents";
import { cn } from "~/lib/utils";
import { deriveGlyph, GLYPH_ARCHETYPE } from "./derive";
import { GLYPH_VIEWBOX, SHAPES } from "./shapes";

export type GlyphState = "idle" | "thinking" | "success" | "error";
export type GlyphSize = "xs" | "sm" | "md" | "lg";

const SIZE_PX: Record<GlyphSize, number> = { xs: 14, sm: 20, md: 28, lg: 40 };

export interface AgentGlyphProps {
  /** Agent name — drives the hue and the fallback base shape. */
  name: string;
  /** Agent domain — drives the base shape (keyword-mapped). */
  domain?: string;
  /** Agent autonomy — drives the stroke weight. */
  autonomy?: Autonomy;
  /** Animation state; defaults to "idle". The chat header passes "thinking" while streaming. */
  state?: GlyphState;
  size?: GlyphSize;
  /** When true, renders in the ruby brand hue — reserved for the active/focused agent. */
  active?: boolean;
  /** When decorative beside a visible text label, hide from the accessibility tree. */
  decorative?: boolean;
  className?: string;
}

/**
 * Deterministic, motion-aware avatar for an agent. Pure function of {name, domain, autonomy} —
 * see `deriveGlyph`. Stroke-only SVG; hue/weight/state are applied via CSS (see app.css `.glyph-*`).
 */
export function AgentGlyph({
  name,
  domain,
  autonomy,
  state = "idle",
  size = "md",
  active = false,
  decorative = false,
  className,
}: AgentGlyphProps) {
  const { base, hue, weight } = deriveGlyph(name, domain, autonomy);
  const shape = SHAPES[base];
  const px = SIZE_PX[size];
  const style = {
    "--glyph-stroke": active ? "var(--primary)" : `var(--glyph-hue-${hue})`,
    width: px,
    height: px,
  } as CSSProperties;

  const label = `${name} agent, ${GLYPH_ARCHETYPE[base]} archetype`;

  return (
    <svg
      viewBox={GLYPH_VIEWBOX}
      width={px}
      height={px}
      style={style}
      className={cn("glyph", `glyph-${state}`, className)}
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
    >
      {decorative ? null : <title>{label}</title>}
      {shape.paths.map((d) => (
        <path key={d} d={d} pathLength={1} />
      ))}
      {shape.circles?.map((c) => (
        <circle key={`${c.cx}-${c.cy}-${c.r}`} cx={c.cx} cy={c.cy} r={c.r} pathLength={1} />
      ))}
    </svg>
  );
}
