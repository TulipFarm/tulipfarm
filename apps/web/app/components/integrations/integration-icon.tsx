import type { CSSProperties } from "react";
import { brandInk } from "~/lib/brand";
import { cn } from "~/lib/utils";

/*
 * An integration's mark: the brand's Simple Icons glyph when it has one, a derived monogram
 * when it does not — both in the brand's own colour. The fallback is not an edge case.
 */

const SIZE = {
  sm: { box: "size-5", mark: "size-3", text: "text-[0.5rem]" },
  md: { box: "size-8", mark: "size-4", text: "text-[0.625rem]" },
  lg: { box: "size-11", mark: "size-6", text: "text-sm" },
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
  iconPath,
  iconColor,
  size = "md",
  className,
}: {
  label: string;
  /** Simple Icons path data from the API; absent when the brand has no mark. */
  iconPath?: string;
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
