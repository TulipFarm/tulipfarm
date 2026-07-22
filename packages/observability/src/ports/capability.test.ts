import { describe, expect, it } from "vitest";
import {
  assertRequiredCapabilities,
  CAPABILITY_CLASSIFICATIONS,
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityProbe,
  type CapabilityReport,
  correctnessCriticalCapabilityIds,
  MissingCapabilityError,
  requiredCapabilityIds,
} from "./capability";

function probe(id: CapabilityId, available: boolean): CapabilityProbe {
  return { id, provider: "test", available };
}

function reportWith(available: Partial<Record<CapabilityId, boolean>>): CapabilityReport {
  const probes = Object.fromEntries(
    CAPABILITY_IDS.map((id) => [id, probe(id, available[id] ?? false)])
  ) as Record<CapabilityId, CapabilityProbe>;
  return { probes };
}

describe("capability catalog", () => {
  it("enumerates the ten SPEC §22 provider-neutral backends", () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(
      [
        "blob",
        "cache",
        "identity",
        "kms",
        "model",
        "postgres",
        "queue",
        "sandbox",
        "telemetry",
        "vector",
      ].sort()
    );
  });

  it("names PostgreSQL as the sole correctness-critical capability (invariant 16)", () => {
    expect(correctnessCriticalCapabilityIds()).toEqual(["postgres"]);
  });

  it("classifies accelerators and model as optional, foundations as required", () => {
    for (const id of ["cache", "vector", "queue", "telemetry", "model", "sandbox"] as const) {
      expect(CAPABILITY_CLASSIFICATIONS[id].requirement).toBe("optional");
    }
    for (const id of ["postgres", "blob", "kms", "identity"] as const) {
      expect(CAPABILITY_CLASSIFICATIONS[id].requirement).toBe("required");
    }
  });

  it("requiredCapabilityIds excludes every optional accelerator", () => {
    const required = new Set(requiredCapabilityIds());
    expect(required.has("postgres")).toBe(true);
    expect(required.has("cache")).toBe(false);
    expect(required.has("vector")).toBe(false);
    expect(required.has("queue")).toBe(false);
  });
});

describe("assertRequiredCapabilities", () => {
  it("passes when required backends are present even if cache/vector/queue are absent", () => {
    const report = reportWith({
      postgres: true,
      blob: true,
      kms: true,
      identity: true,
      cache: false,
      vector: false,
      queue: false,
      telemetry: false,
      model: false,
      sandbox: false,
    });
    expect(() => assertRequiredCapabilities(report)).not.toThrow();
  });

  it("throws MissingCapabilityError naming PostgreSQL when the correctness core is absent", () => {
    const report = reportWith({ blob: true, kms: true, identity: true });
    expect(() => assertRequiredCapabilities(report)).toThrow(MissingCapabilityError);
    expect(() => assertRequiredCapabilities(report)).toThrow(/postgres/);
  });
});
