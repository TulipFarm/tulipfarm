import type { AuthorizedOimRelease } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { createOimReleaseDispatchHost, type OimReleaseDispatchHostDeps } from "./dispatch-host";

function integration(id: string): SoulIntegration {
  return {
    slug: `${id}-community`,
    sourceIntegration: id,
    oimManifest: {
      metadata: { id, version: "1.0.0" },
    } as unknown as OimManifest,
  };
}

function harness(options: { readonly activationAllowed?: boolean } = {}) {
  const complete = vi.fn(async () => {});
  const releaseNotDispatched = vi.fn(async () => {});
  const markReconciliationRequired = vi.fn(async () => {});
  const acquire = vi.fn(async () => ({
    leaseId: "lease-1",
    installationId: "11111111-1111-4111-8111-111111111111",
    packageDigest: "a".repeat(64),
    expiresAt: "2026-09-14T00:01:00.000Z",
  }));
  const authorizeInstalledRelease = vi.fn(
    async () =>
      ({
        integrationId: "community",
        version: "1.0.0",
        packageDigest: "a".repeat(64),
        files: [],
        trustClass: "community",
        approvedCommunityDigest: "a".repeat(64),
      }) satisfies AuthorizedOimRelease
  );
  const deps: OimReleaseDispatchHostDeps = {
    bundled: [{ manifest: integration("bundled").oimManifest as OimManifest }],
    activation: {
      uninstallStatus: async () => ({
        status: options.activationAllowed === false ? "pending" : "not_started",
        activationAllowed: options.activationAllowed !== false,
        retryRequired: false,
      }),
      trust: { authorizeInstalledRelease },
      dispatchLeases: {
        acquire,
        complete,
        releaseNotDispatched,
        markReconciliationRequired,
      },
    },
  };
  return {
    host: createOimReleaseDispatchHost(deps),
    acquire,
    authorizeInstalledRelease,
    complete,
    releaseNotDispatched,
    markReconciliationRequired,
  };
}

describe("createOimReleaseDispatchHost", () => {
  it("does not require an installed-release lease for bundled packages", async () => {
    const { host, acquire } = harness();
    const provider = vi.fn(async () => "ok");

    await expect(
      host.dispatch(
        { businessId: "business-1", integration: integration("bundled") },
        (dispatch) => dispatch(provider),
        async () => "settled"
      )
    ).resolves.toBe("ok");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("does not trust an installed package that only claims a bundled identity and major", async () => {
    const { host, acquire } = harness();
    const spoofed = integration("bundled");
    spoofed.oimManifest = {
      ...spoofed.oimManifest,
      metadata: { ...spoofed.oimManifest?.metadata, version: "1.0.1" },
    } as OimManifest;

    await host.dispatch(
      { businessId: "business-1", integration: spoofed },
      (dispatch) => dispatch(async () => "ok"),
      async () => "settled"
    );

    expect(acquire).toHaveBeenCalledOnce();
  });

  it("blocks provider I/O while uninstall fences activation", async () => {
    const { host, acquire } = harness({ activationAllowed: false });
    const provider = vi.fn(async () => "unreachable");

    await expect(
      host.dispatch(
        { businessId: "business-1", integration: integration("community") },
        (dispatch) => dispatch(provider),
        async () => "not_dispatched"
      )
    ).rejects.toMatchObject({ code: "OIM_RELEASE_UNINSTALL_PENDING" });
    expect(acquire).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("releases the lease when dispatch is refused before provider I/O", async () => {
    const { host, releaseNotDispatched, markReconciliationRequired } = harness();
    const refusal = Object.assign(new Error("denied"), { phase: "before_dispatch" });

    await expect(
      host.dispatch(
        { businessId: "business-1", integration: integration("community") },
        (dispatch) => dispatch(async () => Promise.reject(refusal)),
        async () => "not_dispatched"
      )
    ).rejects.toBe(refusal);
    expect(releaseNotDispatched).toHaveBeenCalledWith("lease-1");
    expect(markReconciliationRequired).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous provider outcome for reconciliation", async () => {
    const { host, complete, releaseNotDispatched, markReconciliationRequired } = harness();
    const ambiguous = Object.assign(new Error("connection lost"), { phase: "after_dispatch" });

    await expect(
      host.dispatch(
        { businessId: "business-1", integration: integration("community") },
        (dispatch) => dispatch(async () => Promise.reject(ambiguous)),
        async () => "ambiguous"
      )
    ).rejects.toBe(ambiguous);
    expect(markReconciliationRequired).toHaveBeenCalledWith(
      "lease-1",
      "dispatch_outcome_ambiguous"
    );
    expect(complete).not.toHaveBeenCalled();
    expect(releaseNotDispatched).not.toHaveBeenCalled();
  });
});
