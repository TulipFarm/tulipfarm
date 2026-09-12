import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseOimFixtureSuite, parseOimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { runOimFixtures } from "./oim-fixtures";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const coreProviderOperations = {
  linear: [
    "viewer",
    "list-teams",
    "list-issues",
    "read-issue",
    "create-issue",
    "update-issue",
    "create-comment",
  ],
  shopify: [
    "get-shop",
    "list-products",
    "get-product",
    "create-product",
    "update-product",
    "list-orders",
    "get-customer",
    "update-customer",
  ],
  confluence: [
    "list-spaces",
    "list-pages",
    "get-page",
    "get-restrictions",
    "get-user",
    "check-page-read",
  ],
  "slack-oim": [
    "bot-auth-test",
    "bot-list-conversations",
    "bot-conversation-history",
    "bot-list-members",
    "bot-user-info",
    "bot-read-message",
    "bot-send-message",
  ],
  gitlab: [
    "current-user",
    "list-projects",
    "list-issues",
    "get-issue",
    "create-issue",
    "comment-issue",
    "list-merge-requests",
  ],
  twilio: ["get-account", "send-message", "list-messages"],
  telegram: ["get-me", "send-message", "get-updates"],
} as const;
const coreProviderIds = Object.keys(coreProviderOperations) as Array<
  keyof typeof coreProviderOperations
>;

async function loadProvider(providerId: (typeof coreProviderIds)[number]) {
  const directory = resolve(repositoryRoot, "integrations", providerId);
  const manifest = parseOimManifest(await readFile(resolve(directory, "oim.yml"), "utf8"));
  const companions = new Map<string, string>();
  for (const file of manifest.files ?? []) {
    companions.set(file.path, await readFile(resolve(directory, file.path), "utf8"));
  }
  return { manifest, companions };
}

describe.each(coreProviderIds)("core provider fixtures: %s", (providerId) => {
  it("covers every declared operation and passes through the runtime", async () => {
    const { manifest, companions } = await loadProvider(providerId);
    const fixtureFiles = (manifest.files ?? []).filter(({ role }) => role === "fixture");
    const coveredOperations = new Set(
      fixtureFiles.flatMap(({ path }) =>
        parseOimFixtureSuite(companions.get(path) ?? "").cases.map(({ operationId }) => operationId)
      )
    );
    const missingOperations = manifest.operations
      .map(({ id }) => id)
      .filter((operationId) => !coveredOperations.has(operationId));

    expect(
      manifest.operations.map(({ id }) => id),
      `${providerId} declared operation inventory changed`
    ).toEqual([...coreProviderOperations[providerId]]);
    expect(missingOperations, `${providerId} fixtures are missing declared operations`).toEqual([]);

    const failures = (await runOimFixtures(manifest, companions)).filter(({ passed }) => !passed);
    expect(failures, `${providerId} runtime fixture failures`).toEqual([]);
  });
});
