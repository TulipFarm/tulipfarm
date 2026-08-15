import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../types";
import { bundledIntegrationsDir, loadBundledIntegrations } from "./bundled";

const temporaryDirectories: string[] = [];
const originalOverride = process.env.BUNDLED_INTEGRATIONS_DIR;

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundled-integrations-"));
  temporaryDirectories.push(root);

  const valid = join(root, "slack");
  const invalid = join(root, "broken");
  await mkdir(valid, { recursive: true });
  await mkdir(invalid, { recursive: true });
  await writeFile(
    join(valid, "manifest.yml"),
    "name: slack\negress:\n  type: none\nrequired_env:\n  - name: SLACK_BOT_TOKEN\n    label: Bot Token\n    secret: true\n",
    "utf8"
  );
  await writeFile(join(valid, "setup-guide.md"), "# Connect Slack", "utf8");
  await writeFile(join(invalid, "manifest.yml"), "name: broken\n", "utf8");
  return root;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(async () => {
  if (originalOverride === undefined) {
    delete process.env.BUNDLED_INTEGRATIONS_DIR;
  } else {
    process.env.BUNDLED_INTEGRATIONS_DIR = originalOverride;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("bundledIntegrationsDir", () => {
  it("uses an explicit BUNDLED_INTEGRATIONS_DIR override", () => {
    process.env.BUNDLED_INTEGRATIONS_DIR = "./test-integrations";
    expect(bundledIntegrationsDir()).toBe(resolve("./test-integrations"));
  });
});

describe("loadBundledIntegrations", () => {
  it("loads valid manifests and skips ones missing egress.type without throwing", async () => {
    const root = await makeTree();
    const logger = makeLogger();

    const integrations = await loadBundledIntegrations(logger, root);

    expect([...integrations.keys()]).toEqual(["slack"]);
    const slack = integrations.get("slack");
    expect(slack?.manifest.name).toBe("slack");
    expect(slack?.manifest.egress).toEqual({ type: "none" });
    expect(slack?.setupGuide).toBe("# Connect Slack");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Bundled Integration "broken" skipped')
    );
  });

  it("returns an empty map when the directory does not exist", async () => {
    const logger = makeLogger();
    const integrations = await loadBundledIntegrations(logger, "/nonexistent/path/xyz");
    expect(integrations.size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("carries the OpenAPI document of a manifest that declares one", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundled-egress-"));
    temporaryDirectories.push(root);
    const dir = join(root, "acme");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yml"),
      "name: acme\negress:\n  type: openapi\n  spec: openapi.json\n",
      "utf8"
    );
    await writeFile(join(dir, "openapi.json"), '{"openapi":"3.0.3","paths":{}}', "utf8");

    const acme = (await loadBundledIntegrations(makeLogger(), root)).get("acme");

    expect(acme?.egressSpec).toEqual({ openapi: "3.0.3", paths: {} });
    // Verbatim too, because installing a bundled integration copies this into the operator's soul
    // repo — without it the installed manifest would name a spec that is not there.
    expect(acme?.egressSpecFile).toEqual({
      file: "openapi.json",
      raw: '{"openapi":"3.0.3","paths":{}}',
    });
  });

  it("skips an integration whose declared spec is missing rather than half-loading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundled-egress-missing-"));
    temporaryDirectories.push(root);
    const dir = join(root, "acme");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yml"),
      "name: acme\negress:\n  type: openapi\n  spec: openapi.json\n",
      "utf8"
    );
    const logger = makeLogger();

    const integrations = await loadBundledIntegrations(logger, root);

    expect(integrations.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Bundled Integration "acme" skipped')
    );
  });
});

describe("the integrations shipped in this repo", () => {
  it("all load, including every declared OpenAPI document", async () => {
    // The real directory, not a fixture. `loadBundledIntegrations` logs and skips a broken
    // integration rather than throwing, so without this a manifest whose spec failed to read would
    // simply vanish from the catalog — and the first symptom would be an operator connecting a
    // provider and receiving no Tools.
    const logger = makeLogger();
    const dir = bundledIntegrationsDir();
    const integrations = await loadBundledIntegrations(logger, dir);

    // Derived from the directory rather than hardcoded: a fixed list would have to be edited
    // every time an integration ships, and the edit that silences it is the same edit that would
    // hide a genuine skip. Comparing against what is actually on disk keeps the guard honest.
    const onDisk = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    expect(onDisk.length).toBeGreaterThan(0);
    expect([...integrations.keys()].sort()).toEqual(onDisk);
    expect(logger.error).not.toHaveBeenCalled();

    for (const [slug, entry] of integrations) {
      if (entry.manifest.egress?.type !== "openapi") continue;
      expect(entry.egressSpec, `${slug} parsed spec`).toBeDefined();
      expect(entry.egressSpecFile?.file, `${slug} spec filename`).toBe(entry.manifest.egress.spec);
    }
  });
});
