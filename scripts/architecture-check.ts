#!/usr/bin/env node
/**
 * CI/static architecture check. Scans the monorepo's `@tulipfarm/*` import graph
 * and enforces `docs/architecture/dependency-rules.md`: forbidden imports and
 * import cycles both fail the build with actionable messages.
 *
 * Run: `pnpm architecture:check` (or `node scripts/architecture-check.ts`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHITECTURE_CONFIG,
  checkArchitecture,
  formatViolations,
} from "./lib/architecture-rules.ts";
import { scanImports } from "./lib/scan.ts";

export function runArchitectureCheck(root: string): number {
  const violations = checkArchitecture(scanImports(root), ARCHITECTURE_CONFIG);
  process.stdout.write(`${formatViolations(violations)}\n`);
  return violations.length === 0 ? 0 : 1;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runArchitectureCheck(repoRoot));
}
