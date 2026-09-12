import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOimManifest } from "@tulipfarm/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SoulLoader } from "../published-loader";
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
  it("gives every shipped directory a supported entry point", async () => {
    const root = bundledIntegrationsDir();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = await readdir(join(root, entry.name));
      expect(
        files.includes("manifest.yml") || files.includes("oim.yml"),
        `${entry.name} entry point`
      ).toBe(true);
    }
  });

  it("loads every legacy package, including every declared OpenAPI document", async () => {
    const logger = makeLogger();
    const sourceRoot = bundledIntegrationsDir();
    const root = await mkdtemp(join(import.meta.dirname, "__bundled-legacy-test__-"));
    temporaryDirectories.push(root);
    const onDisk: string[] = [];
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = await readdir(join(sourceRoot, entry.name));
      if (!files.includes("manifest.yml")) continue;
      onDisk.push(entry.name);
      await cp(join(sourceRoot, entry.name), join(root, entry.name), { recursive: true });
    }
    onDisk.sort();
    const integrations = await loadBundledIntegrations(logger, root);

    expect(onDisk.length).toBeGreaterThan(0);
    expect([...integrations.keys()].sort()).toEqual(onDisk);
    expect(logger.error).not.toHaveBeenCalled();

    for (const [slug, entry] of integrations) {
      if (entry.manifest.egress?.type !== "openapi") continue;
      expect(entry.egressSpec, `${slug} parsed spec`).toBeDefined();
      expect(entry.egressSpecFile?.file, `${slug} spec filename`).toBe(entry.manifest.egress.spec);
    }
  });

  it("loads every OIM package through the published Soul loader", async () => {
    const logger = makeLogger();
    const sourceRoot = bundledIntegrationsDir();
    const soulRoot = await mkdtemp(join(import.meta.dirname, "__bundled-oim-test__-"));
    temporaryDirectories.push(soulRoot);
    const targetRoot = join(soulRoot, "integrations");
    const onDisk: string[] = [];

    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDirectory = join(sourceRoot, entry.name);
      const files = await readdir(sourceDirectory);
      if (!files.includes("oim.yml")) continue;

      const source = await readFile(join(sourceDirectory, "oim.yml"), "utf8");
      const manifest = parseOimManifest(source);
      const targetDirectory = join(targetRoot, entry.name);
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, "oim.yml"), source, "utf8");
      for (const file of manifest.files ?? []) {
        const target = join(targetDirectory, file.path);
        await mkdir(join(target, ".."), { recursive: true });
        await cp(join(sourceDirectory, file.path), target);
      }
      onDisk.push(entry.name);
    }

    const loader = new SoulLoader(soulRoot, logger);
    await loader.load();
    onDisk.sort();

    expect(onDisk.length).toBeGreaterThan(0);
    expect([...loader.integrations.keys()].sort()).toEqual(onDisk);
    expect(logger.error).not.toHaveBeenCalled();

    for (const [slug, entry] of loader.integrations) {
      expect(entry.oimManifest?.metadata.id, `${slug} manifest identity`).toBe(slug);
      expect(
        Object.keys(entry.oimPackageFiles ?? {}).sort(),
        `${slug} declared companions`
      ).toEqual((entry.oimManifest?.files ?? []).map(({ path }) => path).sort());
      for (const file of entry.oimManifest?.files ?? []) {
        if (file.role !== "openapi") continue;
        expect(entry.oimOpenApiDocuments?.[file.path], `${slug} parsed ${file.path}`).toBeDefined();
      }
    }
  });
});
