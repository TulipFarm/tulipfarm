import { describe, expect, it } from "vitest";
import {
  assertProductionSandbox,
  type SandboxIsolationAttestation,
  WeakSandboxIsolationError,
} from "./sandbox";

function attest(
  partial: Partial<SandboxIsolationAttestation> & Pick<SandboxIsolationAttestation, "isolation">
): SandboxIsolationAttestation {
  return {
    provider: "test",
    strongIsolation: false,
    developmentOnly: false,
    ...partial,
  };
}

describe("assertProductionSandbox", () => {
  it("accepts strongly isolated microVM and remote-managed backends", () => {
    expect(() =>
      assertProductionSandbox(attest({ isolation: "microvm", strongIsolation: true }))
    ).not.toThrow();
    expect(() =>
      assertProductionSandbox(attest({ isolation: "remote-managed", strongIsolation: true }))
    ).not.toThrow();
  });

  it("rejects local and ssh dev backends outright (Hermes reject list)", () => {
    for (const isolation of ["local", "ssh"] as const) {
      expect(() => assertProductionSandbox(attest({ isolation, strongIsolation: true }))).toThrow(
        WeakSandboxIsolationError
      );
    }
  });

  it("rejects a container backend lacking strong-isolation attestation", () => {
    expect(() => assertProductionSandbox(attest({ isolation: "container" }))).toThrow(
      WeakSandboxIsolationError
    );
  });

  it("rejects any development-only backend regardless of claimed isolation", () => {
    expect(() =>
      assertProductionSandbox(
        attest({ isolation: "microvm", strongIsolation: true, developmentOnly: true })
      )
    ).toThrow(WeakSandboxIsolationError);
  });
});
