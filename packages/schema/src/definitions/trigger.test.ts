import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { TRIGGER_TYPES, type TriggerDefinition, validateTriggerDefinition } from "./trigger";

const apiVersion = "tulipfarm.ai/v1";
const kind = "Trigger";

function base(type: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    apiVersion,
    kind,
    metadata: { name: "nightly-triage" },
    spec: {
      type,
      routineRef: { name: "issue-triage", version: "1.0.0" },
      eventType: "schedule.cron",
      eventVersion: 1,
      backgroundIdentity: { principalKind: "service", principalId: "svc_triage" },
      deduplication: { key: "cron:nightly" },
      ...extra,
    },
  };
}

function cron(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return base("cron", {
    expression: "0 0 * * *",
    timezone: "America/New_York",
    ...extra,
  });
}

describe("Trigger schema", () => {
  it("accepts a cron trigger with a bounded schedule policy", () => {
    const result: TriggerDefinition = validateTriggerDefinition(cron()).document;
    expect(result.spec.type).toBe("cron");
    expect(TRIGGER_TYPES).toContain("cron");
  });

  it("accepts a webhook trigger only when signature verification is declared", () => {
    const ok = base("webhook", {
      verification: { method: "hmac_sha256", secretRef: "webhook.github.secret" },
    });
    expect(() => validateTriggerDefinition(ok)).not.toThrow();
  });

  it("rejects raw-provider masquerading: a webhook trigger without verification", () => {
    const missing = base("webhook", {});
    expect(() => validateTriggerDefinition(missing)).toThrow(SchemaValidationError);
  });

  it("rejects raw-provider masquerading: a webhook trigger with an empty secret reference", () => {
    const empty = base("webhook", { verification: { method: "hmac_sha256", secretRef: "" } });
    expect(() => validateTriggerDefinition(empty)).toThrow(SchemaValidationError);
  });

  it("requires a bounded catch-up cap when the missed-run policy catches up", () => {
    const unbounded = cron({
      schedule: { missedRunPolicy: "catch_up_bounded", overlapPolicy: "skip" },
    });
    expect(() => validateTriggerDefinition(unbounded)).toThrow(SchemaValidationError);

    const bounded = cron({
      schedule: { missedRunPolicy: "catch_up_bounded", catchUpCap: 5, overlapPolicy: "skip" },
    });
    expect(() => validateTriggerDefinition(bounded)).not.toThrow();
  });

  it("rejects an unknown missed-run policy", () => {
    const bad = cron({ schedule: { missedRunPolicy: "run_forever", overlapPolicy: "skip" } });
    expect(() => validateTriggerDefinition(bad)).toThrow(SchemaValidationError);
  });

  it("requires an explicit background identity so a Run never inherits an interactive user", () => {
    const doc = cron();
    delete (doc.spec as Record<string, unknown>).backgroundIdentity;
    expect(() => validateTriggerDefinition(doc)).toThrow(SchemaValidationError);
  });

  it("requires a deduplication key to make replay handling deterministic", () => {
    const doc = cron();
    delete (doc.spec as Record<string, unknown>).deduplication;
    expect(() => validateTriggerDefinition(doc)).toThrow(SchemaValidationError);
  });

  it("rejects an unknown trigger type and unknown spec properties", () => {
    expect(() => validateTriggerDefinition(base("carrier_pigeon", {}))).toThrow(
      SchemaValidationError
    );

    const extra = cron({ smuggled: true });
    expect(() => validateTriggerDefinition(extra)).toThrow(SchemaValidationError);
  });

  it("fails closed for the wrong kind discriminator", () => {
    const wrong = cron();
    wrong.kind = "Routine";
    expect(() => validateTriggerDefinition(wrong)).toThrow();
  });
});
