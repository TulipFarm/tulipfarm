import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * The seven glyph hues, reused here rather than given an eighth palette. An avatar and an agent
 * glyph both answer "which one of these is this?" and nothing more, so they draw from one set;
 * anything that means something — status, run state, a data series — has its own axis and must
 * never be borrowed for an identity.
 */
const HUES = 7;

/** FNV-1a, same construction as `lib/farm.ts`, so identity colour is a fact and never random. */
function hashOf(identity: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function initialsFor(identity: string): string {
  const local = identity.includes("@") ? (identity.split("@")[0] ?? identity) : identity;
  const words = local.split(/[\s._+-]+/).filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word.slice(0, 1))
          .join("")
      : local.slice(0, 2);
  return initials.toUpperCase() || "?";
}

/**
 * A person's or party's mark: two hues off the glyph palette, picked by a hash of the identity, in
 * a fixed diagonal sweep.
 *
 * The gradient is decoration for a name that is always rendered beside it, which is why the whole
 * element is `aria-hidden` — a screen reader announcing initials after the full name says the same
 * thing twice. Never let it be the only place a party is named.
 *
 * `fallback` renders instead of initials when the party is not a person (a team, an agent), so a
 * non-human still gets a stable mark without pretending to have a name with initials in it.
 */
export function Avatar({
  identity,
  fallback,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  identity: string;
  fallback?: React.ReactNode;
}) {
  const hash = hashOf(identity);
  const from = hash % HUES;
  // `>>>`, not `>>`: over half of all hashes exceed 2^31, and a signed shift makes the remainder
  // negative, which zeroes the offset and collapses the gradient into a flat disc.
  const to = (from + 1 + ((hash >>> 8) % (HUES - 1))) % HUES;

  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full",
        "text-xs font-semibold text-white",
        className
      )}
      style={{
        backgroundImage: `linear-gradient(135deg, var(--glyph-hue-${from}), var(--glyph-hue-${to}))`,
      }}
      {...props}
    >
      {fallback ?? initialsFor(identity)}
    </span>
  );
}
