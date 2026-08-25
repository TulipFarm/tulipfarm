import type { DistilledResult } from "@tulipfarm/agent-runtime";

/**
 * Holding the summariser's output to what it actually read.
 *
 * This module is the authority on the citation limits; `./prompt.ts` only tells the model about
 * them. A summariser that invents a quote produces a claim which *looks* checkable and is not,
 * which is worse than no citation at all — the reading Agent has no way to tell the two apart.
 */

/** How much of any one quote may be reproduced, so a summary cannot become a copy. */
export const MAX_QUOTE_CHARS = 200;
export const MAX_CITATIONS = 8;

interface RawDistillation {
  readonly summary?: unknown;
  readonly citations?: unknown;
  readonly caveat?: unknown;
}

/** Parse the model's reply as JSON, tolerating a code fence it was asked not to add. */
export function parsed(text: string): RawDistillation | undefined {
  // A model asked for bare JSON still fences it sometimes; the fence is not a failure.
  const fenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const value: unknown = JSON.parse(fenced);
    return typeof value === "object" && value !== null ? (value as RawDistillation) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A citation's link, kept only when the content itself carried it.
 *
 * The summariser reads bytes a destination controls, and its output goes into the transcript. An
 * unchecked `url` is a free-text field the page can dictate through the summariser, so it is the
 * one part of a citation an attacker could write without having to survive quote grounding. It is
 * held to the same rule as the quote — present verbatim in what was read — and must additionally
 * be a real http(s) URL, so it cannot smuggle prose.
 */
function groundedUrl(url: unknown, content: string): string | undefined {
  if (typeof url !== "string" || url.length === 0 || !content.includes(url)) return undefined;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return undefined;
  return url;
}

/** Citations kept only when the quote is really in the content. */
export function groundedCitations(raw: unknown, content: string): DistilledResult["citations"] {
  if (!Array.isArray(raw)) return [];
  const kept: { quote: string; url?: string }[] = [];
  for (const entry of raw) {
    if (kept.length >= MAX_CITATIONS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { quote, url } = entry as { quote?: unknown; url?: unknown };
    if (typeof quote !== "string") continue;
    const trimmed = quote.trim().slice(0, MAX_QUOTE_CHARS);
    if (trimmed.length === 0 || !content.includes(trimmed)) continue;
    const link = groundedUrl(url, content);
    kept.push(link === undefined ? { quote: trimmed } : { quote: trimmed, url: link });
  }
  return kept;
}
