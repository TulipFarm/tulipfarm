import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Verifies removed legacy-bypass paths stay absent while the inventory remains evidence. */

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
  risk: string;
}

const COLUMNS = ["id", "category", "legacyPath", "bypass", "invariant", "risk"] as const;

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

/** The five high-risk categories the acceptance criteria require to be explicit. */
const MANDATORY_HIGH_RISK = [
  "identity-substitution",
  "process-approval",
  "acl-seam",
  "mcp",
  "all-tools",
] as const;

describe("legacy bypass inventory", () => {
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
