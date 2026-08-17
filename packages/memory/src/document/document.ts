import { createHash } from "node:crypto";
import {
  emptyMemorySections,
  MEMORY_SECTION_HEADINGS,
  MEMORY_SECTION_KEYS,
  type MemorySectionKey,
  type MemorySections,
} from "@tulipfarm/schema";
import {
  MEMORY_DOCUMENT_CHAR_BUDGET,
  MEMORY_RECENT_DECISIONS_LIMIT,
  MEMORY_SECTION_CHAR_BUDGET,
} from "./sections";

/**
 * A Tool-issued change: entries to drop and entries to add, applied as one atomic edit.
 *
 * One fact per line is load-bearing rather than stylistic: removal matches whole entries, so a
 * fact spanning several lines could be half-deleted, leaving orphaned continuation text that reads
 * as a different — and false — statement.
 */
export interface MemoryDelta {
  readonly section: MemorySectionKey;
  readonly remove?: readonly string[];
  readonly add?: readonly string[];
}

export interface MemoryDeltaResult {
  readonly sections: MemorySections;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Asked to be removed but not present. The caller must not report these as forgotten. */
  readonly unmatched: readonly string[];
}

export type MemoryWriteRejection =
  | "reserved_heading"
  | "empty_delta"
  | "section_over_budget"
  | "document_over_budget"
  | "unknown_section";

export class MemoryWriteRejected extends Error {
  constructor(
    readonly reason: MemoryWriteRejection,
    message: string
  ) {
    super(message);
    this.name = "MemoryWriteRejected";
  }
}

/** Any Markdown heading. Only the renderer may emit structure, at any level. */
const HEADING_LINE = /^[ \t]{0,3}#/;

/**
 * The one canonicalization rule. Deduplication, removal matching, hashing and rendering all use
 * it, so two spellings of the same fact can never be simultaneously "already present" for an add
 * and "not found" for a remove.
 */
