import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import { oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import type { SoulLoader, SoulWriteRequest, SoulWriter } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  discoverIntegrations,
  installIntegrationFromSource,
  updateIntegrationFromSource,
} from "./install";

const execFileAsync = promisify(execFile);

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync(command, [...args], { cwd });
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oim-discovery-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePackage(slug: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, "integrations", slug);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
}

function manifestYaml(overrides: Record<string, unknown> = {}): string {
  return stringifyYaml({ ...knowledgeManifestFixture(), ...overrides });
}

describe("discoverIntegrations, OIM packages", () => {
  it("discovers an oim.yml package and content-addresses it", async () => {
    await writePackage("wiki", { "oim.yml": manifestYaml() });

    const [found] = await discoverIntegrations(root);
    expect(found.name).toBe("wiki");
    expect(found.issues).toEqual([]);
    expect(found.manifest).toBeUndefined();
    expect(found.oimManifest?.metadata.id).toBe("wiki");
    expect(found.packageDigest).toBe(oimPackageDigest(knowledgeManifestFixture()));
    expect(found.manifestPath).toBe(join("integrations", "wiki", "oim.yml"));
  });

  it("reads the setup guide beside the manifest", async () => {
    await writePackage("wiki", {
      "oim.yml": manifestYaml(),
      "setup-guide.md": "# Connect the wiki\n",
    });

    const [found] = await discoverIntegrations(root);
    expect(found.setupGuide).toBe("# Connect the wiki\n");
  });

  it("refuses a package that declares both oim.yml and manifest.yml", async () => {
    await writePackage("wiki", {
      "oim.yml": manifestYaml(),
      "manifest.yml": "name: wiki\n",
    });

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toEqual(["declares both oim.yml and manifest.yml; keep exactly one"]);
    expect(found.oimManifest).toBeUndefined();
  });

  it("refuses a package carrying an executable payload", async () => {
    await writePackage("wiki", {
      "oim.yml": manifestYaml(),
      "package.json": "{}\n",
      "sync.js": "process.exit(0)\n",
    });

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toContain("package carries an executable payload: package.json");
    expect(found.issues).toContain("package carries an executable payload: sync.js");
  });

  it("refuses a package whose declared companion is missing", async () => {
    const spec = "openapi: 3.1.0\n";
    await writePackage("wiki", {
      "oim.yml": manifestYaml({
        files: [{ path: "openapi.yaml", role: "openapi", sha256: oimFileDigest(spec) }],
      }),
    });

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toContain("files: openapi.yaml is declared but missing");
  });

  it("refuses a package whose companion does not match its declared digest", async () => {
    await writePackage("wiki", {
      "oim.yml": manifestYaml({
        files: [{ path: "openapi.yaml", role: "openapi", sha256: oimFileDigest("expected") }],
      }),
      "openapi.yaml": "openapi: 3.1.0\n",
    });

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toContain("files: openapi.yaml digest does not match the manifest");
  });

  it("refuses a companion path that does not sit beside the manifest", async () => {
    await writePackage("wiki", {
      "oim.yml": manifestYaml({
        files: [{ path: "specs/openapi.yaml", role: "openapi", sha256: oimFileDigest("x") }],
      }),
    });

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toContain("files: specs/openapi.yaml must sit beside oim.yml");
  });

  it("refuses a package that declares JavaScript hooks", async () => {
    const hook = "export const normalize = (event) => event;\n";
    await writePackage("wiki", {
      "oim.yml": manifestYaml({
        profiles: { ...knowledgeManifestFixture().profiles, hooks: "1.0" },
        files: [{ path: "hooks.js", role: "hook", sha256: oimFileDigest(hook) }],
        hooks: [{ kind: "response_normalize", file: "hooks.js", export: "normalize" }],
      }),
      "hooks.js": hook,
    });

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toContain("hooks: an unsigned package may not declare JavaScript hooks");
  });

  it("reports an unparseable oim.yml rather than skipping the directory", async () => {
    await writePackage("wiki", { "oim.yml": "oimVersion: '1.0'\nkind: Nonsense\n" });

    const [found] = await discoverIntegrations(root);
    expect(found.name).toBe("wiki");
    expect(found.issues[0]).toMatch(/^oim\.yml is not a valid manifest/);
  });

  it("still discovers legacy manifest directories alongside OIM ones", async () => {
    await writePackage("wiki", { "oim.yml": manifestYaml() });
    await writePackage("legacy", {
      "manifest.yml": stringifyYaml({ name: "legacy", version: "1.0.0" }),
    });

    const found = await discoverIntegrations(root);
    expect(found.map((entry) => entry.name)).toEqual(["legacy", "wiki"]);
    expect(found[0].manifest?.name).toBe("legacy");
    expect(found[0].packageDigest).toBeUndefined();
  });
});

