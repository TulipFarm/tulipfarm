import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  oimPackageIssues,
  validateFixtureSuiteSource,
  validateManifestSource,
} from "../src/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerIds = [
  "linear",
  "shopify",
  "confluence",
  "slack-oim",
  "gitlab",
  "twilio",
  "telegram",
];

async function loadPackage(providerId) {
  const directory = resolve(root, "integrations", providerId);
  const source = await readFile(resolve(directory, "oim.yml"), "utf8");
  const manifest = validateManifestSource(source);
  const files = new Map();
  for (const file of manifest.files ?? []) {
    files.set(file.path, await readFile(resolve(directory, file.path)));
  }
  return { manifest, files };
}

test("core provider packages pass portable package and fixture validation", async () => {
  for (const providerId of providerIds) {
    const { manifest, files } = await loadPackage(providerId);
    assert.deepEqual(oimPackageIssues(manifest, files), [], providerId);
    const guide = manifest.files?.find(({ role }) => role === "guide");
    assert(guide && files.has(guide.path), `${providerId} must declare its setup guide`);
    const fixture = files.get("fixtures.yml");
    assert(fixture, `${providerId} must declare fixtures`);
    validateFixtureSuiteSource(fixture.toString("utf8"));
  }
});

test("Linear preserves its legacy guide beside the OIM package guide", async () => {
  const { manifest, files } = await loadPackage("linear");
  assert(files.has("setup-guide-oim.md"));
  assert.equal(files.has("setup-guide.md"), false);
  const legacyGuide = await readFile(resolve(root, "integrations/linear/setup-guide.md"), "utf8");
  assert.match(legacyGuide, /TulipFarm uses a Linear personal API key/);
  assert.equal(manifest.files?.find(({ role }) => role === "guide")?.path, "setup-guide-oim.md");
});

test("Slack rejects unsuccessful HTTP 200 response envelopes", async () => {
  const { manifest } = await loadPackage("slack-oim");
  for (const operation of manifest.operations) {
    assert.equal(operation.response.schema.properties.ok.const, true, operation.id);
    assert(operation.response.schema.required.includes("ok"), operation.id);
  }
});

test("Confluence declares safe provider request and response shapes", async () => {
  const { manifest, files } = await loadPackage("confluence");
  assert.equal(manifest.profiles.core, "1.1");
  assert.equal(manifest.profiles.knowledge, "1.2");

  for (const operationId of ["list-spaces", "list-pages"]) {
    const operation = manifest.operations.find(({ id }) => id === operationId);
    assert.deepEqual(operation?.pagination, {
      type: "link",
      header: "Link",
      itemsPath: "/results",
    });
  }

  const getPage = manifest.operations.find(({ id }) => id === "get-page");
  const bodyFormat = getPage?.source.parameters?.find(({ name }) => name === "body-format");
  assert.equal(getPage?.effect, "sensitive_read");
  assert.equal(bodyFormat?.value, "storage");
  assert(!Object.hasOwn(bodyFormat ?? {}, "required"));

  const restrictions = manifest.operations.find(({ id }) => id === "get-restrictions");
  const restrictionProperties = restrictions?.response.schema.properties?.restrictions?.properties;
  assert(restrictionProperties?.user);
  assert(restrictionProperties?.group);
  assert(!Object.hasOwn(restrictionProperties.user.properties?.results ?? {}, "minItems"));
  assert.equal(manifest.knowledge.acl.entriesPointer, "/restrictions/user/results");
  assert.equal(manifest.knowledge.acl.entry.providerGroupId, undefined);
  assert.deepEqual(manifest.knowledge.liveAuthorization, {
    operationId: "check-page-read",
    itemParameter: "id",
    principalParameter: "body",
    principalBody: {
      template: {
        subject: { type: "user" },
        operation: "read",
      },
      pointer: "/subject/identifier",
    },
    allowedPointer: "/hasPermission",
  });
  assert.equal(
    manifest.operations.find(({ id }) => id === "get-group-members"),
    undefined
  );
  const permissionCheck = manifest.operations.find(({ id }) => id === "check-page-read");
  assert.equal(permissionCheck?.source.method, "POST");
  assert.equal(permissionCheck?.source.contentType, "json");
  assert.equal(permissionCheck?.source.path, "/wiki/rest/api/content/{id}/permission/check");
  assert.deepEqual(permissionCheck?.response.projection, ["/hasPermission"]);

  const fixtureSource = files.get("fixtures.yml")?.toString("utf8") ?? "";
  const guideSource = files.get("setup-guide.md")?.toString("utf8") ?? "";
  assert.match(fixtureSource, /Link: <\/wiki\/api\/v2\/spaces\?/);
  assert.match(fixtureSource, /restrictions:\n\s+user:\n\s+results:/);
  assert.match(fixtureSource, /\n\s+group:\n\s+results:/);
  assert.match(fixtureSource, /name: reads-group-only-restrictions/);
  assert.match(fixtureSource, /name: reads-empty-direct-restrictions/);
  assert.match(fixtureSource, /name: allows-effective-group-or-inherited-access/);
  assert.match(fixtureSource, /name: denies-effective-page-space-or-product-access/);
  assert.match(fixtureSource, /name: rejects-unverifiable-effective-access/);
  assert.match(fixtureSource, /name: rejects-malformed-permission-proof/);
  assert.match(fixtureSource, /name: rejects-missing-page/);
  assert.match(guideSource, /Confluence Administrator/);
  assert.match(guideSource, /group membership/);
  assert.match(guideSource, /fail closed/);

  const legacyProfile = structuredClone(manifest);
  legacyProfile.profiles.knowledge = "1.1";
  assert.match(
    oimPackageIssues(legacyProfile, files).join("\n"),
    /knowledge "1\.2" is required for liveAuthorization\.principalBody/
  );
});
