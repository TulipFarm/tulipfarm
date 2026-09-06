import { randomUUID } from "node:crypto";
import type { BundleState } from "./diagnose";
import { diagnoseSoul } from "./diagnose";
import type { Finding } from "./finding";
import { type GateVerdict, gateRepair, type ProposedRepair } from "./gate";
import { runFindings, type UnhealthyRunRow } from "./run-findings";

/** The one artifact a repair is allowed to see, and the ground truth it may reason from. */
export interface RepairSubject {
  /** Soul-repo path of the artifact the finding names. The gate holds the diff to exactly this. */
  readonly path: string;
  readonly content: string;
  /** Facts the model may use instead of guessing — for a bad reference, the fields that exist. */
  readonly facts: readonly string[];
}

/**
 * Everything the Doctor needs a model, a Soul writer or a database for.
 *
 * Kept as ports so the sweep itself is a decision procedure with no I/O of its own: what it does
 * with a finding is testable without a model, a git repo or Postgres, which is the only way the
 * auto-publish path can be proved by tests rather than by watching staging.
 */
export interface SweepPorts {
  now(): Date;
  bundle(): Promise<BundleState>;
  unhealthyRuns(): Promise<readonly UnhealthyRunRow[]>;
  ledger: SweepLedger;
  /** Absent leaves detection intact and escalates everything — the deployment has no repair path. */
  repair?: RepairPort;
  /** Puts a finding in front of a person. Must be idempotent per fingerprint. */
  escalate(finding: Finding, because: string): Promise<void>;
  report(event: SweepEvent): Promise<void> | void;
}

export interface SweepLedger {
  observe(finding: Finding): Promise<{ readonly state: string; readonly attempts: number }>;
  claim(fingerprint: string, runId: string): Promise<boolean>;
  settle(
    fingerprint: string,
    state: "repairing" | "repaired" | "escalated" | "open"
  ): Promise<void>;
  resolveUnseen(sweptAt: Date): Promise<number>;
}

export interface RepairPort {
  /** Finds the single artifact this finding is about; `null` when it is not one file's fault. */
  locate(finding: Finding): Promise<RepairSubject | null>;
  /** Asks for a repaired artifact and proves it lints. `null` when the model declined. */
  propose(finding: Finding, subject: RepairSubject): Promise<ProposedRepair | null>;
  /** Writes the repaired artifact through the Soul write gateway and republishes. */
  publish(finding: Finding, repair: ProposedRepair): Promise<void>;
}

export type SweepEvent =
  | { readonly kind: "finding"; readonly finding: Finding }
  | { readonly kind: "repaired"; readonly finding: Finding; readonly summary: string }
  | { readonly kind: "escalated"; readonly finding: Finding; readonly because: string };

export interface SweepReport {
  readonly found: number;
  readonly repaired: number;
  readonly escalated: number;
  readonly resolved: number;
}

/** States a finding can be in that mean this sweep must leave it alone. */
const NOT_MINE = new Set(["repairing", "escalated", "repaired"]);

async function escalate(ports: SweepPorts, finding: Finding, because: string): Promise<void> {
  await ports.escalate(finding, because);
  await ports.ledger.settle(finding.fingerprint, "escalated");
  await ports.report({ kind: "escalated", finding, because });
}

/**
 * Decides and acts on one finding.
 *
 * Returns what happened so the caller can count it. Every exit either publishes a repair, hands
 * the finding to a person, or leaves it open for the next tick — a finding never simply stops
 * being anybody's, which is the failure the Doctor exists to fix.
 */
async function treat(
  ports: SweepPorts,
  finding: Finding
): Promise<"repaired" | "escalated" | null> {
  const entry = await ports.ledger.observe(finding);
  if (NOT_MINE.has(entry.state)) return null;
  await ports.report({ kind: "finding", finding });

  const repair = ports.repair;
  if (repair === undefined) {
    await escalate(ports, finding, "this deployment has no repair path configured");
    return "escalated";
  }

  const subject = await repair.locate(finding);
  if (subject === null) {
    await escalate(ports, finding, "the defect does not resolve to a single authored artifact");
    return "escalated";
  }

  // Claiming before the model call, not after: two sweeps can overlap — a cron tick and a
  // soul-sync kick land in the same minute — and the claim is the only thing that stops both from
  // spending a model call and publishing over each other.
  const runId = randomUUID();
  if (!(await ports.ledger.claim(finding.fingerprint, runId))) return null;

  let proposal: ProposedRepair | null;
  try {
    proposal = await repair.propose(finding, subject);
  } catch (error) {
    // Back to `open` rather than escalated: a provider timeout is not evidence about the defect,
    // and the attempt has already been counted, so a permanently failing repair still runs out.
    await ports.ledger.settle(finding.fingerprint, "open");
    throw error;
  }
  if (proposal === null) {
    await escalate(ports, finding, "the repair declined to change the artifact");
    return "escalated";
  }

  const verdict: GateVerdict = gateRepair({
    finding,
    repair: proposal,
    subjectPath: subject.path,
    attempts: entry.attempts + 1,
    before: subject.content,
  });
  if (verdict.decision === "propose") {
    await escalate(ports, finding, verdict.because);
    return "escalated";
  }

  await repair.publish(finding, proposal);
  await ports.ledger.settle(finding.fingerprint, "repaired");
  await ports.report({ kind: "repaired", finding, summary: proposal.summary ?? "repaired" });
  return "repaired";
}

/**
 * One pass of the Doctor.
 *
 * Detection is whole-bundle and needs no model, so a healthy instance costs one compile per
 * Routine and one query. A model is reached for only once a defect is proved, and only with the
 * one artifact that defect names.
 *
 * One finding's failure does not end the sweep: the findings are independent, and a provider
 * outage on the first must not hide the other nine from the operator.
 */
export async function sweepSoul(ports: SweepPorts): Promise<SweepReport> {
  const sweptAt = ports.now();
  const [bundle, runs] = await Promise.all([ports.bundle(), ports.unhealthyRuns()]);
  const findings = [...diagnoseSoul(bundle), ...runFindings(runs)];

  let repaired = 0;
  let escalated = 0;
  for (const finding of findings) {
    try {
      const outcome = await treat(ports, finding);
      if (outcome === "repaired") repaired += 1;
      if (outcome === "escalated") escalated += 1;
    } catch (error) {
      await ports.escalate(
        finding,
        `the repair attempt itself failed: ${error instanceof Error ? error.message : String(error)}`
      );
      escalated += 1;
    }
  }

  const resolved = await ports.ledger.resolveUnseen(sweptAt);
  return { found: findings.length, repaired, escalated, resolved };
}