describe("installing and updating an OIM package", () => {
  let repo = "";
  let source = "";
  const commits: SoulWriteRequest[] = [];
  let stored = new Map<string, string>();

  const soulWriter = {
    read: (kind: string) => stored.get(kind) ?? null,
    apply: async (changeset: SoulWriteRequest) => {
      commits.push(changeset);
      for (const change of changeset.changes) {
        if (change.op === "put" && change.target.kind === "IntegrationsLock") {
          stored.set("IntegrationsLock", change.content);
        }
      }
      return { commit: "abc" };
    },
  } as unknown as SoulWriter;

  const installed = new Map<string, unknown>();
  const soulLoader = {
    integrations: installed,
    reload: async () => undefined,
  } as unknown as SoulLoader;

  async function commitPackage(manifest: string, definition = "oim.yml"): Promise<void> {
    const dir = join(repo, "integrations", "wiki");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, definition), manifest, "utf8");
    await run("git", ["add", "-A"], repo);
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "p"], repo);
  }

  beforeEach(async () => {
    process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS = "1";
    repo = await mkdtemp(join(tmpdir(), "oim-repo-"));
    source = pathToFileURL(repo).href;
    commits.length = 0;
    stored = new Map();
    installed.clear();
    await run("git", ["init", "-b", "main"], repo);
    await commitPackage(manifestYaml());
  });

  afterEach(async () => {
    delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
    await rm(repo, { recursive: true, force: true });
  });

  const deps = () => ({
    soulLoader,
    soulWriter,
    bundledSlugs: new Set<string>(),
    actorId: "u1",
  });

  const legacyManifest = () =>
    stringifyYaml({
      name: "wiki",
      version: "1.0.0",
      description: "Legacy wiki",
      egress: { type: "none" },
    });

  it("refuses an install when a fixture fails and names its case", async () => {
    const fixture = `version: 1
cases:
  - name: lists-spaces
    operationId: list-spaces
    request: {}
    response:
      status: 200
      body: { actual: true }
    expect:
      request:
        method: GET
        url: https://wiki.example/rest/space
      result: { expected: true }
`;
    const packageManifest = knowledgeManifestFixture();
    await commitPackage(
      stringifyYaml({
        ...packageManifest,
        files: [{ path: "fixtures.yml", role: "fixture", sha256: oimFileDigest(fixture) }],
      })
    );
    await writeFile(join(repo, "integrations", "wiki", "fixtures.yml"), fixture, "utf8");
    await run("git", ["add", "-A"], repo);
    await run(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "fixture"],
      repo
    );

    await expect(installIntegrationFromSource({ source }, deps())).rejects.toThrow(
      /fixture lists-spaces failed/
    );
  });

  it("writes oim.yml and records the approved digest in the lock", async () => {
    const result = await installIntegrationFromSource({ source }, deps());

    expect(result.packageDigest).toBe(oimPackageDigest(knowledgeManifestFixture()));
    const written = commits[0].changes.filter((change) => change.op === "put");
    expect(written.map((change) => change.target.companion)).toContain("oim.yml");

    const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    expect(lock.integrations.wiki.definition).toBe("oim");
    expect(lock.integrations.wiki.packageDigest).toBe(result.packageDigest);
  });

  it("refuses an update whose package changed since it was approved", async () => {
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", {});

    const changed = knowledgeManifestFixture();
    await commitPackage(
      stringifyYaml({ ...changed, metadata: { ...changed.metadata, version: "3.0.0" } })
    );

    await expect(updateIntegrationFromSource({ name: "wiki", source }, deps())).rejects.toThrow(
      /changed since it was approved/
    );
  });

  it("accepts the update once the new digest is named", async () => {
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", { oimManifest: knowledgeManifestFixture() });

    const changed = knowledgeManifestFixture();
    const next = { ...changed, metadata: { ...changed.metadata, version: "2.2.0" } };
    await commitPackage(stringifyYaml(next));

    const result = await updateIntegrationFromSource(
      { name: "wiki", source, approveDigest: oimPackageDigest(next) },
      deps()
    );
    expect(result.packageDigest).toBe(oimPackageDigest(next));

    const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    expect(lock.integrations.wiki.packageDigest).toBe(oimPackageDigest(next));
  });

  it("updates without an approval when the package is byte-identical", async () => {
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", {});

    await expect(
      updateIntegrationFromSource({ name: "wiki", source }, deps())
    ).resolves.toMatchObject({ name: "wiki" });
  });

  it("refuses a legacy-to-OIM format transition without changing the installed package", async () => {
    await commitPackage(legacyManifest(), "manifest.yml");
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", { manifest: { name: "wiki" } });
    await commitPackage(manifestYaml());

    await expect(
      updateIntegrationFromSource(
        { name: "wiki", source, approveDigest: oimPackageDigest(knowledgeManifestFixture()) },
        deps()
      )
    ).rejects.toThrow(/cannot change.*legacy.*OIM/i);
    expect(commits).toHaveLength(1);
  });

  it("refuses an OIM-to-legacy format transition without leaving both definitions", async () => {
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", { oimManifest: knowledgeManifestFixture() });
    await commitPackage(legacyManifest(), "manifest.yml");

    await expect(updateIntegrationFromSource({ name: "wiki", source }, deps())).rejects.toThrow(
      /cannot change.*OIM.*legacy/i
    );
    expect(commits).toHaveLength(1);
  });

  it("refuses an incompatible same-major OIM update even after its digest is approved", async () => {
    const existing = knowledgeManifestFixture();
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", { oimManifest: existing });
    const next = structuredClone(existing);
    next.operations[0].name = "renamed_operation";
    await commitPackage(stringifyYaml(next));

    await expect(
      updateIntegrationFromSource(
        { name: "wiki", source, approveDigest: oimPackageDigest(next) },
        deps()
      )
    ).rejects.toThrow(/incompatible OIM update.*changed name/i);
  });

  it("refuses an OIM major update even after its digest is approved", async () => {
    const existing = knowledgeManifestFixture();
    await installIntegrationFromSource({ source }, deps());
    installed.set("wiki", { oimManifest: existing });
    const next = { ...existing, metadata: { ...existing.metadata, version: "3.0.0" } };
    await commitPackage(stringifyYaml(next));

    await expect(
      updateIntegrationFromSource(
        { name: "wiki", source, approveDigest: oimPackageDigest(next) },
        deps()
      )
    ).rejects.toThrow(/major version.*uninstall/i);
  });
});
