import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The file that marks the top of a checkout. Present only in the repository, never in an image. */
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

/**
 * The repository checkout this process is running from, or `null` when it is not running from one.
 *
 * Only the development fallbacks need this: an installed image serves its bundled Skills and
 * integration manifests from `/app`, and an operator can point elsewhere with an environment
 * variable. It matters only when neither applies.
 *
 * It walks up from the working directory rather than resolving against this file's own location,
 * because no single spelling of "this file's location" survives how this package is consumed.
 * `__dirname` is undefined once the package is bundled as ESM, which is what `apps/web` does to it
 * transitively through the Tool host; `import.meta` is a compile error under the CommonJS output
 * `apps/eval` builds. Both also hard-code how deep a file sits in the tree, which stops being true
 * the moment it moves.
 */
function repoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A directory that ships in the repository, resolved for a process running from a checkout.
 *
 * Falls back to the working directory so the caller gets a path that simply does not exist, which
 * every caller already handles as "nothing bundled here" — rather than throwing on a lookup that
 * is optional by construction.
 */
export function repoDir(name: string, start: string = process.cwd()): string {
  return join(repoRoot(start) ?? start, name);
}
