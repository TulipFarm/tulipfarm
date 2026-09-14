import { describe, expect, it } from "vitest";
import { evaluateTaskChecks, type TaskCheckSignals } from "./task-checks";

const ALL_RESOURCES = ["ticket", "lead", "employee", "invoice", "inventory", "project"];

const SATISFIED: TaskCheckSignals = {
  hasProviderKey: true,
  businessName: "Acme",
  setupComplete: true,
  resources: ALL_RESOURCES,
};

const UNSATISFIED: TaskCheckSignals = {
  hasProviderKey: false,
  businessName: undefined,
  setupComplete: true,
  resources: [],
};

function byKey(signals: TaskCheckSignals, dedupeKey: string) {
  const check = evaluateTaskChecks(signals).find((c) => c.dedupeKey === dedupeKey);
  if (!check) throw new Error(`no check for ${dedupeKey}`);
  return check;
}

describe("evaluateTaskChecks", () => {
  it("produces the two setup-gap checks plus one per resource-setup catalog entry", () => {
    const keys = evaluateTaskChecks(SATISFIED)
      .map((c) => c.dedupeKey)
      .sort();
    expect(keys).toEqual(
      [
        "business-name",
        "provider-key",
        "onboarding:tickets",
        "onboarding:leads",
        "onboarding:employees",
        "onboarding:invoices",
        "onboarding:inventory",
        "onboarding:projects",
      ].sort()
    );
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

  it("omits the ticket setup task once the ticket resource exists", () => {
    const check = byKey({ ...UNSATISFIED, resources: ["ticket"] }, "onboarding:tickets");
    expect(check.satisfied).toBe(true);
  });

  it("omits the employee setup task once the employee resource exists", () => {
    const check = byKey({ ...UNSATISFIED, resources: ["employee"] }, "onboarding:employees");
    expect(check.satisfied).toBe(true);
  });

  it("omits the project setup task once the project resource exists", () => {
    const check = byKey({ ...UNSATISFIED, resources: ["project"] }, "onboarding:projects");
    expect(check.satisfied).toBe(true);
  });

  it("keeps the ticket setup task open when no resources exist yet", () => {
    const check = byKey(UNSATISFIED, "onboarding:tickets");
    expect(check.satisfied).toBe(false);
  });

  it("treats a missing resources signal the same as none, keeping the task open", () => {
    const { resources: _resources, ...rest } = UNSATISFIED;
    const check = byKey(rest, "onboarding:tickets");
    expect(check.satisfied).toBe(false);
  });
});
