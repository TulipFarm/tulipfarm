import { readFile } from "node:fs/promises";

/* Resolve manifest icon slugs server-side; return official Simple Icons path and hex only. */

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

/* Build slug-to-hex once, then drop the 450KB metadata array. */
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

/** Returns null for reviewed-but-missing brand marks; callers render a monogram. */
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
