import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type DiscoveredIntegration, discoverIntegrations } from "./install";

const V1_PACKAGES = [
  "google-workspace",
  "telegram",
  "notion",
  "discord",
  "hubspot",
  "jira",
  "asana",
  "linear",
  "trello",
  "clickup",
  "twilio",
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "shopify",
  "reddit",
  "mailchimp",
  "zendesk",
] as const;

let packages: Map<string, DiscoveredIntegration>;

beforeAll(async () => {
  packages = new Map(
    (await discoverIntegrations(resolve(__dirname, "../../../../integrations"))).map((entry) => [
      entry.name,
      entry,
    ])
  );
});

describe.each(V1_PACKAGES)("V1 OIM package %s", (slug) => {
  it("is installable through normal discovery with passing offline fixtures", () => {
    const entry = packages.get(slug);
    expect(entry, `missing ${slug}`).toBeDefined();
    expect(entry?.oimManifest?.metadata.id).toBe(slug);
    expect(entry?.issues, `${slug} discovery issues`).toEqual([]);
    expect(entry?.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.fixtureResults?.length).toBeGreaterThanOrEqual(2);
    expect(entry?.fixtureResults?.filter((fixture) => !fixture.passed)).toEqual([]);
  });

  it("provides a useful read and write workflow, not only an identity probe", () => {
    const manifest = packages.get(slug)?.oimManifest;
    expect(manifest?.operations.length).toBeGreaterThanOrEqual(2);
    expect(
      manifest?.operations.some((operation) =>
        ["read", "sensitive_read"].includes(operation.effect)
      )
    ).toBe(true);
    expect(
      manifest?.operations.some(
        (operation) => !["read", "sensitive_read"].includes(operation.effect)
      )
    ).toBe(true);
  });
});

it("covers all six requested Google Workspace services", () => {
  const operations = packages.get("google-workspace")?.oimManifest?.operations ?? [];
  for (const service of ["docs", "sheets", "slides", "drive", "calendar", "gmail"]) {
    expect(
      operations.some((operation) => operation.id.startsWith(`${service}-`)),
      service
    ).toBe(true);
  }
});

it("requests reusable Google Workspace OAuth credentials", () => {
  const oauth = packages
    .get("google-workspace")
    ?.oimManifest?.auth?.steps.find((step) => step.type === "oauth2");
  if (oauth?.type !== "oauth2") throw new Error("missing Google Workspace OAuth step");

  expect(oauth.authorizationParameters).toMatchObject({
    access_type: "offline",
    prompt: "consent",
  });
  expect(
    oauth.bindings.some(
      (binding) =>
        binding.sourcePath === "/refresh_token" &&
        binding.target.type === "credential" &&
        binding.target.slot === "refresh_token"
    )
  ).toBe(true);
});

it("checks OpenWeather credentials without asking the model for a location", () => {
  const entry = packages.get("openweather");
  expect(entry?.issues).toEqual([]);
  expect(entry?.oimManifest?.auth?.healthCheckOperationId).toBe("check-connection");
  expect(entry?.fixtureResults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "checks-api-key-without-arguments", passed: true }),
      expect.objectContaining({ name: "rejects-invalid-api-key", passed: true }),
    ])
  );
});
