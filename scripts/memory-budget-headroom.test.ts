import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/**
 * Fitness function: a Memory Document the writer accepts must always be small enough for the
 * context assembler to render.
 *
 * The two numbers that decide this live in packages that cannot import each other.
 * `packages/memory` rejects a write over `MEMORY_DOCUMENT_CHAR_BUDGET`; `packages/agent-runtime`
 * drops the `<memory>` block **whole** when it exceeds `MAX_MEMORY_CHARS`. Raise the first past
 * the second and every write still succeeds while the user's entire memory silently stops reaching
 * the model — no error, no truncation, no log line. The comment on the budgets names that danger;
 * nothing enforced it, which is what this test is for.
 *
 * The writer also measures a different thing than the assembler: it sums section *content*, while
 * the assembler measures the *rendered* page, headings included. So the comparison adds the render
 * overhead back, or the margin it proves is not the margin that exists.
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

const ASSEMBLE = "packages/agent-runtime/src/context/assemble.ts";
const SECTIONS = "packages/memory/src/document/sections.ts";
const VOCABULARY = "packages/schema/src/memory-document.ts";

const documentBudget = constantFrom(SECTIONS, "MEMORY_DOCUMENT_CHAR_BUDGET");
const sectionBudget = constantFrom(SECTIONS, "MEMORY_SECTION_CHAR_BUDGET");
const assemblerCeiling = constantFrom(ASSEMBLE, "MAX_MEMORY_CHARS");
const headings = headingsFrom(VOCABULARY);

/** Every heading, plus the blank line under each and the gap between sections. */
const renderOverhead =
  headings.reduce((total, heading) => total + `## ${heading}\n\n`.length, 0) +
  (headings.length - 1) * 2;

describe("the Memory Document always fits the context assembler", () => {
  it("found the constants it compares", () => {
    expect(headings.length).toBeGreaterThan(0);
    expect(documentBudget).toBeGreaterThan(0);
    expect(assemblerCeiling).toBeGreaterThan(0);
  });

  it("leaves the largest writable document below the block's drop-whole ceiling", () => {
    expect(documentBudget + renderOverhead).toBeLessThanOrEqual(assemblerCeiling);
  });

  it("cannot be defeated by one oversized section", () => {
    expect(sectionBudget).toBeLessThanOrEqual(documentBudget);
  });

  /**
   * Section budgets are per-section, so filling every section to its own limit must still be able
   * to exceed the document budget — otherwise the document budget is unreachable decoration and
   * the real ceiling is six times the section budget, which nothing compares to the assembler's.
   */
  it("keeps the document budget the binding constraint, not decoration", () => {
    expect(sectionBudget * headings.length).toBeGreaterThan(documentBudget);
  });
});
