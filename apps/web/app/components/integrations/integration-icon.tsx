import type { CSSProperties } from "react";
import { brandInk } from "~/lib/brand";
import { cn } from "~/lib/utils";
import { brandLogo } from "./brand-logo";

/*
 * An integration's mark, in descending order of fidelity: the brand's own full-colour logo when one
 * is vendored, the Simple Icons monochrome glyph in the brand's hex when it is not, and a derived
 * monogram when the brand has neither. The fallbacks are not edge cases — an uncurated entry
 * installed from git reaches the last one.
 *
 * Every mark sits on the same neutral tile, whichever tier it came from. Tinting the tile per brand
 * was worse than it sounds: a grid then reads as five different card designs rather than one, and
 * the brands that do have a vendored full-colour logo cannot be tinted at all without muddying
 * colours the brand chose — so the tint was only ever applied to some tiles, which is exactly what
 * made the row look unfinished. The colour lives in the mark; the tile stays out of its way.
 */

const SIZE = {
  sm: { box: "size-5", mark: "size-3", text: "text-[0.5rem]" },
  md: { box: "size-8", mark: "size-5", text: "text-[0.625rem]" },
  lg: { box: "size-11", mark: "size-7", text: "text-sm" },
} as const;

export type IntegrationIconSize = keyof typeof SIZE;

export function monogram(label: string): string {
  const words = label.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2);
  return letters.toUpperCase();
}

export function IntegrationIcon({
  label,
  iconSlug,
  iconPath,
  iconColor,
  size = "md",
  className,
}: {
  label: string;
  /** Manifest icon slug, used to look up a vendored full-colour mark. */
  iconSlug?: string;
  /** Simple Icons path data from the API; absent when the brand has no mark. */
  iconPath?: string;
  iconColor?: string;
  size?: IntegrationIconSize;
  className?: string;
}) {
  const style = SIZE[size];
  const logo = brandLogo(iconSlug);
  // The tile is always light, so the glyph always wants the light-background variant.
  const ink = brandInk(iconColor)?.light;

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border border-black/[0.07] bg-white",
        "shadow-xs dark:border-white/10 dark:bg-white/95",
        style.box,
        className
      )}
      style={ink ? ({ "--integration-ink": ink } as CSSProperties) : undefined}
    >
      {logo ? (
        <svg viewBox={logo.viewBox} aria-hidden="true" focusable="false" className={style.mark}>
          {logo.paths.map((p) => (
            <path key={p.d} fill={p.fill} d={p.d} />
          ))}
        </svg>
      ) : iconPath ? (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
          className={cn(style.mark, ink ? "text-[var(--integration-ink)]" : "text-foreground/80")}
        >
          <path d={iconPath} />
        </svg>
      ) : (
        <span className={cn("font-semibold text-neutral-500", style.text)}>{monogram(label)}</span>
      )}
    </span>
  );
}
