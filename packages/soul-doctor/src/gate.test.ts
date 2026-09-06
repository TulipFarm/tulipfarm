import { describe, expect, it } from "vitest";
import { finding } from "./finding";
import { gateRepair, MAX_REPAIR_ATTEMPTS } from "./gate";

const BROKEN = finding({
  code: "routine_uncompilable",
  severity: "broken",
  subject: { kind: "routine", id: "quotes", digest: "h1" },
  at: "/spec/states/0/transition",
  detail: "does not compile",
});

function gate(overrides: Record<string, unknown> = {}) {
  const { repair, ...rest } = overrides;
  return gateRepair({
    finding: BROKEN,
    subjectPath: "routines/quotes/routine.yaml",
    attempts: 1,
    before: "states:\n  - name: Start\n",
    ...rest,
    repair: {
      fingerprint: BROKEN.fingerprint,
      paths: ["routines/quotes/routine.yaml"],
      content: "states:\n  - name: Start\n    transition: Next\n",
      lintsClean: true,
      ...((repair as object) ?? {}),
    },
  } as Parameters<typeof gateRepair>[0]);
}

describe("gateRepair", () => {
  it("publishes a lint-clean single-artifact repair of a proved defect", () => {
    expect(gate()).toEqual({ decision: "publish" });
  });

  it("refuses to publish a repair that does not lint clean", () => {
    expect(gate({ repair: { lintsClean: false } })).toMatchObject({ decision: "propose" });
  });

  it("refuses to publish a repair that reaches outside the artifact the finding names", () => {
    const verdict = gate({
      repair: { paths: ["routines/quotes/routine.yaml", "agents/triage/agent.yaml"] },
    });
    expect(verdict).toMatchObject({ decision: "propose" });
    expect(verdict).toHaveProperty("because", expect.stringContaining("agents/triage/agent.yaml"));
  });

  // A wrong field name costs a failed Run. A wrong identity ceiling costs something no simulator
  // proves safe and no republish takes back.
  it("refuses to publish a repair that newly introduces an authority or secret field", () => {
    const verdict = gate({
      repair: { content: "states:\n  - name: Start\n    credentialRef: slack\n" },
    });
    expect(verdict).toMatchObject({ decision: "propose" });
    expect(verdict).toHaveProperty("because", expect.stringContaining("credentialRef"));
  });

  it("still publishes when the sensitive field was already there before the repair", () => {
    expect(
      gate({
        before: "states:\n  - name: Start\n    credentialRef: slack\n",
        repair: { content: "states:\n  - name: Start\n    credentialRef: slack\n    ok: true\n" },
      })
    ).toEqual({ decision: "publish" });
  });

  it("stops auto-publishing once a defect has outlived its repair budget", () => {
    expect(gate({ attempts: MAX_REPAIR_ATTEMPTS + 1 })).toMatchObject({ decision: "propose" });
  });

  it("never auto-publishes against a defect that is only suspected", () => {
    expect(gate({ finding: { ...BROKEN, severity: "suspect" } })).toMatchObject({
      decision: "propose",
    });
  });
});
