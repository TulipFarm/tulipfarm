import { describe, expect, it, vi } from "vitest";
import type { Span, TelemetryPort } from "./ports";
import {
  IncidentGrouper,
  KillSwitchDeniedError,
  MutationKillSwitchGuard,
  readinessFromCapabilities,
  traceBoundary,
} from "./resilience";

function telemetry(options: { throwOnStart?: boolean } = {}) {
  const spans: Array<{ name: string; attributes: Record<string, string | number | boolean> }> = [];
  const errors: string[] = [];
  const port: TelemetryPort = {
    startSpan(name, attributes = {}) {
      if (options.throwOnStart) throw new Error("exporter unavailable");
      spans.push({ name, attributes: { ...attributes } });
      const span: Span = {
        setAttributes: () => undefined,
        recordError: (code) => errors.push(code),
        end: () => undefined,
      };
      return span;
    },
    counter: () => undefined,
    log: () => undefined,
  };
  return { errors, port, spans };
}

describe("resilience observability", () => {
  it("correlates a boundary with identifiers while redacting protected attributes", async () => {
    const sink = telemetry();

    await expect(
      traceBoundary(
        sink.port,
        "effect",
        {
          businessId: "business-1",
          runId: "run-1",
          effectId: "effect-1",
          attributes: {
            destination: "github.com",
            authorization: "Bearer secret",
            prompt: "private instructions",
          },
        },
        async () => "ok"
      )
    ).resolves.toBe("ok");

    expect(sink.spans).toEqual([
      {
        name: "tulipfarm.effect",
        attributes: {
          "tulipfarm.business_id": "business-1",
          "tulipfarm.run_id": "run-1",
          "tulipfarm.effect_id": "effect-1",
          destination: "github.com",
          authorization: "[redacted]",
          prompt: "[redacted]",
        },
      },
    ]);
  });

  it("does not let telemetry failure alter operation correctness", async () => {
    await expect(
      traceBoundary(telemetry({ throwOnStart: true }).port, "run", {}, async () => 42)
    ).resolves.toBe(42);
  });

  it("groups repeated incidents without retaining protected payloads", () => {
    const grouper = new IncidentGrouper(() => new Date("2026-07-26T10:00:00.000Z"));
    const first = grouper.record({
      component: "integration-worker",
      code: "provider_timeout",
      scope: "github",
      severity: "warning",
      metadata: { token: "secret", provider: "github" },
    });
    const repeated = grouper.record({
      component: "integration-worker",
      code: "provider_timeout",
      scope: "github",
      severity: "critical",
      metadata: { body: "private", provider: "github" },
    });

    expect(repeated).toMatchObject({
      id: first.id,
      occurrences: 2,
      severity: "critical",
      metadata: { body: "[redacted]", provider: "github" },
    });
    expect(JSON.stringify(repeated)).not.toContain("secret");
    expect(JSON.stringify(repeated)).not.toContain("private");
  });

  it("reports required capability loss as not ready and optional loss as degraded", () => {
    expect(
      readinessFromCapabilities([
        { id: "postgres", available: true, required: true },
        { id: "telemetry", available: false, required: false },
      ])
    ).toEqual({
      status: "degraded",
      ready: true,
      unavailable: ["telemetry"],
    });
    expect(
      readinessFromCapabilities([
        { id: "postgres", available: false, required: true },
        { id: "telemetry", available: true, required: false },
      ])
    ).toEqual({
      status: "unavailable",
      ready: false,
      unavailable: ["postgres"],
    });
  });
});

describe("MutationKillSwitchGuard", () => {
  it("denies a scoped mutation before dispatch and records safe audit evidence", async () => {
    const audit = vi.fn(async () => undefined);
    const guard = new MutationKillSwitchGuard({
      listEnabled: async () => [
        {
          id: "switch-1",
          businessId: "business-1",
          scope: { kind: "destination", value: "github.com" },
          reasonCode: "incident_containment",
          enabledAt: "2026-07-26T09:00:00.000Z",
          enabledBy: "operator-1",
        },
      ],
      audit: { record: audit },
    });

    await expect(
      guard.assertAllowed({
        businessId: "business-1",
        mutation: true,
        runId: "run-1",
        stateId: "state-1",
        effectId: "effect-1",
        toolId: "github.issue.label",
        destination: "github.com",
        dataClasses: ["internal"],
      })
    ).rejects.toEqual(new KillSwitchDeniedError("switch-1", "destination", "incident_containment"));
    expect(audit).toHaveBeenCalledWith({
      action: "kill_switch.denied",
      businessId: "business-1",
      decision: "deny",
      effectId: "effect-1",
      reasonCode: "incident_containment",
      runId: "run-1",
      scopeKind: "destination",
      stateId: "state-1",
      switchId: "switch-1",
      toolId: "github.issue.label",
    });
  });

  it("fails closed when enabled-switch state cannot be read", async () => {
    const guard = new MutationKillSwitchGuard({
      listEnabled: async () => {
        throw new Error("database unavailable");
      },
      audit: { record: async () => undefined },
    });

    await expect(
      guard.assertAllowed({
        businessId: "business-1",
        mutation: true,
        toolId: "github.issue.label",
        dataClasses: [],
      })
    ).rejects.toMatchObject({
      name: "KillSwitchDeniedError",
      reasonCode: "kill_switch_state_unavailable",
    });
  });
});
