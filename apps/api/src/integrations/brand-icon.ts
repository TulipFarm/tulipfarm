import { readFile } from "node:fs/promises";

/*
 * Resolves a manifest's `icon` slug to a Simple Icons mark: its path data and its brand colour.
 *
 * Resolution happens here rather than in the browser because the icon set is 25MB for ~3400 marks
 * and a deployment needs a handful. Shipping it to the client would cost every operator the whole
 * set to render two rows; resolving it here costs the payload ~700 bytes per integration that
 * actually has a mark, and keeps working for an integration installed from a git repo at runtime,
 * which a build-time bundle could not.
 *
 * The colour is the brand's official hex, unmodified. Making it *legible* is the renderer's job,
 * not this module's: whether GitHub's near-black #181717 needs lightening depends on the canvas it
 * lands on, and only the browser knows which theme is active.
 */

/** Matches `ICON_SLUG_RE` in packages/soul/src/integration-trust.ts. */
const SLUG_RE = /^[a-z0-9_]{1,32}$/;

const PATH_RE = /<path\s+d="([^"]+)"/;

/** A brand's mark: 24×24 path data and the brand's own hex, without the leading `#`. */
export interface BrandIcon {
  readonly path: string;
  readonly hex: string;
}

/** Resolved marks, and the misses, so an unknown slug is not re-resolved on every request. */
const cache = new Map<string, BrandIcon | null>();

/*
 * Slug → hex for the whole set, built once on the first lookup that needs a colour.
 *
 * The path comes from the per-brand SVG file, but those files carry no colour — the hex lives only
 * in the set's metadata, which is one 450KB document. Parsing it per request would be absurd, and
 * holding the parsed array would keep ~3400 objects alive to show a handful of brands, so the
 * array is reduced to a string map and dropped.
 */
let hexBySlug: Map<string, string> | undefined;

function brandHex(slug: string): string | undefined {
  if (!hexBySlug) {
    const { titleToSlug } = require("simple-icons/sdk") as { titleToSlug: (t: string) => string };
    const icons = require("simple-icons/icons.json") as {
      title: string;
      slug?: string;
      hex: string;
    }[];
    // `slug` is only present when it differs from the title-derived one, which is also how the
    // files are named — so deriving it the set's own way keeps both lookups on a single key.
    hexBySlug = new Map(icons.map((icon) => [icon.slug ?? titleToSlug(icon.title), icon.hex]));
  }
  return hexBySlug.get(slug);
}

/**
 * The brand's mark, or `null` when the slug names no known brand.
 *
 * A miss is not an error: bundled manifests are reviewed, and the set omits brands that asked to
 * be removed, so "no mark for this name" is an ordinary outcome the caller renders a monogram for.
 */
export async function brandIcon(slug: string | undefined): Promise<BrandIcon | null> {
  if (!slug || !SLUG_RE.test(slug)) return null;

  const cached = cache.get(slug);
  if (cached !== undefined) return cached;

  let icon: BrandIcon | null = null;
  try {
    // `simple-icons` exports `./icons/*`, so this resolves inside the package — it never touches
    // the filesystem by hand. The slug is validated above, so it cannot climb out of the package.
    const file = require.resolve(`simple-icons/icons/${slug}.svg`);
    const path = PATH_RE.exec(await readFile(file, "utf8"))?.[1];
    const hex = path ? brandHex(slug) : undefined;
    // Both or neither: a path with no colour is a mark the theme has to guess at, which is the
    // state this module exists to remove.
    icon = path && hex ? { path, hex } : null;
  } catch {
    icon = null;
  }

  cache.set(slug, icon);
  return icon;
}

/** Test seam: the cache is process-lifetime and would otherwise leak between cases. */
export function clearBrandIconCache(): void {
  cache.clear();
  hexBySlug = undefined;
}
