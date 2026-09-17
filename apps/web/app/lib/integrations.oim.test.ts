import { afterEach, expect, test, vi } from "vitest";
import {
  addOimTrustRoot,
  createOimConnection,
  disableOimRevocationFeed,
  disableOimTrustRoot,
  getInstalledOimRelease,
  getOimConnectionSetup,
  getOimReleaseUninstallStatus,
  getOimRevocationFeed,
  inspectOimReleaseSource,
  installOimRelease,
  listOimConnections,
  listOimTrustRoots,
  refreshOimConnection,
  revokeOimConnection,
  runOimReleaseMaintenance,
  setOimAutoPatchPreference,
  setOimRevocationFeed,
  startOimConnectionAuthorization,
  uninstallOimRelease,
  updateOimConnectionCredentials,
} from "./integrations";

afterEach(() => vi.unstubAllGlobals());

test("PATCHes only replacement values on the exact encoded Connection credential route", async () => {
  const result = { connectionId: "connection/1", verification: { status: "verified" } };
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    updateOimConnectionCredentials("acme v2", "connection/1", {
      token: "replacement",
    })
  ).resolves.toEqual(result);
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:4010/api/v1/integrations/acme%20v2/connections/connection%2F1/credentials",
    expect.objectContaining({ method: "PATCH", body: '{"values":{"token":"replacement"}}' })
  );
});

test("uses the exact P04 Connection routes and request bodies", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => {
    return new Response(
      JSON.stringify({
        connections: [],
        connectionId: "connection-1",
        verification: { status: "action_required", error: "verification_unavailable" },
        steps: [],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  });

  vi.stubGlobal("fetch", fetchMock);

  await listOimConnections("acme v2");
  await getOimConnectionSetup("acme v2", "connection/1");
  const created = await createOimConnection("acme v2", {
    label: "Support",
    ownerScope: "personal",
    values: { api_key: "secret" },
  });
  await refreshOimConnection("acme v2", "connection/1");
  await startOimConnectionAuthorization("acme v2", "connection/1", "admin consent");
  await getInstalledOimRelease("acme/integration", 2);
  await getOimReleaseUninstallStatus({
    integrationId: "acme/integration",
    majorVersion: 2,
    installationId: "installation/1",
  });
  await uninstallOimRelease({
    integrationId: "acme/integration",
    majorVersion: 2,
    installationId: "installation/1",
  });
  await revokeOimConnection("acme v2", "connection/1");

  expect(created.verification).toEqual({
    status: "action_required",
    error: "verification_unavailable",
  });
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
    ["http://localhost:4010/api/v1/integrations/acme%20v2/connections", undefined, undefined],
    [
      "http://localhost:4010/api/v1/integrations/acme%20v2/connection-setup?connectionId=connection%2F1",
      undefined,
      undefined,
    ],
    [
      "http://localhost:4010/api/v1/integrations/acme%20v2/connections",
      "POST",
      '{"label":"Support","ownerScope":"personal","values":{"api_key":"secret"}}',
    ],
    [
      "http://localhost:4010/api/v1/integrations/acme%20v2/connections/connection%2F1/refresh",
      "POST",
      "{}",
    ],
    [
      "http://localhost:4010/api/v1/integrations/acme%20v2/connections/connection%2F1/auth/admin%20consent",
      "POST",
      "{}",
    ],
    [
      "http://localhost:4010/api/v1/integrations/oim/acme%2Fintegration/majors/2/auto-patch",
      undefined,
      undefined,
    ],
    [
      "http://localhost:4010/api/v1/integrations/oim/acme%2Fintegration/majors/2/installations/installation%2F1/uninstall",
      undefined,
      undefined,
    ],
    [
      "http://localhost:4010/api/v1/integrations/oim/acme%2Fintegration/majors/2/installations/installation%2F1",
      "DELETE",
      "{}",
    ],
    [
      "http://localhost:4010/api/v1/integrations/acme%20v2/connections/connection%2F1",
      "DELETE",
      undefined,
    ],
  ]);
});

test("binds OIM installation to the exact reviewed source, ref, and digest", async () => {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          source: "https://example.test/releases.git",
          ref: "commit-a1b2c3",
          candidates: [],
          integrationId: "weather",
          majorVersion: 1,
          installationId: "11111111-1111-4111-8111-111111111111",
          slug: "weather",
          trustClass: "community",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);

  await inspectOimReleaseSource("https://example.test/releases.git");
  await installOimRelease({
    source: "https://example.test/releases.git",
    sourceRef: "commit-a1b2c3",
    slug: "weather",
    selection: {
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: "a".repeat(64),
    },
    trustClass: "community",
    approvedCommunityDigest: "a".repeat(64),
    autoPatchOptIn: false,
  });

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
    [
      "http://localhost:4010/api/v1/integrations/oim/releases/inspect",
      "POST",
      '{"source":"https://example.test/releases.git"}',
    ],
    [
      "http://localhost:4010/api/v1/integrations/oim/releases/install",
      "POST",
      `{"source":"https://example.test/releases.git","sourceRef":"commit-a1b2c3","slug":"weather","selection":{"integrationId":"weather","version":"1.2.3","packageDigest":"${"a".repeat(64)}"},"trustClass":"community","approvedCommunityDigest":"${"a".repeat(64)}","autoPatchOptIn":false}`,
    ],
  ]);
});

test("uses the public trust, feed, maintenance, and exact-major auto-patch routes", async () => {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);

  await listOimTrustRoots(true);
  await addOimTrustRoot({
    purpose: "release",
    keyId: "release/2026",
    publicKeyPem: "PUBLIC KEY",
  });
  await disableOimTrustRoot("release", "release/2026");
  await getOimRevocationFeed();
  await setOimRevocationFeed("https://updates.example.test/oim.json");
  await disableOimRevocationFeed();
  await runOimReleaseMaintenance();
  await setOimAutoPatchPreference("weather/maps", 2, true);

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
    [
      "http://localhost:4010/api/v1/integrations/oim/release-trust/roots?includeDisabled=true",
      undefined,
      undefined,
    ],
    [
      "http://localhost:4010/api/v1/integrations/oim/release-trust/roots",
      "POST",
      '{"purpose":"release","keyId":"release/2026","publicKeyPem":"PUBLIC KEY"}',
    ],
    [
      "http://localhost:4010/api/v1/integrations/oim/release-trust/roots/release/release%2F2026",
      "DELETE",
      "{}",
    ],
    ["http://localhost:4010/api/v1/integrations/oim/release-trust/feed", undefined, undefined],
    [
      "http://localhost:4010/api/v1/integrations/oim/release-trust/feed",
      "PUT",
      '{"url":"https://updates.example.test/oim.json"}',
    ],
    ["http://localhost:4010/api/v1/integrations/oim/release-trust/feed", "DELETE", "{}"],
    ["http://localhost:4010/api/v1/integrations/oim/release-trust/maintenance", "POST", "{}"],
    [
      "http://localhost:4010/api/v1/integrations/oim/weather%2Fmaps/majors/2/auto-patch",
      "PATCH",
      '{"enabled":true}',
    ],
  ]);
});
