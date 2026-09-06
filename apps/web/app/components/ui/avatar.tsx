import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Shape is what separates a who from a what, and it is binding across the whole product:
 *
 * - **A circle is somebody** — a person or an Agent. Use `Avatar`.
 * - **A square is a Team** — an organizational unit, never an individual. Use `TeamAvatar`.
 *
 * A reader scanning a list should be able to tell "this file belongs to a group" from "this file
 * belongs to a colleague" before they have read a single character, so never render a Team as a
 * circle, an icon-in-a-circle, or a bare "Team" badge, and never square off a person or an Agent.
 * Roles are neither — they are a rule, not a party — so they keep their outlined glyph.
 */

/**
 * The seven glyph hues, reused here rather than given an eighth palette. An avatar and an agent
 * glyph both answer "which one of these is this?" and nothing more, so they draw from one set;
 * anything that means something — status, run state, a data series — has its own axis and must
 * never be borrowed for an identity.
 */
const HUES = 7;

/**
 * A Team's mark is a full-bleed gradient rather than initials, because a Team is a place and not
 * a name with a first and last. Ten of them, so neighbouring Teams in a directory stay tellable
 * apart at a glance.
 */
const TEAM_BACKGROUNDS = [
  "radial-gradient(circle at 25% 20%, #f9a8d4 0%, transparent 42%), linear-gradient(135deg, #fef3c7 10%, #c084fc 58%, #6366f1 100%)",
  "radial-gradient(circle at 75% 20%, #fdba74 0%, transparent 45%), linear-gradient(145deg, #f472b6 5%, #e11d8a 48%, #7c3aed 100%)",
  "radial-gradient(circle at 72% 22%, #f0abfc 0%, transparent 36%), linear-gradient(145deg, #60a5fa 0%, #a78bfa 48%, #ec4899 100%)",
  "radial-gradient(circle at 60% 52%, #fb923c 0%, #f97316 20%, transparent 48%), linear-gradient(145deg, #dbeafe 0%, #93c5fd 100%)",
  "radial-gradient(circle at 76% 28%, #fef08a 0%, transparent 34%), linear-gradient(145deg, #fb923c 0%, #f43f5e 48%, #c026d3 100%)",
  "linear-gradient(145deg, #ef4444 0%, #f97316 30%, #f8fafc 56%, #38bdf8 74%, #be123c 100%)",
  "linear-gradient(145deg, #7e22ce 0%, #c026d3 42%, #facc15 68%, #fde68a 100%)",
  "linear-gradient(145deg, #fde68a 0%, #fef3c7 40%, #fb7185 42%, #be185d 100%)",
  "radial-gradient(circle at 76% 20%, #fef08a 0%, #86efac 30%, transparent 52%), linear-gradient(145deg, #0f172a 0%, #2563eb 42%, #10b981 100%)",
  "linear-gradient(145deg, #fecdd3 0%, #fda4af 38%, #fb7185 58%, #fdba74 100%)",
] as const;

/** FNV-1a, same construction as `lib/farm.ts`, so identity colour is a fact and never random. */
function hashOf(identity: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Team marks are keyed by a character sum, deliberately not by `hashOf`. Every Team in every
 * business already wears the colour this returns, so swapping in a different hash repaints all of
 * them at once — and on the seeded `engineering` / `everyone` pair, FNV-1a happens to collide.
 */
function teamPaletteIndex(identity: string): number {
  return [...identity].reduce((total, character) => total + character.charCodeAt(0), 0);
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
 * A person's or an Agent's mark: two hues off the glyph palette, picked by a hash of the identity,
 * in a fixed diagonal sweep. **Round, always** — see the shape rule at the top of this file.
 *
 * The gradient is decoration for a name that is always rendered beside it, which is why the whole
 * element is `aria-hidden` — a screen reader announcing initials after the full name says the same
 * thing twice. Never let it be the only place a party is named.
 *
 * `fallback` renders instead of initials when the party has no name with initials in it. A Team is
 * not one of those cases: reach for `TeamAvatar` instead, so the shape stays honest.
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

/**
 * A Team's mark. **Square, always** — see the shape rule at the top of this file.
 *
 * `identity` must be one stable key per Team for the whole product, so the same Team wears the
 * same mark in the directory, on a file row and in a share list. Prefer the slug; fall back to the
 * id only where the slug is genuinely not in hand.
 */
export function TeamAvatar({
  identity,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { identity: string }) {
  const index = teamPaletteIndex(identity) % TEAM_BACKGROUNDS.length;

  return (
    <span
      aria-hidden
      className={cn(
        "size-8 shrink-0 rounded-xl outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
        className
      )}
      style={{ backgroundImage: TEAM_BACKGROUNDS[index] ?? TEAM_BACKGROUNDS[0] }}
      {...props}
    />
  );
}
