/**
 * `pnpm reachability:check` — answers "who calls this in production?" for
 * every exported value in the monorepo.
 *
 * Exits non-zero when any export is unreachable from a real application
 * entrypoint and is not recorded in `scripts/reachability-debt.json`.
 *
 * Flags:
 *   --json    machine-readable output
 *   --all     also list over-exported symbols (reported, never enforced)
 *   --update  rewrite the debt file from the current tree
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyseReachability } from "./lib/reachability.ts";
import { DEBT_FILE, loadDebt, partitionFindings, serialiseDebt } from "./lib/reachability-debt.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));

const report = analyseReachability(repoRoot);
const debt = loadDebt(repoRoot);
const { introduced, stale, unreferenced, unexplained, recorded, introducedMethods, staleMethods } =
  partitionFindings(report, debt);

if (argv.has("--update")) {
  writeFileSync(path.join(repoRoot, DEBT_FILE), serialiseDebt(report, debt));
  console.log(`Rewrote ${DEBT_FILE} with ${report.findings.length} findings.`);
  process.exit(0);
}

if (argv.has("--json")) {
  console.log(JSON.stringify({ ...report, introduced, stale, introducedMethods }, null, 2));
  process.exit(
    introduced.length + stale.length + unreferenced.length + introducedMethods.length > 0 ? 1 : 0
  );
}

console.log(
  `Scanned ${report.scannedFiles} modules from ${report.roots.length} production entrypoints.`
);
console.log(
  `  unreachable exports: ${report.findings.length} (${recorded.length} recorded as debt)`
);
console.log(`  modules never loaded in production: ${report.deadModules.length}`);
console.log(`  over-exported (reachable, but only from inside): ${report.overExported.length}`);
console.log(`  public methods no production module calls: ${report.deadMethods.length}`);

if (argv.has("--all")) {
  for (const entry of report.overExported)
    console.log(`  over-exported  ${entry.file}#${entry.name}`);
  for (const file of report.deadModules) console.log(`  dead module    ${file}`);
  for (const entry of report.deadMethods)
    console.log(`  dead method    ${entry.file}#${entry.className}.${entry.method}`);
}

let failed = false;

if (unreferenced.length > 0) {
  failed = true;
  console.error(
    `\n${unreferenced.length} export(s) nothing references at all — not production, not tests.` +
      `\nThis class is never accepted as debt. Delete them, or wire them up.`
  );
  for (const finding of unreferenced) console.error(`  ${finding.file}#${finding.name}`);
}

if (introduced.length > 0) {
  failed = true;
  console.error(
    `\n${introduced.length} export(s) newly unreachable from production.` +
      `\nWire them into a real code path, delete them, or justify them in ${DEBT_FILE}.`
  );
  for (const finding of introduced) {
    console.error(`  ${finding.reachability.padEnd(11)} ${finding.file}#${finding.name}`);
  }
}

if (stale.length > 0) {
  failed = true;
  console.error(
    `\n${stale.length} entr(y|ies) in ${DEBT_FILE} are no longer unreachable.` +
      `\nThe debt list only ratchets down — remove them.`
  );
  for (const entry of stale) console.error(`  ${entry}`);
}

if (introducedMethods.length > 0) {
  failed = true;
  console.error(
    `\n${introducedMethods.length} public method(s) no production module calls.` +
      `\nA class is one export however many operations it carries, so the export graph` +
      `\ncannot see these. Call them, delete them, or record them in ${DEBT_FILE}.`
  );
  for (const finding of introducedMethods) {
    console.error(`  ${finding.file}#${finding.className}.${finding.method}`);
  }
}

if (staleMethods.length > 0) {
  failed = true;
  console.error(
    `\n${staleMethods.length} method entr(y|ies) in ${DEBT_FILE} now have a caller.` +
      `\nThe debt list only ratchets down — remove them.`
  );
  for (const entry of staleMethods) console.error(`  ${entry}`);
}

if (unexplained.length > 0) {
  failed = true;
  console.error(
    `\n${unexplained.length} justification(s) in ${DEBT_FILE} state no reason.` +
      `\nA bare exemption is a mute suppression; write why the export is correct.`
  );
  for (const entry of unexplained) console.error(`  ${entry}`);
}

if (failed) process.exit(1);
console.log("\nEvery export and method is reachable from production, or recorded as debt. OK.");
