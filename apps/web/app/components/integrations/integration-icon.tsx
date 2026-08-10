import type { CSSProperties } from "react";
import { brandInk } from "~/lib/brand";
import { cn } from "~/lib/utils";

/*
 * An integration's mark: the brand's Simple Icons glyph when it has one, a derived monogram when
 * it does not — both in the brand's own colour.
 *
 * The fallback is not an edge case. Slack and Microsoft Teams asked to be removed from the icon
 * set, so integrations this product cares about will never resolve a mark, and the monogram has to
 * look deliberate rather than broken. Colour is what makes that hold: a monogram carries the
 * brand's colour from the registry, so it reads as a brand without a logo rather than as the one
 * grey tile in a row of coloured ones. Wearing a brand's colour is not the trademark question that
 * reproducing its logo would be.
 *
 * Brand hex is never rendered as it arrives — `brandInk` corrects it per canvas. Both corrections
 * are written to custom properties here and switched by the `dark:` variant, so changing theme
 * repaints with no JavaScript and server-rendered markup is right before hydration. A brand with
 * no colour at all falls back to the muted foreground, which is the honest treatment for an
 * integration installed from a URL that no registry curates.
 */

const SIZE = {
  sm: { box: "size-5", mark: "size-3", text: "text-[0.5rem]" },
  md: { box: "size-8", mark: "size-4", text: "text-[0.625rem]" },
  lg: { box: "size-11", mark: "size-6", text: "text-sm" },
} as const;

export type IntegrationIconSize = keyof typeof SIZE;

/**
 * Up to two initials from the integration's display name: "Google Drive" → GD, "slack" → SL.
 * Two letters because single initials collide constantly across a catalog of this shape.
 */
export function monogram(label: string): string {
  const words = label.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2);
  return letters.toUpperCase();
}

export function IntegrationIcon({
  label,
  iconPath,
  iconColor,
  size = "md",
  className,
}: {
  /** Display name — the monogram source. */
  label: string;
  /** Simple Icons path data from the API; absent when the brand has no mark. */
  iconPath?: string;
  /** Brand hex without `#`; absent for an integration no registry curates. */
  iconColor?: string;
  size?: IntegrationIconSize;
  className?: string;
}) {
  const style = SIZE[size];
  const ink = brandInk(iconColor);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border",
        style.box,
        ink
          ? cn(
              "[--brand:var(--brand-light)] dark:[--brand:var(--brand-dark)]",
              // Tile and mark are the same colour, the tile held far enough back to stay a
              // surface. Derived from the one value so a brand can never wear another's.
              "border-[color-mix(in_oklab,var(--brand)_25%,transparent)]",
              "bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]",
              "text-[var(--brand)]"
            )
          : "border-border bg-muted text-muted-foreground",
        className
      )}
      style={
        ink
          ? ({ "--brand-light": ink.light, "--brand-dark": ink.dark } as CSSProperties)
          : undefined
      }
    >
      {iconPath ? (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
          className={style.mark}
        >
          <path d={iconPath} />
        </svg>
      ) : (
        <span className={cn("font-semibold", style.text)}>{monogram(label)}</span>
      )}
    </span>
  );
}
