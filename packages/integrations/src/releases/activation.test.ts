import { describe, expect, it, vi } from "vitest";
import {
  acquireOimReleaseDispatchPermit,
  authorizeOimReleasePreparation,
  dispatchWithOimReleasePermit,
} from "./activation";
import { releasePackageFixture } from "./test-fixtures";
import type { AuthorizedOimRelease } from "./trust-service";

describe("OIM release activation", () => {
  it("denies before trust evaluation while exact-major teardown is pending", async () => {
    const authorizeInstalledRelease = vi.fn();

    await expect(
      authorizeOimReleasePreparation(
        {
          businessId: "business-1",
          integrationId: "weather",
          majorVersion: 1,
          package: releasePackageFixture(),
        },
        {
          uninstallStatus: async () => ({
            status: "pending",
            activationAllowed: false,
            retryRequired: true,
          }),
          trust: { authorizeInstalledRelease },
        }
      )
    ).rejects.toMatchObject({ code: "OIM_RELEASE_UNINSTALL_PENDING" });
    expect(authorizeInstalledRelease).not.toHaveBeenCalled();
  });

  it("does not hold a dispatch lease during preparation", async () => {
    const package_ = releasePackageFixture();
    const acquire = vi.fn();

    await authorizeOimReleasePreparation(
      {
        businessId: "business-1",
        integrationId: "weather",
        majorVersion: 1,
        package: package_,
      },
      {
        uninstallStatus: async () => ({
          status: "not_started",
          activationAllowed: true,
          retryRequired: false,
        }),
        trust: {
          authorizeInstalledRelease: async () => ({
            trustClass: "community",
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: "a".repeat(64),
            files: [],
            approvedCommunityDigest: "a".repeat(64),
          }),
        },
      }
    );

    expect(acquire).not.toHaveBeenCalled();
  });

  it("cannot acquire a final dispatch permit after uninstall fences during trust verification", async () => {
    const package_ = releasePackageFixture();
    let fenced = false;
    const dispatchLeases = {
      acquire: vi.fn(async () => {
        if (fenced) throw new Error("oim_uninstall_pending");
        return {
          leaseId: "lease-1",
          installationId: "installation-1",
          packageDigest: "a".repeat(64),
          expiresAt: "2026-09-13T10:01:00.000Z",
        };
      }),
    };

    await expect(
      acquireOimReleaseDispatchPermit(
        {
          businessId: "business-1",
          integrationId: "weather",
          majorVersion: 1,
          package: package_,
        },
        {
          uninstallStatus: async () => ({
            status: "not_started",
            activationAllowed: true,
            retryRequired: false,
          }),
          trust: {
            authorizeInstalledRelease: async () => {
              fenced = true;
              return {
                trustClass: "community",
                integrationId: "weather",
                version: "1.2.3",
                packageDigest: "a".repeat(64),
                files: [],
                approvedCommunityDigest: "a".repeat(64),
              };
            },
          },
          dispatchLeases,
        }
      )
    ).rejects.toThrow("oim_uninstall_pending");
    expect(dispatchLeases.acquire).toHaveBeenCalledOnce();
  });

  it("returns only a live provenance and revocation authorization", async () => {
    const package_ = releasePackageFixture();
    const authorization: AuthorizedOimRelease = {
      trustClass: "community",
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: "a".repeat(64),
      files: [],
      approvedCommunityDigest: "a".repeat(64),
    };
    const authorizeInstalledRelease = vi.fn(async () => authorization);

    await expect(
      authorizeOimReleasePreparation(
        {
          businessId: "business-1",
          integrationId: "weather",
          majorVersion: 1,
          package: package_,
        },
        {
          uninstallStatus: async () => ({
            status: "not_started",
            activationAllowed: true,
            retryRequired: false,
          }),
          trust: { authorizeInstalledRelease },
        }
      )
    ).resolves.toBe(authorization);
    expect(authorizeInstalledRelease).toHaveBeenCalledWith({
      businessId: "business-1",
      integrationId: "weather",
      majorVersion: 1,
      package: package_,
    });
  });

  it("marks an ambiguous dispatch outcome for reconciliation instead of treating it as drained", async () => {
    const markReconciliationRequired = vi.fn(async () => {});
    const complete = vi.fn(async () => {});

    await expect(
      dispatchWithOimReleasePermit(
        {
          businessId: "business-1",
          integrationId: "weather",
          majorVersion: 1,
          package: releasePackageFixture(),
        },
        {
          uninstallStatus: async () => ({
            status: "not_started",
            activationAllowed: true,
            retryRequired: false,
          }),
          trust: {
            authorizeInstalledRelease: async () => ({
              trustClass: "community",
              integrationId: "weather",
              version: "1.2.3",
              packageDigest: "a".repeat(64),
              files: [],
              approvedCommunityDigest: "a".repeat(64),
            }),
          },
          dispatchLeases: {
            acquire: async () => ({
              leaseId: "lease-1",
              installationId: "installation-1",
              packageDigest: "a".repeat(64),
              expiresAt: "2026-09-13T10:01:00.000Z",
            }),
            complete,
            markReconciliationRequired,
          },
        },
        async () => {
          throw new Error("connection_lost_after_dispatch");
        }
      )
    ).rejects.toThrow("connection_lost_after_dispatch");
    expect(complete).not.toHaveBeenCalled();
    expect(markReconciliationRequired).toHaveBeenCalledWith(
      "lease-1",
      "dispatch_outcome_ambiguous"
    );
  });

  it("completes the generation-bound lease only after dispatch succeeds", async () => {
    const complete = vi.fn(async () => {});
    const dispatch = vi.fn(async () => "sent");

    await expect(
      dispatchWithOimReleasePermit(
        {
          businessId: "business-1",
          integrationId: "weather",
          majorVersion: 1,
          package: releasePackageFixture(),
        },
        {
          uninstallStatus: async () => ({
            status: "not_started",
            activationAllowed: true,
            retryRequired: false,
          }),
          trust: {
            authorizeInstalledRelease: async () => ({
              trustClass: "community",
              integrationId: "weather",
              version: "1.2.3",
              packageDigest: "a".repeat(64),
              files: [],
              approvedCommunityDigest: "a".repeat(64),
            }),
          },
          dispatchLeases: {
            acquire: async () => ({
              leaseId: "lease-1",
              installationId: "installation-1",
              packageDigest: "a".repeat(64),
              expiresAt: "2026-09-13T10:01:00.000Z",
            }),
            complete,
          },
        },
        dispatch
      )
    ).resolves.toBe("sent");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          leaseId: "lease-1",
          installationId: "installation-1",
        }),
      })
    );
    expect(complete).toHaveBeenCalledWith("lease-1");
  });
});
