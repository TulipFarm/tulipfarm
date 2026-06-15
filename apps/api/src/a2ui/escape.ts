/**
 * Shared HTML-escape + postback-attribute helpers for server-side A2UI rendering. Used by both the
 * legacy view render (chat/a2ui-render.ts) and the declarative spec compiler (a2ui/compiler.ts).
 *
 * Every agent-controlled string is escaped so a `"`/`<` in a label cannot break out of the attribute
 * or tag and smuggle a different `data-a2ui-send` payload. Output is constrained to the iframe
 * sanitizer allowlist (tf-* tags + data-/aria- attributes); see apps/web/app/lib/a2ui/sanitize.ts.
 */

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML-escape a value for safe interpolation into tag content or a quoted attribute value. Coerces
 * non-strings (and null/undefined → "") so a loose, agent-authored spec with a missing field never
 * crashes the compiler — a malformed branch degrades to empty, it does not throw.
 */
export function esc(value: string | number | boolean | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPE[c] as string);
}

/** Serialize a postback payload into an HTML-escaped `data-a2ui-send` attribute. */
export function sendAttr(payload: unknown): string {
  return `data-a2ui-send="${esc(JSON.stringify(payload))}"`;
}
