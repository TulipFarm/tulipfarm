import { describe, expect, it } from "vitest";
import type { BundleState } from "./diagnose";
import type { Finding } from "./finding";
import type { ProposedRepair } from "./gate";
import type { RepairSubject, SweepEvent, SweepPorts } from "./sweep";
import { sweepSoul } from "./sweep";

const BROKEN_BUNDLE: BundleState = {
  activeCommitSha: "aaa",
  headSha: "bbb",
  lastPublicationError: "routine `quotes` did not compile",
  routines: [],
};

const CLEAN_BUNDLE: BundleState = { activeCommitSha: "aaa", headSha: "aaa", routines: [] };

const SUBJECT: RepairSubject = {
  path: "soul/bundle",
  content: "states: []\n",
  facts: [],
};

interface Harness {
  ports: SweepPorts;
  events: SweepEvent[];
  escalations: { fingerprint: string; because: string }[];
  published: ProposedRepair[];
  settled: { fingerprint: string; state: string }[];
}

function harness(
  options: {
    state?: string;
    attempts?: number;
    claims?: boolean;
    propose?: (finding: Finding, subject: RepairSubject) => Promise<ProposedRepair | null>;
    noRepairPort?: boolean;
    bundle?: BundleState;
  } = {}
): Harness {
  const events: SweepEvent[] = [];
  const escalations: { fingerprint: string; because: string }[] = [];
  const published: ProposedRepair[] = [];
  const settled: { fingerprint: string; state: string }[] = [];
  const repair = {
    async locate() {
      return SUBJECT;
    },
    async propose(finding: Finding, subject: RepairSubject) {
      return options.propose
        ? await options.propose(finding, subject)
        : {
            fingerprint: finding.fingerprint,
            paths: [SUBJECT.path],
            content: "states: [ok]\n",
            lintsClean: true,
            summary: "named the field the State publishes",
          };
    },
    async publish(_finding: Finding, proposal: ProposedRepair) {
      published.push(proposal);
    },
  };
  const ports: SweepPorts = {
    now: () => new Date("2026-09-06T00:00:00.000Z"),
    async bundle() {
      return options.bundle ?? BROKEN_BUNDLE;
    },
    async unhealthyRuns() {
      return [];
    },
    ledger: {
      async observe() {
        return { state: options.state ?? "open", attempts: options.attempts ?? 0 };
      },
      async claim() {
        return options.claims ?? true;
      },
      async settle(fingerprint, state) {
        settled.push({ fingerprint, state });
      },
      async resolveUnseen() {
        return 3;
      },
    },
    ...(options.noRepairPort ? {} : { repair }),
    async escalate(finding, because) {
      escalations.push({ fingerprint: finding.fingerprint, because });
    },
    report(event) {
      events.push(event);
    },
  };
  return { ports, events, escalations, published, settled };
}

describe("sweepSoul", () => {
  it("publishes a repair the gate clears", async () => {
    const h = harness();
    const report = await sweepSoul(h.ports);
    expect(report).toEqual({ found: 1, repaired: 1, escalated: 0, resolved: 3 });
    expect(h.published).toHaveLength(1);
    expect(h.settled.at(-1)?.state).toBe("repaired");
    expect(h.events.map((event) => event.kind)).toEqual(["finding", "repaired"]);
  });

  it("escalates instead of publishing when the repair does not lint", async () => {
    const h = harness({
      propose: async (finding) => ({
        fingerprint: finding.fingerprint,
        paths: [SUBJECT.path],
        content: "broken\n",
        lintsClean: false,
      }),
    });
    const report = await sweepSoul(h.ports);
    expect(report.repaired).toBe(0);
    expect(report.escalated).toBe(1);
    expect(h.published).toHaveLength(0);
    expect(h.escalations[0]?.because).toContain("does not lint clean");
  });

  it("escalates every finding when the deployment has no repair path", async () => {
    const h = harness({ noRepairPort: true });
    const report = await sweepSoul(h.ports);
    expect(report.escalated).toBe(1);
    expect(h.escalations[0]?.because).toContain("no repair path");
  });

  // Two sweeps overlap whenever a soul-sync kick lands in the same minute as the cron tick. The
  // loser must spend no model call and publish nothing, or one defect gets two competing repairs.
  it("leaves a finding alone when another sweep already holds the claim", async () => {
    const h = harness({ claims: false });
    const report = await sweepSoul(h.ports);
    expect(report).toMatchObject({ found: 1, repaired: 0, escalated: 0 });
    expect(h.published).toHaveLength(0);
  });

  it("does not reopen a finding a person was already asked about", async () => {
    const h = harness({ state: "escalated" });
    const report = await sweepSoul(h.ports);
    expect(report).toMatchObject({ repaired: 0, escalated: 0 });
    expect(h.events).toHaveLength(0);
  });

  // An attempt is counted at claim time, so the ceiling has to be read from the incremented
  // count — otherwise a defect that never sticks is repaired forever.
  it("stops repairing a defect that has already been repaired twice", async () => {
    const h = harness({ attempts: 2 });
    const report = await sweepSoul(h.ports);
    expect(report.escalated).toBe(1);
    expect(h.escalations[0]?.because).toContain("already been repaired");
  });

  it("returns a repair attempt to open when the model call fails", async () => {
    const h = harness({
      propose: async () => {
        throw new Error("provider timed out");
      },
    });
    const report = await sweepSoul(h.ports);
    expect(report.escalated).toBe(1);
    expect(h.settled).toContainEqual({ fingerprint: expect.any(String), state: "open" });
    expect(h.escalations[0]?.because).toContain("provider timed out");
  });

  it("costs nothing but the queries when the instance is healthy", async () => {
    const h = harness({ bundle: CLEAN_BUNDLE });
    const report = await sweepSoul(h.ports);
    expect(report).toEqual({ found: 0, repaired: 0, escalated: 0, resolved: 3 });
    expect(h.events).toHaveLength(0);
  });
});
