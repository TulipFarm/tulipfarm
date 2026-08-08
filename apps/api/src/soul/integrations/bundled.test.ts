import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "@tulipfarm/soul";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
