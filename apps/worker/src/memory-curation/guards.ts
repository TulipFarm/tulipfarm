import {
  MEMORY_DOCUMENT_CHAR_BUDGET,
  MEMORY_SECTION_CHAR_BUDGET,
  parseMemoryDocument,
  parseMemoryEntries,
  renderMemoryEntries,
} from "@tulipfarm/memory";
import {
  MEMORY_SECTION_HEADINGS,
  MEMORY_SECTION_KEYS,
  type MemorySectionKey,
  type MemorySections,
} from "@tulipfarm/schema";

/** What the person said in this window, joined, for the directive check below. */
export type CurationWindowText = readonly string[];

const DIRECTIVE =
  /\b(always|never|from now on|stop|don't|do not|please stop|going forward|in future|in the future|make sure|remember to|prefer|no longer)\b/i;

/**
 * Keeps a `## Standing instructions` line only if the person can be shown to have asked for it.
 *
 * Standing instructions outrank an Agent's own personality, so this section is the one place where
 * an invented line changes what every future Turn does. A line survives if it was already in the
 * document — it was earned in some earlier window and this is not the place to re-litigate it — or
 * if this window contains a directive phrase at all. That is deliberately coarse: it is not trying
 * to match a line to a sentence, only to stop a rule appearing out of a window where nobody gave
 * one, which is exactly what a pasted email or a quoted web page would otherwise produce.
 */
export function standingInstructionsGuard(
  proposed: MemorySections,
  prior: MemorySections,
  window: CurationWindowText
): { sections: MemorySections; dropped: number } {
  const existing = new Set(parseMemoryEntries(prior.standing_instructions));
  if (DIRECTIVE.test(window.join("\n"))) return { sections: proposed, dropped: 0 };

  const entries = parseMemoryEntries(proposed.standing_instructions);
  const kept = entries.filter((entry) => existing.has(entry));
  return {
    sections: { ...proposed, standing_instructions: renderMemoryEntries(kept) },
    dropped: entries.length - kept.length,
  };
}

/**
 * Parses the model's reply into sections, dropping anything a writer is not allowed to store.
 *
 * The drop is deterministic rather than a rejection because the alternative fails the whole hour
 * over one stray `###` line, and the same instruction produces the same stray line next hour —
 * a person whose memory stops being maintained until a human notices.
 */
export function parseCuratedDocument(document: string): MemorySections {
  const sections = parseMemoryDocument(document);
  for (const key of MEMORY_SECTION_KEYS) {
    const safe = parseMemoryEntries(sections[key]).filter((entry) => !entry.startsWith("#"));
    sections[key] = renderMemoryEntries(safe);
  }
  return sections;
}

/** Which limit a reply broke, in the words the retry prompt needs. */
export interface BudgetOverage {
  readonly produced: number;
  readonly limit: number;
  readonly where: string;
}

/**
 * The pure half of the budget guardrail: the same limits `assertMemoryBudgets` enforces, measured
 * before the write so the caller can retry with the numbers instead of catching a rejection.
 *
 * The longest offending section is named rather than the first, because "condense the longest
 * section" is the instruction most likely to bring a reply back under the limit in one attempt.
 */
export function budgetOverage(sections: MemorySections): BudgetOverage | undefined {
  const worst = MEMORY_SECTION_KEYS.map((key) => ({ key, length: sections[key].length })).sort(
    (a, b) => b.length - a.length
  )[0];
  if (worst && worst.length > MEMORY_SECTION_CHAR_BUDGET) {
    return {
      produced: worst.length,
      limit: MEMORY_SECTION_CHAR_BUDGET,
      where: `## ${MEMORY_SECTION_HEADINGS[worst.key as MemorySectionKey]}`,
    };
  }
  const total = MEMORY_SECTION_KEYS.reduce((sum, key) => sum + sections[key].length, 0);
  if (total > MEMORY_DOCUMENT_CHAR_BUDGET) {
    return { produced: total, limit: MEMORY_DOCUMENT_CHAR_BUDGET, where: "The document" };
  }
  return undefined;
}

/** How much of the prior document came through untouched — the churn signal, as a percentage. */
export function carriedThroughPercent(prior: MemorySections, next: MemorySections): number {
  const before = MEMORY_SECTION_KEYS.flatMap((key) => parseMemoryEntries(prior[key]));
  if (before.length === 0) return 100;
  const after = new Set(MEMORY_SECTION_KEYS.flatMap((key) => parseMemoryEntries(next[key])));
  const kept = before.filter((entry) => after.has(entry)).length;
  return Math.round((kept / before.length) * 100);
}
