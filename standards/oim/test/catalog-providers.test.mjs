import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateFixtureSuiteSource, validateManifestSource } from "../src/index.mjs";

const providers = [
  "asana",
  "clickup",
  "confluence-data-center",
  "discord",
  "facebook",
  "google-workspace",
  "hubspot",
  "instagram",
  "jira",
  "linkedin",
  "mailchimp",
  "notion",
  "openweather",
  "reddit",
  "trello",
  "x",
  "zendesk",
];

const communicationOperations = new Map([
  ["asana", "add-comment"],
  ["clickup", "add-comment"],
  ["facebook", "create-page-post"],
  ["instagram", "publish-media"],
  ["linkedin", "create-post"],
  ["x", "create-post"],
]);

test("the provider catalog contains valid exact OIM packages", async () => {
  const workRoot = new URL("../.test-work/catalog-providers/", import.meta.url);
  await rm(workRoot, { recursive: true, force: true });

  try {
    for (const provider of providers) {
      const sourceRoot = new URL(`../../../integrations/${provider}/`, import.meta.url);
      const packageRoot = new URL(`${provider}/`, workRoot);
      const manifestSource = await readFile(new URL("oim.yml", sourceRoot), "utf8");
      const manifest = validateManifestSource(manifestSource);

      assert.equal(manifest.metadata.id, provider);
      assert.ok(
        manifest.files?.some((file) => file.path === "setup-guide.md" && file.role === "guide"),
        `${provider} must declare its setup guide`
      );
      assert.ok(
        manifest.files?.some((file) => file.role === "fixture"),
        `${provider} must declare an offline fixture suite`
      );

      await mkdir(packageRoot, { recursive: true });
      await writeFile(new URL("oim.yml", packageRoot), manifestSource);
      const coveredOperationIds = new Set();
      for (const file of manifest.files ?? []) {
        const target = new URL(file.path, packageRoot);
        const content = await readFile(new URL(file.path, sourceRoot));
        await mkdir(dirname(fileURLToPath(target)), { recursive: true });
        await writeFile(target, content);
        if (file.role === "fixture") {
          const suite = validateFixtureSuiteSource(content.toString("utf8"));
          for (const fixture of suite.cases) coveredOperationIds.add(fixture.operationId);
        }
      }

      const missingOperationIds = manifest.operations
        .map((operation) => operation.id)
        .filter((operationId) => !coveredOperationIds.has(operationId));
      assert.deepEqual(
        missingOperationIds,
        [],
        `${provider} missing fixture coverage: ${missingOperationIds.join(", ")}`
      );

      const communicationOperationId = communicationOperations.get(provider);
      if (communicationOperationId !== undefined) {
        const operation = manifest.operations.find(
          (candidate) => candidate.id === communicationOperationId
        );
        assert.equal(
          operation?.effect,
          "send",
          `${provider}/${communicationOperationId} must use the send effect`
        );
      }
      if (provider === "instagram") {
        const containerOperation = manifest.operations.find(
          (candidate) => candidate.id === "create-image-container"
        );
        assert.equal(
          containerOperation?.effect,
          "create",
          "instagram/create-image-container must remain a non-publishing create"
        );
      }

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../bin/oim.mjs", import.meta.url)),
          "validate",
          fileURLToPath(packageRoot),
        ],
        { encoding: "utf8" }
      );
      assert.equal(result.status, 0, `${provider}: ${result.stderr}`);
      assert.match(result.stdout, /"valid": true/);
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});
