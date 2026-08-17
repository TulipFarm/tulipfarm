import { describe, expect, it } from "vitest";
import { evaluateTaskChecks, type TaskCheckSignals } from "./task-checks";

const SATISFIED: TaskCheckSignals = {
  hasProviderKey: true,
  businessName: "Acme",
  setupComplete: true,
};

const UNSATISFIED: TaskCheckSignals = {
  hasProviderKey: false,
  businessName: undefined,
  setupComplete: true,
};

function byKey(signals: TaskCheckSignals, dedupeKey: string) {
  const check = evaluateTaskChecks(signals).find((c) => c.dedupeKey === dedupeKey);
  if (!check) throw new Error(`no check for ${dedupeKey}`);
  return check;
}

describe("evaluateTaskChecks", () => {
  it("produces exactly the two dedupe keys", () => {
    const keys = evaluateTaskChecks(SATISFIED)
      .map((c) => c.dedupeKey)
      .sort();
    expect(keys).toEqual(["business-name", "provider-key"]);
  });

  it("marks every check satisfied when every signal is satisfied", () => {
    for (const check of evaluateTaskChecks(SATISFIED)) {
      expect(check.satisfied, check.dedupeKey).toBe(true);
    }
  });

  it("marks every check unsatisfied when every signal is unsatisfied", () => {
    for (const check of evaluateTaskChecks(UNSATISFIED)) {
      expect(check.satisfied, check.dedupeKey).toBe(false);
    }
  });

  it("assigns the blocking, admin-role checks with their exact actions", () => {
    const providerKey = byKey(UNSATISFIED, "provider-key");
    expect(providerKey).toMatchObject({
      assigneeKind: "role",
      assigneeId: "admin",
      blocking: true,
      action: { kind: "link", href: "/business/models" },
    });

    const businessName = byKey(UNSATISFIED, "business-name");
    expect(businessName).toMatchObject({
      assigneeKind: "role",
      assigneeId: "admin",
      blocking: true,
      action: { kind: "answer", field: "businessName", sink: "business_profile" },
    });
  });

  it("asks nothing about the business name while the wizard is still asking for it", () => {
    const midSetup = byKey({ ...UNSATISFIED, setupComplete: false }, "business-name");
    expect(midSetup.satisfied).toBe(true);
  });

  it("still asks when setup ended without a name, as a headless bootstrap can", () => {
    const noName = byKey({ ...UNSATISFIED, setupComplete: true }, "business-name");
    expect(noName.satisfied).toBe(false);
  });

  it("treats a blank name as unanswered, since the wizard writes empty strings", () => {
    const blank = byKey({ ...SATISFIED, businessName: "   " }, "business-name");
    expect(blank.satisfied).toBe(false);
  });

  it("leaves the provider key gap open mid-setup, which the wizard does not cover", () => {
    const midSetup = byKey({ ...UNSATISFIED, setupComplete: false }, "provider-key");
    expect(midSetup.satisfied).toBe(false);
  });
});
