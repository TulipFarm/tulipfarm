import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Machine verification of the legacy-bypass inventory (AW-006).
 *
 * The inventory at `docs/architecture/legacy-inventory.md` is the cutover contract that AW-096
 * consumes to prove no listed bypass remains. AW-096 has completed the cutover, so every listed
 * path must now be absent while each row remains as historical evidence with its replacement,
 * cutover test, and removal owner.
 */

/** Walk up from this file to the pnpm workspace root (worktree-safe). */
function repoRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found above test file");
    dir = parent;
  }
}

const ROOT = repoRoot();
const INVENTORY_PATH = join(ROOT, "docs/architecture/legacy-inventory.md");

interface Row {
  id: string;
  category: string;
  legacyPath: string;
  bypass: string;
  invariant: string;
  replacement: string;
  cutover: string;
  removal: string;
  risk: string;
}

const COLUMNS = [
  "id",
  "category",
  "legacyPath",
  "bypass",
  "invariant",
  "replacement",
  "cutover",
  "removal",
  "risk",
] as const;

/** Parse the canonical inventory table: every row whose first cell is an `LB-NN` id. */
function parseRows(md: string): Row[] {
  const rows: Row[] = [];
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("| LB-")) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    expect(cells.length, `row "${cells[0]}" must have ${COLUMNS.length} columns`).toBe(
      COLUMNS.length
    );
    const row = Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]])) as unknown as Row;
    rows.push(row);
  }
  return rows;
}

/** Extract every backtick-quoted token from a cell. */
function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Extract every AW-NNN task id referenced in a cell. */
function taskIds(cell: string): string[] {
  return [...cell.matchAll(/AW-\d{3}/g)].map((m) => m[0]);
}

/** The five high-risk categories the acceptance criteria require to be explicit. */
const MANDATORY_HIGH_RISK = [
  "identity-substitution",
  "process-approval",
  "acl-seam",
  "mcp",
  "all-tools",
] as const;

describe("legacy bypass inventory (AW-006)", () => {
  it("exists and is a readable document", () => {
    expect(existsSync(INVENTORY_PATH), `${INVENTORY_PATH} must exist`).toBe(true);
  });

  const md = existsSync(INVENTORY_PATH) ? readFileSync(INVENTORY_PATH, "utf8") : "";
  const rows = md ? parseRows(md) : [];

  it("lists at least the five mandatory high-risk paths plus broad coverage", () => {
    expect(rows.length).toBeGreaterThanOrEqual(MANDATORY_HIGH_RISK.length);
  });

  it("uses unique, well-formed LB-NN identifiers", () => {
    const ids = rows.map((r) => r.id);
    for (const id of ids) expect(id).toMatch(/^LB-\d{2}$/);
    expect(new Set(ids).size, "LB ids must be unique").toBe(ids.length);
  });

  it("proves every inventoried legacy path has been removed", () => {
    for (const r of rows) {
      const paths = backticked(r.legacyPath);
      expect(paths.length, `row ${r.id} must cite a backticked legacy path`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(resolve(ROOT, p)), `row ${r.id}: legacy path "${p}" must be gone`).toBe(
          false
        );
      }
    }
  });

  it("maps every row to a replacement task, a cutover test, and a removal owner", () => {
    for (const r of rows) {
      expect(taskIds(r.replacement).length, `row ${r.id}: replacement task`).toBeGreaterThan(0);
      expect(taskIds(r.cutover).length, `row ${r.id}: cutover test`).toBeGreaterThan(0);
      expect(taskIds(r.removal).length, `row ${r.id}: removal owner`).toBeGreaterThan(0);
    }
  });

  it("binds every row to a release-blocking invariant or ADR", () => {
    for (const r of rows) {
      expect(r.invariant, `row ${r.id}: invariant`).toMatch(/(I-\d{2}|ADR-\d{3})/);
    }
  });

  it("classifies risk as high, medium, or low", () => {
    for (const r of rows) expect(["high", "medium", "low"]).toContain(r.risk);
  });

  it("makes every mandatory high-risk bypass explicit and high risk", () => {
    for (const cat of MANDATORY_HIGH_RISK) {
      const match = rows.filter((r) => r.category === cat);
      expect(match.length, `category "${cat}" must be inventoried`).toBeGreaterThan(0);
      expect(
        match.some((r) => r.risk === "high"),
        `category "${cat}" must be marked high risk`
      ).toBe(true);
    }
  });
});
