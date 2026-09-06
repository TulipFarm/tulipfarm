/**
 * The Soul Doctor's sweep, run against the Eval Soul after an L3 Turn settled.
 *
 * The Doctor is the one subsystem that repairs configuration nobody is watching, so the seam worth
 * measuring is the whole loop: a Routine that reached the published bundle broken, the static lint
 * that finds it, the gate that decides it may be repaired, and the real `SoulWriter` publishing the
 * fix. The repair's *proposal* is scripted, exactly as a Case scripts a model turn — what a Case
 * asserts here is that a lint-green proposal reaches the bundle and a refused one reaches a person,
 * never that a vendor wrote good YAML.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Finding,
  lintRoutineDocument,
  type ProposedRepair,
  type RepairSubject,
  type SweepLedger,
  sweepSoul,
} from "@tulipfarm/soul-doctor";
import { parse as parseYaml } from "yaml";
import type { EvalSoul } from "../eval-soul.ts";
import { SOUL_WRITE_TOOL, type SoulWriterTool } from "./soul-write.ts";

/** What the sweep did to one finding, as a Case reads it. */
export interface DoctorEvent {
  readonly kind: "finding" | "repaired" | "escalated";
  readonly subject: string;
}

/** The ledger is per-sweep here: one Trial is one sweep, so nothing outlives it. */
function memoryLedger(): SweepLedger {
  const attempts = new Map<string, number>();
  return {
    observe: async (finding) => {
      const seen = (attempts.get(finding.fingerprint) ?? 0) + 1;
      attempts.set(finding.fingerprint, seen);
      return { state: "open", attempts: seen - 1 };
    },
    claim: async () => true,
    settle: async () => {},
    resolveUnseen: async () => 0,
  };
}

export interface DoctorFixture {
  /** The bytes the repair proposes, and the one artifact slug it answers for. */
  readonly repair?: {
    readonly slug: string;
    readonly content: string;
    readonly summary: string;
  };
}

export async function runDoctor(input: {
  readonly soul: EvalSoul;
  readonly writes: SoulWriterTool;
  readonly fixture: DoctorFixture;
}): Promise<readonly DoctorEvent[]> {
  const soul = await input.soul.reload();
  const events: DoctorEvent[] = [];
  const scripted = input.fixture.repair;

  const repair = {
    async locate(finding: Finding): Promise<RepairSubject | null> {
      if (finding.subject.kind !== "routine") return null;
      if (!soul.loader.routines.has(finding.subject.id)) return null;
      const path = `routines/${finding.subject.id}/routine.yaml`;
      return {
        path,
        content: await readFile(join(soul.path, path), "utf8"),
        facts: [],
      };
    },
    async propose(finding: Finding, subject: RepairSubject): Promise<ProposedRepair | null> {
      // Scoped to one slug: a sweep sees every defect in the bundle, and answering a finding about
      // some other artifact with these bytes would publish them over it.
      if (scripted === undefined || finding.subject.id !== scripted.slug) return null;
      let lintsClean: boolean;
      try {
        lintsClean =
          lintRoutineDocument({
            slug: finding.subject.id,
            digest: "proposed",
            document: parseYaml(scripted.content),
          }).length === 0;
      } catch {
        lintsClean = false;
      }
      return {
        fingerprint: finding.fingerprint,
        paths: [subject.path],
        content: scripted.content,
        lintsClean,
        summary: scripted.summary,
      };
    },
    async publish(finding: Finding, proposal: ProposedRepair): Promise<void> {
      const result = await input.writes.port.dispatch({
        businessId: "eval",
        runId: "eval-doctor",
        stateId: "eval-doctor",
        callId: randomUUID(),
        name: SOUL_WRITE_TOOL,
        arguments: {
          kind: "Routine",
          slug: finding.subject.id,
          content: proposal.content,
          definitionMode: "canonical",
          subject: `fix(soul): repair ${finding.subject.id}`,
        },
      });
      if (result.status !== "succeeded") {
        throw new Error(`the repair did not publish: ${JSON.stringify(result)}`);
      }
    },
  };

  await sweepSoul({
    now: () => new Date(),
    bundle: async () => ({
      // The Doctor's staleness check compares the repo HEAD with the commit the active bundle
      // pins. Here they are the same by construction: the Case is about the Routine, and a stale
      // bundle finding would bury it.
      activeCommitSha: "eval",
      headSha: "eval",
      routines: [...soul.loader.routines].map(([slug, routine]) => ({
        slug,
        hash: "eval",
        document: routine.config,
      })),
    }),
    unhealthyRuns: async () => [],
    ledger: memoryLedger(),
    repair,
    // The sweep reports every escalation through `report`, so this port only has to be present.
    escalate: async () => {},
    report: async (event) => {
      if (event.kind === "finding") return;
      events.push({ kind: event.kind, subject: event.finding.subject.id });
    },
  });

  return events;
}
