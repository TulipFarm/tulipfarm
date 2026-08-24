import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/**
 * Fitness function over the Memory Document's own write budgets.
 *
 * This used to compare `packages/memory`'s write budget against the context assembler's
 * `MAX_MEMORY_CHARS`, because the assembler dropped an over-budget `<memory>` block whole and a
 * writer allowed to exceed it would silently lose the user's entire memory. That block is gone —
 * Memory is now read through the `get_memory` Tool, which returns the document as a Tool result
 * and truncates nothing — so there is no second ceiling left to compare against.
 *
 * What remains checkable is that the two write budgets are coherent with each other: a per-section
 * cap that cannot bind, or that alone decides the real ceiling, is a budget that does not do what
 * its name says.
 *
 * Constants are read from source rather than imported because `scripts/` is not a workspace and
 * resolves no workspace package at runtime. A rename therefore fails here loudly, by name.
 */
function constantFrom(file: string, name: string): number {
  const source = readFileSync(join(ROOT, file), "utf8");
  const match = new RegExp(`${name} = ([\\d_]+)`).exec(source);
  if (!match) throw new Error(`${name} is no longer declared in ${file} where this test reads it`);
  return Number(match[1].replaceAll("_", ""));
}

function headingsFrom(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const body = /MEMORY_SECTION_HEADINGS[^{]*\{([^}]*)\}/.exec(source)?.[1];
  if (!body) throw new Error(`MEMORY_SECTION_HEADINGS is no longer declared in ${file}`);
  return [...body.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const SECTIONS = "packages/memory/src/document/sections.ts";
const VOCABULARY = "packages/schema/src/memory-document.ts";

const documentBudget = constantFrom(SECTIONS, "MEMORY_DOCUMENT_CHAR_BUDGET");
const sectionBudget = constantFrom(SECTIONS, "MEMORY_SECTION_CHAR_BUDGET");
const headings = headingsFrom(VOCABULARY);

describe("the Memory Document's write budgets stay coherent", () => {
  it("found the constants it compares", () => {
    expect(headings.length).toBeGreaterThan(0);
    expect(documentBudget).toBeGreaterThan(0);
    expect(sectionBudget).toBeGreaterThan(0);
  });

  it("cannot be defeated by one oversized section", () => {
    expect(sectionBudget).toBeLessThanOrEqual(documentBudget);
  });

  /**
   * Section budgets are per-section, so filling every section to its own limit must still be able
   * to exceed the document budget — otherwise the document budget is unreachable decoration and
   * the real ceiling is six times the section budget.
   */
  it("keeps the document budget the binding constraint, not decoration", () => {
    expect(sectionBudget * headings.length).toBeGreaterThan(documentBudget);
  });
});
