import { describe, expect, it } from "vitest";
import type { RoutineState } from "./routine";
import type { ToolContractSpec } from "./tool";
import type { TriggerSpec } from "./trigger";

const routineStateExcessProperty: RoutineState = {
  type: "approval",
  name: "ApproveRequest",
  approverRoles: ["ops"],
  // @ts-expect-error TypeBox-derived RoutineState must reject properties absent from the schema.
  unexpected: true,
};

const triggerSpecExcessProperty: TriggerSpec = {
  type: "manual",
  routineRef: { name: "daily-review", version: "1" },
  eventType: "manual.requested",
  eventVersion: 1,
  backgroundIdentity: { principalKind: "system", principalId: "scheduler" },
  deduplication: { key: "manual-request" },
  // @ts-expect-error TypeBox-derived TriggerSpec must reject properties absent from the schema.
  unexpected: true,
};

const toolContractSpecExcessProperty: ToolContractSpec = {
  toolId: "mailer.send",
  toolVersion: "1",
  action: "send",
  inputSchema: {},
  outputSchema: {},
  riskClass: "low",
  mutating: false,
  dryRun: false,
  idempotency: { strategy: "none" },
  adapter: { kind: "native", ref: "mailer" },
  // @ts-expect-error TypeBox-derived ToolContractSpec must reject properties absent from the schema.
  unexpected: true,
};

describe("definition TypeBox derivation", () => {
  it("keeps compile-time assertions active", () => {
    expect([
      routineStateExcessProperty,
      triggerSpecExcessProperty,
      toolContractSpecExcessProperty,
    ]).toHaveLength(3);
  });
});
