/**
 * Turning a model's answer, or its absence, into something safe to render.
 *
 * Both functions are pure and total. A chat always gets a label, so neither may throw and neither
 * may return an empty string — the sidebar has nothing else to show.
 */

const MAX_TITLE_LEN = 80;
const MAX_FALLBACK_LEN = 60;

/** Collapse a raw model title into a single clean line, stripped of quotes/markdown and bounded. */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:!?]+$/, "")
    .trim()
    .slice(0, MAX_TITLE_LEN)
    .trim();
}

/** Deterministic title when the model is unavailable: the first line of the prompt, bounded. */
export function fallbackTitle(firstPrompt: string): string {
  const firstLine = firstPrompt.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim().slice(0, MAX_FALLBACK_LEN).trim() || "New chat";
}
