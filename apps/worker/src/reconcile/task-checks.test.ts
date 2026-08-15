import { describe, expect, it } from "vitest";
import { evaluateTaskChecks, type TaskCheckSignals } from "./task-checks";

const SATISFIED: TaskCheckSignals = {
  hasProviderKey: true,
  businessName: "Acme",
};

const UNSATISFIED: TaskCheckSignals = {
  hasProviderKey: false,
  businessName: undefined,
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
});
