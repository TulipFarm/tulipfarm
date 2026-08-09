import { cn } from "~/lib/utils";

/*
 * An integration's mark: the brand's Simple Icons glyph when it has one, a derived monogram when
 * it does not.
 *
 * The fallback is not an edge case. Slack and Microsoft Teams asked to be removed from the icon
 * set, so two of the integrations this product cares most about will never resolve a mark — the
 * monogram has to look deliberate rather than broken.
 *
 * Marks render in `currentColor` rather than the brand's official colour. Several official
 * colours (GitHub's #181717, Notion's #000000) vanish against a dark surface, and a row of marks
 * where some are branded and the rest are monograms reads as a rendering failure, not as branding.
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
  size = "md",
  className,
}: {
  /** Display name — the monogram source. */
  label: string;
  /** Simple Icons path data from the API; absent when the brand has no mark. */
  iconPath?: string;
  size?: IntegrationIconSize;
  className?: string;
}) {
  const style = SIZE[size];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-muted-foreground",
        style.box,
        className
      )}
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
        <span className={cn("font-medium", style.text)}>{monogram(label)}</span>
      )}
    </span>
  );
}
