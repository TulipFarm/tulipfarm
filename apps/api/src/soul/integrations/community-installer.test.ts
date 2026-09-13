import type { InstallReviewedCommunityOimReleaseDeps } from "@tulipfarm/integrations";
import { oimFileDigest, oimPackageDigest, parseOimManifest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { createReviewedCommunityIntegrationInstaller } from "./community-installer";

const SETUP_GUIDE = "# Connect Acme\n";
const FIXTURES = `version: 1
cases:
  - name: gets-status
    operationId: status
    request: {}
    response:
      status: 200
      body: { status: operational }
    expect:
      request:
        method: GET
        url: https://status.acme.example/v1/status
      result: { status: operational }
`;
const MANIFEST = parseOimManifest(`oimVersion: "1.0"
kind: Integration
metadata:
  id: acme
  name: Acme
  version: 1.0.0
  description: Read Acme status.
  license: MIT
profiles:
  core: "1.0"
files:
  - path: setup-guide.md
    role: guide
    sha256: "${oimFileDigest(SETUP_GUIDE)}"
  - path: fixtures.yml
    role: fixture
    sha256: "${oimFileDigest(FIXTURES)}"
operations:
  - id: status
    name: acme_status
    description: Read Acme status.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://status.acme.example
      path: /v1/status
    response:
      maxBytes: 65536
      schema:
        type: object
        properties:
          status: { type: string }
      projection: [/status]
`);

describe("createReviewedCommunityIntegrationInstaller", () => {
  it("passes the exact review claim to the durable P09 installer", async () => {
    const installReviewedCommunityOimRelease = vi.fn(async () => ({
      installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      integrationId: "acme",
      version: "1.0.0",
      majorVersion: 1,
      packageDigest: oimPackageDigest(MANIFEST),
      trustClass: "community" as const,
      revision: "soul-b",
    }));
    const releaseDependencies = {} as unknown as InstallReviewedCommunityOimReleaseDeps;
    const installer = createReviewedCommunityIntegrationInstaller({
      installReviewedCommunityOimRelease,
      releaseDependencies,
    });
    const result = await installer.install({
      businessId: "business-1",
      slug: "acme",
      packageDigest: oimPackageDigest(MANIFEST),
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      replace: true,
    });

    expect(result).toEqual({
      success: true,
      data: {
        slug: "acme",
        installed: true,
        installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        integrationId: "acme",
        version: "1.0.0",
        majorVersion: 1,
        packageDigest: oimPackageDigest(MANIFEST),
        trustClass: "community",
        revision: "soul-b",
      },
    });
    expect(installReviewedCommunityOimRelease).toHaveBeenCalledWith(
      {
        businessId: "business-1",
        slug: "acme",
        approvedPackageDigest: oimPackageDigest(MANIFEST),
        principal: { kind: "user", id: "user-1" },
        runId: "run-1",
        replace: true,
      },
      releaseDependencies
    );
  });

  it("fails closed when the approved replacement generation changed", async () => {
    const installReviewedCommunityOimRelease = vi.fn(async () => {
      throw Object.assign(new Error("generation mismatch"), {
        name: "OimReleaseInstallError",
        code: "REPLACE_PRECONDITION_MISMATCH",
      });
    });
    const installer = createReviewedCommunityIntegrationInstaller({
      installReviewedCommunityOimRelease,
      releaseDependencies: {} as unknown as InstallReviewedCommunityOimReleaseDeps,
    });

    const result = await installer.install({
      businessId: "business-1",
      slug: "acme",
      packageDigest: oimPackageDigest(MANIFEST),
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      replace: true,
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: "validation_error",
        message: "The installed Integration changed. Review the package again.",
      },
    });
  });
});
