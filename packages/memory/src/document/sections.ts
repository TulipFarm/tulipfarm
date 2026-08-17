/**
 * Memory Document policy that is not contract. The section vocabulary itself lives in
 * `@tulipfarm/schema`, because the Curator must speak it without importing this package; what
 * stays here is what only the renderer and the writers need — the budgets, and the one line the
 * runtime reads back mechanically.
 */

/**
 * The one entry the runtime reads back mechanically, so it has a fixed spelling: `Timezone: <IANA
 * zone>` on its own line. Recovering it by shape instead would let any `Region/City` written in
 * prose — a customer's location, a repository path — silently become the user's clock. It must
 * stay in step with `MEMORY_TIMEZONE_PREFIX`, which is now in another package; a test pins that.
 */
export const MEMORY_TIMEZONE_LINE = /^Timezone:[ \t]*(\S+)[ \t]*$/im;

export function timezoneFromMemoryDocument(document: string): string | undefined {
  return MEMORY_TIMEZONE_LINE.exec(document)?.[1];
}

/**
 * `<memory>` must stay well inside the assembler's 25,600-char ceiling, because an over-budget
 * block is dropped whole — a silent, total memory loss. These caps reject the write instead.
 */
export const MEMORY_DOCUMENT_CHAR_BUDGET = 20_000;
export const MEMORY_SECTION_CHAR_BUDGET = 6_000;

/** `## Recent decisions` keeps only the newest entries; older ones fall off on write. */
export const MEMORY_RECENT_DECISIONS_LIMIT = 15;
