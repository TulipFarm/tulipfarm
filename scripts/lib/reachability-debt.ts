/**
 * The recorded-debt half of the reachability control.
 *
 * The checker has to run against a repository that already contains
 * unreachable exports, so it ships with an explicit list of the ones known at
 * the time it landed. That list can only shrink: a new unreachable export
 * fails, and an entry that has since been wired up or deleted also fails, so
 * the file cannot quietly drift out of step with the tree.
 *
 * One class is never accepted as debt — an export that *nothing* references,
 * not even a test. There is no argument for keeping code no line of the
 * repository mentions, so `unreferenced` findings fail whether or not they
 * appear here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExportFinding, MethodFinding, ReachabilityReport } from "./reachability.ts";

export const DEBT_FILE = "scripts/reachability-debt.json";

export interface DebtFile {
  /** `path#symbol` entries accepted as test-only for now. */
  testOnly: string[];
  /**
   * `path#symbol` → why this export is unreachable by static analysis and is
   * nonetheless correct: a dynamically dispatched entrypoint, a framework
   * contract the checker cannot see, or a deliberate public API. A bare list
   * would be a mute suppression; the reason is the point.
   */
  justified: Record<string, string>;
  /**
   * `path#Class.method` entries for public methods no production module names.
   * Held separately because the export graph cannot see them and because the
   * name-based check under-reports by design — a shared method name grants
   * liveness to both owners.
   */
  deadMethods: string[];
}

export function findingKey(finding: Pick<ExportFinding, "file" | "name">): string {
  return `${finding.file}#${finding.name}`;
}

export function methodKey(finding: MethodFinding): string {
  return `${finding.file}#${finding.className}.${finding.method}`;
}

export interface Debt {
  testOnly: Set<string>;
  justified: Map<string, string>;
  deadMethods: Set<string>;
}

export function loadDebt(repoRoot: string): Debt {
  try {
    const parsed = JSON.parse(readFileSync(path.join(repoRoot, DEBT_FILE), "utf8")) as DebtFile;
    return {
      testOnly: new Set(parsed.testOnly ?? []),
      justified: new Map(Object.entries(parsed.justified ?? {})),
      deadMethods: new Set(parsed.deadMethods ?? []),
    };
  } catch {
    return { testOnly: new Set(), justified: new Map(), deadMethods: new Set() };
  }
}

export interface Partitioned {
  /** Unreachable exports that are not recorded — the failure case. */
  introduced: ExportFinding[];
  /** Recorded entries the tree no longer produces — also a failure. */
  stale: string[];
  /** Findings nothing references at all and that carry no justification. */
  unreferenced: ExportFinding[];
  /** Justifications with no reason written down. */
  unexplained: string[];
  /** Recorded entries the tree still produces. */
  recorded: ExportFinding[];
  /** Public methods no production module names, and that are not recorded. */
  introducedMethods: MethodFinding[];
  /** Recorded methods the tree no longer produces. */
  staleMethods: string[];
}

export function partitionFindings(report: ReachabilityReport, debt: Debt): Partitioned {
  const introduced: ExportFinding[] = [];
  const recorded: ExportFinding[] = [];
  const unreferenced: ExportFinding[] = [];
  const seen = new Set<string>();

  for (const finding of report.findings) {
    const key = findingKey(finding);
    seen.add(key);
    if (debt.justified.has(key)) {
      recorded.push(finding);
      continue;
    }
    if (finding.reachability === "unreferenced") {
      unreferenced.push(finding);
      continue;
    }
    if (debt.testOnly.has(key)) recorded.push(finding);
    else introduced.push(finding);
  }

  const introducedMethods: MethodFinding[] = [];
  const seenMethods = new Set<string>();
  for (const finding of report.deadMethods) {
    const key = methodKey(finding);
    seenMethods.add(key);
    if (!debt.deadMethods.has(key)) introducedMethods.push(finding);
  }
  const staleMethods = [...debt.deadMethods].filter((key) => !seenMethods.has(key)).sort();

  const stale = [...debt.testOnly, ...debt.justified.keys()].filter((key) => !seen.has(key)).sort();
  const unexplained = [...debt.justified]
    .filter(([, reason]) => reason.trim().length < 10)
    .map(([key]) => key)
    .sort();
  return {
    introduced,
    stale,
    unreferenced,
    unexplained,
    recorded,
    introducedMethods,
    staleMethods,
  };
}

export function serialiseDebt(report: ReachabilityReport, existing: Debt): string {
  const current = new Set(report.findings.map(findingKey));
  const testOnly = report.findings
    .filter((finding) => finding.reachability === "test-only")
    .map(findingKey)
    .filter((key) => !existing.justified.has(key))
    .sort();
  const justified = Object.fromEntries(
    [...existing.justified]
      .filter(([key]) => current.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const deadMethods = report.deadMethods.map(methodKey).sort();
  return `${JSON.stringify({ testOnly, justified, deadMethods }, null, 2)}\n`;
}
