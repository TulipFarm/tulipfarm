import { readFile } from "node:fs/promises";

/*
 * Resolves a manifest's `icon` slug to Simple Icons path data.
 *
 * Resolution happens here rather than in the browser because the icon set is 25MB for ~3400 marks
 * and a deployment needs a handful. Shipping it to the client would cost every operator the whole
 * set to render two rows; resolving it here costs the payload ~700 bytes per integration that
 * actually has a mark, and keeps working for an integration installed from a git repo at runtime,
 * which a build-time bundle could not.
 *
 * Only the path is read. Simple Icons also publishes each brand's official colour, but a mark is
 * rendered in `currentColor`: several official colours (GitHub's #181717, Notion's #000000) are
 * invisible on a dark surface, and a list where some marks are branded and others are not — Slack
 * and Microsoft Teams are absent from the set entirely — reads as broken rather than branded.
 */

/** Matches `ICON_SLUG_RE` in packages/soul/src/integration-trust.ts. */
const SLUG_RE = /^[a-z0-9_]{1,32}$/;

const PATH_RE = /<path\s+d="([^"]+)"/;

/** Resolved marks, and the misses, so an unknown slug is not re-resolved on every request. */
const cache = new Map<string, string | null>();

/**
 * The `d` attribute of the brand's 24×24 mark, or `null` when the slug names no known brand.
 *
 * A miss is not an error: bundled manifests are reviewed, and the set omits brands that asked to
 * be removed, so "no mark for this name" is an ordinary outcome the caller renders a monogram for.
 */
export async function brandIconPath(slug: string | undefined): Promise<string | null> {
  if (!slug || !SLUG_RE.test(slug)) return null;

  const cached = cache.get(slug);
  if (cached !== undefined) return cached;

  let path: string | null = null;
  try {
    // `simple-icons` exports `./icons/*`, so this resolves inside the package — it never touches
    // the filesystem by hand. The slug is validated above, so it cannot climb out of the package.
    const file = require.resolve(`simple-icons/icons/${slug}.svg`);
    path = PATH_RE.exec(await readFile(file, "utf8"))?.[1] ?? null;
  } catch {
    path = null;
  }

  cache.set(slug, path);
  return path;
}

/** Test seam: the cache is process-lifetime and would otherwise leak between cases. */
export function clearBrandIconCache(): void {
  cache.clear();
}
