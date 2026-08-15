import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for SQL parameterization in the runtime's own repositories.
 *
 * The threat model's `sql_injection` control used to cite the Postgres Tool adapter's tests. That
 * adapter was retired, which left the category pointing at a file that no longer existed — a gate
 * that read as covered while proving nothing. The product no longer offers a SQL backend a Tool
 * can aim, so what is left to defend is `packages/storage`, where every request value must reach
 * PostgreSQL as a bound parameter rather than as text spliced into the statement.
 *
 * Interpolating a `const` bound only to string literals is allowed — a shared column list, or a
 * clause that is one of two fixed strings — because such a binding cannot carry request data.
 * Every other interpolation is a value, and a value in the statement text is the injection.
 *
 * User-supplied *identifiers* cannot be bound as parameters at all; those live in `apps/api`
 * behind `assertValidType`, and `apps/api/src/resources/schema.test.ts` is that control's test.
 */

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();

const SCANNED_ROOT = "packages/storage/src";
const SKIPPED = /\.d\.ts$|node_modules|__fixtures__|\/dist\//;

/** A template literal that opens with SQL, captured with its interpolations intact. */
const SQL_TEMPLATE = /`\s*(?:WITH|SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[\s\S]*?`/gi;

const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (SKIPPED.test(`${full}/`)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) found.push(full);
    }
  };
  const full = join(ROOT, SCANNED_ROOT);
  if (existsSync(full)) walk(full);
  return found;
}

/**
 * True when `name` is declared in this file as a `const` whose initializer is made only of string
 * literals, possibly chosen between by a ternary. Such a value is fixed at authoring time and so
 * cannot carry request data into the statement.
 */
export function isLiteralConstant(source: string, name: string): boolean {
  const declaration = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*([^;]*);`);
  const initializer = declaration.exec(source)?.[1];
  if (initializer === undefined) return false;
  if (initializer.includes("${")) return false;
  // Strip every string literal; a literal-only initializer leaves only ternary punctuation behind.
  const residue = initializer
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\s/g, "");
  return residue === "" || /^[A-Za-z_$][A-Za-z0-9_$.]*\?:$/.test(residue);
}

interface Splice {
  readonly file: string;
  readonly expression: string;
}

function valueSplices(): Splice[] {
  const found: Splice[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const statement of source.match(SQL_TEMPLATE) ?? []) {
      for (const interpolation of statement.matchAll(/\$\{([^{}]*)\}/g)) {
        const expression = interpolation[1].trim();
        if (BARE_IDENTIFIER.test(expression) && isLiteralConstant(source, expression)) continue;
        found.push({ file: relative(ROOT, file), expression });
      }
    }
  }
  return found;
}

describe("SQL parameterization", () => {
  it("finds the SQL it is meant to be guarding", () => {
    // A scanner whose regex stopped matching would report zero violations forever.
    const statements = sourceFiles().reduce(
      (total, file) => total + (readFileSync(file, "utf8").match(SQL_TEMPLATE) ?? []).length,
      0
    );
    expect(statements).toBeGreaterThan(50);
  });

  it("splices no runtime value into a repository SQL statement", () => {
    const splices = valueSplices();
    expect(
      splices,
      `these statements interpolate an expression instead of binding a parameter:\n${splices
        .map((splice) => `  ${splice.file}: \${${splice.expression}}`)
        .join("\n")}\nPass the value in the parameter array and reference it as $n.`
    ).toEqual([]);
  });

  it("tells a fixed clause apart from a runtime value, so the rule is not vacuous", () => {
    expect(isLiteralConstant('const COLS = "id, name";', "COLS")).toBe(true);
    expect(isLiteralConstant('const clause = on ? "AND x = 1" : "";', "clause")).toBe(true);
    expect(isLiteralConstant("const table = input.type;", "table")).toBe(false);
    expect(isLiteralConstant("const where = filters.join(' AND ');", "where")).toBe(false);
  });
});
