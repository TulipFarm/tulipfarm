/*
 * `navigator.clipboard` is a secure-context-only API — it is undefined when the app is served over
 * plain http from a LAN IP, so reading `.writeText` off it throws. Fall back to the legacy
 * `document.execCommand("copy")` path, which still works on insecure origins.
 *
 * Returns whether the text made it to the clipboard so callers can skip their "copied" state.
 */

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or a transient failure — fall through to the legacy path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
