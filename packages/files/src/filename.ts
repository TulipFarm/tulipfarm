/**
 * Turning a client-supplied filename into something safe to store and safe to echo.
 *
 * A filename arrives from a browser, so it is attacker-controlled in both directions: it must not
 * reach a storage key, and it must not reach a `Content-Disposition` header intact. The storage
 * key is content-addressed and never derived from this value at all — that is the structural half
 * of the defence — and this function is the half that keeps the displayed name honest.
 */

const MAX_FILENAME_LENGTH = 200;

/**
 * The name to store and show for an upload.
 *
 * Every path separator and every traversal segment is removed rather than escaped, because a
 * display name has no legitimate use for either. Control characters and quotes go too: both are
 * header-injection vectors in `Content-Disposition`.
 *
 * Returns `"file"` when nothing usable survives, so a caller never has to handle an empty name.
 */
export function normalizeFilename(raw: string): string {
  const lastSegment = raw.split(/[/\\]/).pop() ?? "";
  const stripped = lastSegment
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  const withoutTraversal = stripped.replace(/^\.+/, "");
  const bounded = withoutTraversal.slice(0, MAX_FILENAME_LENGTH).trim();
  return bounded.length > 0 ? bounded : "file";
}