export function canonicalMemoryLine(line: string): string {
  return line.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Canonical entry list: one fact per line, blank lines dropped, order preserved. */
export function parseMemoryEntries(content: string): string[] {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(canonicalMemoryLine)
    .filter((line) => line.length > 0);
}

/**
 * Canonical section text. Rendering must be byte-identical for identical meaning or every write
 * invalidates the model provider's prompt cache for that user.
 */
export function renderMemoryEntries(entries: readonly string[]): string {
  return entries.join("\n");
}

/**
 * Grammar is enforced before the write, not at render time: escaping at render would still let a
 * writer store text that a later reader — or a different renderer — resolves as structure.
 */
export function assertWritableEntries(entries: readonly string[]): readonly string[] {
  for (const entry of entries) {
    if (HEADING_LINE.test(entry)) {
      throw new MemoryWriteRejected(
        "reserved_heading",
        "a memory entry may not be a Markdown heading; write one plain fact per line"
      );
    }
  }
  return entries;
}

/** `## Recent decisions` reads newest first and is capped from the top. */
function capSection(section: MemorySectionKey, entries: readonly string[]): readonly string[] {
  if (section !== "recent_decisions") return entries;
  return entries.slice(0, MEMORY_RECENT_DECISIONS_LIMIT);
}

function assertBudgets(sections: MemorySections, section: MemorySectionKey): MemorySections {
  if (sections[section].length > MEMORY_SECTION_CHAR_BUDGET) {
    throw new MemoryWriteRejected(
      "section_over_budget",
      `section would be ${sections[section].length} chars, over the ${MEMORY_SECTION_CHAR_BUDGET} budget`
    );
  }
  const total = MEMORY_SECTION_KEYS.reduce((sum, key) => sum + sections[key].length, 0);
  if (total > MEMORY_DOCUMENT_CHAR_BUDGET) {
    throw new MemoryWriteRejected(
      "document_over_budget",
      `document would be ${total} chars, over the ${MEMORY_DOCUMENT_CHAR_BUDGET} budget`
    );
  }
  return sections;
}

function assertKnownSection(section: MemorySectionKey): void {
  if (!MEMORY_SECTION_KEYS.includes(section)) {
    throw new MemoryWriteRejected("unknown_section", `unknown memory section '${section}'`);
  }
}

/**
 * Applies one delta to one section.
 *
 * Removals run before additions, so naming the same entry in both keeps it. That is the safe
 * reading of a reword whose two halves collide.
 *
 * A delta only ever touches entries the caller named, so it cannot destroy an entry written
 * concurrently by another writer. That is why it needs no stale check, and why it is the only
 * write a model is given.
 */
export function applyMemoryDelta(sections: MemorySections, delta: MemoryDelta): MemoryDeltaResult {
  assertKnownSection(delta.section);
  const add = assertWritableEntries(parseMemoryEntries((delta.add ?? []).join("\n")));
  const remove = parseMemoryEntries((delta.remove ?? []).join("\n"));
  if (add.length === 0 && remove.length === 0) {
    throw new MemoryWriteRejected(
      "empty_delta",
      "a memory delta must add or remove at least one fact"
    );
  }

  const existing = parseMemoryEntries(sections[delta.section]);
  const removing = new Set(remove);
  const kept = existing.filter((entry) => !removing.has(entry));
  const removed = existing.filter((entry) => removing.has(entry));
  const unmatched = remove.filter((entry) => !existing.includes(entry));

  const present = new Set(kept);
  const added = add.filter((entry) => {
    if (present.has(entry)) return false;
    present.add(entry);
    return true;
  });

  // Newest first in `## Recent decisions`; appended in reading order everywhere else.
  const merged = delta.section === "recent_decisions" ? [...added, ...kept] : [...kept, ...added];
  const next = {
    ...sections,
    [delta.section]: renderMemoryEntries(capSection(delta.section, merged)),
  };
  return { sections: assertBudgets(next, delta.section), added, removed, unmatched };
}

/**
 * Overwrites a whole section. Destructive by construction, so it is not exposed to a model: the
 * Curator applies it under a hash check, and backfill and erasure regenerate from a known state.
 */
export function replaceMemorySection(
  sections: MemorySections,
  section: MemorySectionKey,
  content: string
): MemorySections {
  assertKnownSection(section);
  const entries = assertWritableEntries(parseMemoryEntries(content));
  const next = { ...sections, [section]: renderMemoryEntries(capSection(section, entries)) };
  return assertBudgets(next, section);
}

/** Canonical Markdown. Empty sections are omitted so an unused heading costs no context. */
export function renderMemoryDocument(sections: MemorySections): string {
  return MEMORY_SECTION_KEYS.filter((key) => sections[key].length > 0)
    .map((key) => `## ${MEMORY_SECTION_HEADINGS[key]}\n\n${sections[key]}`)
    .join("\n\n");
}

const HEADING_TO_SECTION = new Map<string, MemorySectionKey>(
  MEMORY_SECTION_KEYS.map((key) => [MEMORY_SECTION_HEADINGS[key], key])
);

/**
 * The exact inverse of {@link renderMemoryDocument}, and the reason the document can be stored as
 * plain Markdown rather than a structured column.
 *
 * It is lossless only because {@link assertWritableEntries} refuses any entry that is a heading:
 * every `## ` line in a stored document was written by the renderer, so splitting on them cannot
 * mistake a fact for structure. Text under an unrecognised heading is dropped rather than guessed
 * at — the section vocabulary is closed, and silently keeping foreign structure would let one
 * bad write teach the next reader a heading the product does not have.
 */
export function parseMemoryDocument(document: string): MemorySections {
  const lines = Object.fromEntries(
    MEMORY_SECTION_KEYS.map((key) => [key, [] as string[]])
  ) as Record<MemorySectionKey, string[]>;
  let current: MemorySectionKey | undefined;

  for (const raw of document.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(raw);
    if (heading) {
      current = HEADING_TO_SECTION.get(heading[1]);
      continue;
    }
    if (current === undefined) continue;
    const line = canonicalMemoryLine(raw);
    if (line.length > 0) lines[current].push(line);
  }

  const sections = emptyMemorySections();
  for (const key of MEMORY_SECTION_KEYS) sections[key] = renderMemoryEntries(lines[key]);
  return sections;
}

export function hashMemorySection(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashMemoryDocument(sections: MemorySections): string {
  return createHash("sha256").update(renderMemoryDocument(sections), "utf8").digest("hex");
}
