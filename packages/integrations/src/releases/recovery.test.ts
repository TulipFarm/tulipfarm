import { describe, expect, it, vi } from "vitest";
import { recoverQuarantinedOimRelease } from "./recovery";

const REQUEST = {
  businessId: "business-1",
  integrationId: "weather",
  majorVersion: 1,
  source: "https://example.test/weather.git",
  sourceRef: "commit-a1b2c3",
  candidatePath: "packages/weather",
  slug: "weather-v1",
} as const;

const IDENTITY = {
  integrationId: "weather",
  version: "1.2.3",
  majorVersion: 1,
  packageDigest: "a".repeat(64),
} as const;

describe("recoverQuarantinedOimRelease", () => {
  it("recovers only after immutable source and current Soul location verify the legacy identity", async () => {
    const recover = vi.fn(async () => ({
      installationId: "11111111-1111-4111-8111-111111111111",
    }));

    await expect(
      recoverQuarantinedOimRelease(REQUEST, {
        provenance: {
          findQuarantined: async () => ({
            ...IDENTITY,
            businessId: REQUEST.businessId,
            source: REQUEST.source,
          }),
          recover,
        },
        inspectSource: async () => ({ ...IDENTITY, resolvedRef: REQUEST.sourceRef }),
        inspectSoulArtifact: async () => ({ ...IDENTITY, soulRevision: "soul-a1b2c3" }),
      })
    ).resolves.toEqual({ installationId: "11111111-1111-4111-8111-111111111111" });
    expect(recover).toHaveBeenCalledWith({
      ...REQUEST,
      version: IDENTITY.version,
      packageDigest: IDENTITY.packageDigest,
      soulRevision: "soul-a1b2c3",
    });
  });

  it("fails closed when the operator source or Soul artifact does not match", async () => {
    const recover = vi.fn();

    await expect(
      recoverQuarantinedOimRelease(REQUEST, {
        provenance: {
          findQuarantined: async () => ({
            ...IDENTITY,
            businessId: REQUEST.businessId,
            source: REQUEST.source,
          }),
          recover,
        },
        inspectSource: async () => ({
          ...IDENTITY,
          packageDigest: "b".repeat(64),
          resolvedRef: REQUEST.sourceRef,
        }),
        inspectSoulArtifact: async () => ({ ...IDENTITY, soulRevision: "soul-a1b2c3" }),
      })
    ).rejects.toThrow("oim_release_recovery_verification_failed");
    expect(recover).not.toHaveBeenCalled();
  });
});
