import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { EgressHttpPort } from "@tulipfarm/integrations";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import {
  createEd25519OimReleaseSigner,
  signOimRelease,
  signOimRevocationList,
} from "@tulipfarm/integrations/src/releases/signatures";
import { createOimReleaseTrustService } from "@tulipfarm/integrations/src/releases/trust-service";
import { type OimManifest, oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import type { SoulLoader, SoulWriteRequest, SoulWriter } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  discoverIntegrations,
  inspectIntegrationSource,
  installIntegrationFromSource,
  type OimInstallTrust,
  removeIntegrationFromSoul,
  reviewOimTrust,
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
  it("discovers a root-level oim.yml using its declared integration id", async () => {
    await writeFile(join(root, "oim.yml"), manifestYaml(), "utf8");

    const [found] = await discoverIntegrations(root);
    expect(found.name).toBe("wiki");
    expect(found.manifestPath).toBe("oim.yml");
  });

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

  it("reads declared companions from nested package directories", async () => {
    const spec = "openapi: 3.1.0\n";
    await writePackage("wiki", {
      "oim.yml": manifestYaml({
        files: [{ path: "specs/openapi.yaml", role: "openapi", sha256: oimFileDigest(spec) }],
      }),
    });
    await mkdir(join(root, "integrations", "wiki", "specs"));
    await writeFile(join(root, "integrations", "wiki", "specs", "openapi.yaml"), spec, "utf8");

    const [found] = await discoverIntegrations(root);
    expect(found.issues).toEqual([]);
    expect(found.companions?.get("specs/openapi.yaml")).toBe(spec);
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
  let currentCommit = "base";

  const soulWriter = {
    read: (kind: string) => stored.get(kind) ?? null,
    readCompanion: (kind: string, slug: string, name: string) =>
      stored.get(`${kind}:${slug}:${name}`) ?? null,
    apply: async (changeset: SoulWriteRequest) => {
      if (
        changeset.expectedBaseCommit !== undefined &&
        changeset.expectedBaseCommit !== currentCommit
      ) {
        throw new Error("Soul changed after publication");
      }
      commits.push(changeset);
      for (const change of changeset.changes) {
        if (change.op === "put" && change.target.kind === "IntegrationsLock") {
          stored.set("IntegrationsLock", change.content);
        } else if (change.op === "put" && change.target.companion !== undefined) {
          stored.set(
            `${change.target.kind}:${change.target.slug}:${change.target.companion}`,
            change.content
          );
        } else if (change.op === "delete" && change.target.companion !== undefined) {
          stored.delete(`${change.target.kind}:${change.target.slug}:${change.target.companion}`);
        } else if (change.op === "delete" && change.target.kind === "IntegrationsLock") {
          stored.delete("IntegrationsLock");
        }
      }
      currentCommit = `commit-${commits.length}`;
      return { commitSha: currentCommit, published: true };
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
    currentCommit = "base";
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
    const reviewedManifest = {
      ...packageManifest,
      files: [{ path: "fixtures.yml", role: "fixture" as const, sha256: oimFileDigest(fixture) }],
    };
    await commitPackage(stringifyYaml(reviewedManifest));
    await writeFile(join(repo, "integrations", "wiki", "fixtures.yml"), fixture, "utf8");
    await run("git", ["add", "-A"], repo);
    await run(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "fixture"],
      repo
    );

    await expect(
      installIntegrationFromSource(
        {
          source,
          ref: await headOf(repo),
          approveDigest: oimPackageDigest(reviewedManifest),
        },
        deps()
      )
    ).rejects.toThrow(/fixture lists-spaces failed/);
  });

  it("writes oim.yml and records the approved digest in the lock", async () => {
    const digest = oimPackageDigest(knowledgeManifestFixture());
    const result = await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: digest },
      deps()
    );

    expect(result.packageDigest).toBe(digest);
    const written = commits[0].changes.filter((change) => change.op === "put");
    expect(written.map((change) => change.target.companion)).toContain("oim.yml");

    const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    expect(lock.integrations.wiki.definition).toBe("oim");
    expect(lock.integrations.wiki.packageDigest).toBe(result.packageDigest);
  });

  it("rejects automatic patch opt-in for a Community package", async () => {
    const digest = oimPackageDigest(knowledgeManifestFixture());

    await expect(
      installIntegrationFromSource(
        {
          source,
          ref: await headOf(repo),
          approveDigest: digest,
          autoPatchOptIn: true,
        },
        deps()
      )
    ).rejects.toThrow(/automatic patch updates require a verified Official release/);
    expect(commits).toHaveLength(0);
  });

  it("refuses an update whose package changed since it was approved", async () => {
    await installIntegrationFromSource(
      {
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(knowledgeManifestFixture()),
      },
      deps()
    );
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
    await installIntegrationFromSource(
      {
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(knowledgeManifestFixture()),
      },
      deps()
    );
    installed.set("wiki", { oimManifest: knowledgeManifestFixture() });

    const changed = knowledgeManifestFixture();
    const next = { ...changed, metadata: { ...changed.metadata, version: "2.2.0" } };
    await commitPackage(stringifyYaml(next));

    const result = await updateIntegrationFromSource(
      {
        name: "wiki",
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(next),
      },
      deps()
    );
    expect(result.packageDigest).toBe(oimPackageDigest(next));

    const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    expect(lock.integrations.wiki.packageDigest).toBe(oimPackageDigest(next));
  });

  it("updates without an approval when the package is byte-identical", async () => {
    await installIntegrationFromSource(
      {
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(knowledgeManifestFixture()),
      },
      deps()
    );
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
    await installIntegrationFromSource(
      {
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(knowledgeManifestFixture()),
      },
      deps()
    );
    installed.set("wiki", { oimManifest: knowledgeManifestFixture() });
    await commitPackage(legacyManifest(), "manifest.yml");

    await expect(updateIntegrationFromSource({ name: "wiki", source }, deps())).rejects.toThrow(
      /cannot change.*OIM.*legacy/i
    );
    expect(commits).toHaveLength(1);
  });

  it("refuses an incompatible same-major OIM update even after its digest is approved", async () => {
    const existing = knowledgeManifestFixture();
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: oimPackageDigest(existing) },
      deps()
    );
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
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: oimPackageDigest(existing) },
      deps()
    );
    installed.set("wiki", { oimManifest: existing });
    const next = { ...existing, metadata: { ...existing.metadata, version: "3.0.0" } };
    await commitPackage(stringifyYaml(next));

    await expect(
      updateIntegrationFromSource(
        { name: "wiki", source, approveDigest: oimPackageDigest(next) },
        deps()
      )
    ).rejects.toThrow(/major version.*install endpoint.*beside/i);
  });

  it("refuses a first OIM install when the reviewed commit or digest changed", async () => {
    const reviewedRef = await headOf(repo);
    const reviewedDigest = oimPackageDigest(knowledgeManifestFixture());
    const changed = knowledgeManifestFixture();
    await commitPackage(
      stringifyYaml({ ...changed, metadata: { ...changed.metadata, version: "2.2.0" } })
    );

    await expect(
      installIntegrationFromSource(
        { source, ref: reviewedRef, approveDigest: reviewedDigest },
        deps()
      )
    ).rejects.toThrow(/changed since it was reviewed/);
    expect(commits).toHaveLength(0);
  });

  it("routes a same-major install through compatibility-checked update behavior", async () => {
    const first = knowledgeManifestFixture();
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: oimPackageDigest(first) },
      deps()
    );
    installed.set("wiki", {
      slug: "wiki",
      sourceIntegration: "wiki",
      oimManifest: first,
    });
    const patch = { ...first, metadata: { ...first.metadata, version: "2.2.0" } };
    await commitPackage(stringifyYaml(patch));

    const result = await installIntegrationFromSource(
      {
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(patch),
      },
      deps()
    );

    expect(result).toMatchObject({
      name: "wiki",
      integrationId: "wiki",
      majorVersion: 2,
      packageDigest: oimPackageDigest(patch),
    });
    expect(commits.at(-1)?.subject).toBe("soul: update integration wiki");
  });

  it("installs and updates another major under an independent storage slug", async () => {
    const first = knowledgeManifestFixture();
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: oimPackageDigest(first) },
      deps()
    );
    installed.set("wiki", {
      slug: "wiki",
      sourceIntegration: "wiki",
      oimManifest: first,
    });

    const second = { ...first, metadata: { ...first.metadata, version: "3.0.0" } };
    await commitPackage(stringifyYaml(second));
    const installedSecond = await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: oimPackageDigest(second) },
      deps()
    );
    expect(installedSecond).toMatchObject({
      name: "wiki-v3",
      integrationId: "wiki",
      majorVersion: 3,
    });
    const secondWrite = commits.at(-1);
    expect(secondWrite?.changes).toContainEqual(
      expect.objectContaining({
        op: "put",
        target: expect.objectContaining({ kind: "Integration", slug: "wiki-v3" }),
      })
    );
    expect(secondWrite?.changes).not.toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({ companion: "connection.yaml" }),
      })
    );

    installed.set("wiki-v3", {
      slug: "wiki-v3",
      sourceIntegration: "wiki",
      oimManifest: second,
    });
    const patch = { ...second, metadata: { ...second.metadata, version: "3.1.0" } };
    await rm(join(repo, "integrations", "wiki"), { recursive: true, force: true });
    await mkdir(join(repo, "integrations", "wiki-v2"), { recursive: true });
    await mkdir(join(repo, "integrations", "wiki-v3"), { recursive: true });
    await writeFile(join(repo, "integrations", "wiki-v2", "oim.yml"), stringifyYaml(first), "utf8");
    await writeFile(join(repo, "integrations", "wiki-v3", "oim.yml"), stringifyYaml(patch), "utf8");
    await run("git", ["add", "-A"], repo);
    await run(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "patch v3"],
      repo
    );
    const updatedSecond = await updateIntegrationFromSource(
      {
        name: "wiki-v3",
        source,
        ref: await headOf(repo),
        approveDigest: oimPackageDigest(patch),
      },
      deps()
    );
    expect(updatedSecond).toMatchObject({
      name: "wiki-v3",
      integrationId: "wiki",
      majorVersion: 3,
      packageDigest: oimPackageDigest(patch),
    });

    const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    expect(lock.integrations.wiki).toMatchObject({ integrationId: "wiki", majorVersion: 2 });
    expect(lock.integrations["wiki-v3"]).toMatchObject({
      integrationId: "wiki",
      majorVersion: 3,
      packageDigest: oimPackageDigest(patch),
    });

    const removed = await removeIntegrationFromSoul({ name: "wiki-v3" }, deps());
    expect(removed).toEqual({ name: "wiki-v3", integrationId: "wiki", majorVersion: 3 });
    expect(commits.at(-1)?.changes).toContainEqual({
      op: "deleteArtifact",
      kind: "Integration",
      slug: "wiki-v3",
    });
    const remainingLock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    expect(remainingLock.integrations.wiki).toBeDefined();
    expect(remainingLock.integrations["wiki-v3"]).toBeUndefined();
  });

  it("refuses a new major whose storage slug is already occupied", async () => {
    const first = knowledgeManifestFixture();
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: oimPackageDigest(first) },
      deps()
    );
    installed.set("wiki", {
      slug: "wiki",
      sourceIntegration: "wiki",
      oimManifest: first,
    });
    const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
    lock.integrations["wiki-v3"] = { sourceType: "git" };
    stored.set("IntegrationsLock", `${JSON.stringify(lock)}\n`);
    const second = { ...first, metadata: { ...first.metadata, version: "3.0.0" } };
    await commitPackage(stringifyYaml(second));

    await expect(
      installIntegrationFromSource(
        { source, ref: await headOf(repo), approveDigest: oimPackageDigest(second) },
        deps()
      )
    ).rejects.toThrow(/slug already exists/i);
  });

  it.each([
    { autoPatchOptIn: undefined, expectedAutoPatch: true },
    { autoPatchOptIn: false, expectedAutoPatch: false },
    { autoPatchOptIn: true, expectedAutoPatch: true },
  ])(
    "records verified Official provenance with patch preference $autoPatchOptIn",
    async ({ autoPatchOptIn, expectedAutoPatch }) => {
      const hook = "export const normalize = (value) => value;\n";
      const official: OimManifest = {
        ...knowledgeManifestFixture(),
        profiles: { ...knowledgeManifestFixture().profiles, hooks: "1.0" },
        files: [{ path: "hooks.js", role: "hook" as const, sha256: oimFileDigest(hook) }],
        hooks: [{ kind: "response_normalize" as const, file: "hooks.js", export: "normalize" }],
      };
      await commitPackage(stringifyYaml(official));
      await writeFile(join(repo, "integrations", "wiki", "hooks.js"), hook, "utf8");
      await run("git", ["add", "-A"], repo);
      await run(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "signed hook"],
        repo
      );
      const releaseKeys = generateKeyPairSync("ed25519");
      const revocationKeys = generateKeyPairSync("ed25519");
      const key = (keyId: string, pair: typeof releaseKeys) => ({
        keyId,
        privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
      const releaseKey = key("release-key", releaseKeys);
      const revocationKey = key("revocation-key", revocationKeys);
      const signedRelease = signOimRelease(
        { manifest: official, files: new Map([["hooks.js", hook]]) },
        createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
      );
      const revocations = signOimRevocationList(
        {
          sequence: 1,
          issuedAt: "2026-09-07T06:00:00.000Z",
          expiresAt: "2026-09-08T06:00:00.000Z",
          revocations: [],
        },
        createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
      );
      const trust = createOimReleaseTrustService({
        trustedReleaseKeys: [releaseKey],
        trustedRevocationKeys: [revocationKey],
        revocationStore: {
          load: async () => revocations,
          compareAndSwap: async () => false,
        },
        now: () => new Date("2026-09-07T06:30:00.000Z"),
      });
      const provenance: unknown[] = [];
      const releaseTrust: OimInstallTrust = {
        authorizeInstall: trust.authorizeInstall,
        installedProvenance: async () => null,
        recordInstalledProvenance: async (input) => {
          provenance.push(input);
        },
      };
      const inspected = await inspectIntegrationSource(source, "u1");
      const inspectedPackage = inspected.integrations[0];
      if (inspectedPackage === undefined) throw new Error("inspection returned no package");
      await expect(reviewOimTrust(inspectedPackage, signedRelease, releaseTrust)).resolves.toEqual({
        support: "official",
        issues: [],
        hooksAllowed: true,
        autoPatchEligible: true,
        signerKeyId: "release-key",
        revocationSequence: 1,
      });
      const ref = await headOf(repo);
      await expect(
        installIntegrationFromSource(
          {
            source,
            ref,
            signedRelease: {
              ...signedRelease,
              release: { ...signedRelease.release, version: "2.2.0" },
            },
          },
          { ...deps(), releaseTrust }
        )
      ).rejects.toThrow(/signature|identity/i);
      expect(commits).toHaveLength(0);

      const result = await installIntegrationFromSource(
        {
          source,
          ref,
          signedRelease,
          ...(autoPatchOptIn === undefined ? {} : { autoPatchOptIn }),
        },
        { ...deps(), releaseTrust }
      );

      expect(result.support).toBe("official");
      expect(provenance).toEqual([
        expect.objectContaining({
          authorization: expect.objectContaining({
            integrationId: "wiki",
            trustClass: "official",
            signedRelease,
          }),
          autoPatchOptIn: expectedAutoPatch,
          originalRequirements: official,
        }),
      ]);
    }
  );

  it("reverts the Soul publication when durable provenance cannot be recorded", async () => {
    const manifest = knowledgeManifestFixture();
    const digest = oimPackageDigest(manifest);
    const releaseTrust: OimInstallTrust = {
      authorizeInstall: async () => ({
        trustClass: "community",
        integrationId: manifest.metadata.id,
        version: manifest.metadata.version,
        packageDigest: digest,
        hooksAllowed: false,
        approvedCommunityDigest: digest,
      }),
      installedProvenance: async () => null,
      recordInstalledProvenance: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      installIntegrationFromSource(
        { source, ref: await headOf(repo), approveDigest: digest },
        { ...deps(), releaseTrust }
      )
    ).rejects.toThrow(/Soul publication was reverted/);

    expect(commits).toHaveLength(2);
    expect(commits[1]?.subject).toBe("soul: install integration wiki rollback");
    expect(stored.has("IntegrationsLock")).toBe(false);
    expect(stored.has("Integration:wiki:oim.yml")).toBe(false);
  });

  it("does not overwrite a concurrent Soul change when install rollback loses its CAS", async () => {
    const manifest = knowledgeManifestFixture();
    const digest = oimPackageDigest(manifest);
    const releaseTrust: OimInstallTrust = {
      authorizeInstall: async () => ({
        trustClass: "community",
        integrationId: manifest.metadata.id,
        version: manifest.metadata.version,
        packageDigest: digest,
        hooksAllowed: false,
        approvedCommunityDigest: digest,
      }),
      installedProvenance: async () => null,
      recordInstalledProvenance: async () => {
        stored.set("Integration:wiki:oim.yml", "concurrent package");
        const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
        lock.integrations.other = { sourceType: "git" };
        stored.set("IntegrationsLock", JSON.stringify(lock));
        currentCommit = "concurrent-commit";
        throw new Error("database unavailable");
      },
    };

    await expect(
      installIntegrationFromSource(
        { source, ref: await headOf(repo), approveDigest: digest },
        { ...deps(), releaseTrust }
      )
    ).rejects.toThrow(/rollback failed/);

    expect(stored.get("Integration:wiki:oim.yml")).toBe("concurrent package");
    expect(JSON.parse(stored.get("IntegrationsLock") ?? "{}").integrations.other).toBeDefined();
  });

  it("restores the previous package when updated provenance cannot be recorded", async () => {
    const current = knowledgeManifestFixture();
    const currentDigest = oimPackageDigest(current);
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: currentDigest },
      deps()
    );
    installed.set("wiki", {
      slug: "wiki",
      sourceIntegration: "wiki",
      oimManifest: current,
    });
    const candidate = {
      ...current,
      metadata: { ...current.metadata, version: "2.2.0" },
    };
    await commitPackage(stringifyYaml(candidate));
    const candidateDigest = oimPackageDigest(candidate);
    const releaseTrust: OimInstallTrust = {
      authorizeInstall: async () => ({
        trustClass: "community",
        integrationId: candidate.metadata.id,
        version: candidate.metadata.version,
        packageDigest: candidateDigest,
        hooksAllowed: false,
        approvedCommunityDigest: candidateDigest,
      }),
      installedProvenance: async () => null,
      recordInstalledProvenance: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      updateIntegrationFromSource(
        {
          name: "wiki",
          source,
          ref: await headOf(repo),
          approveDigest: candidateDigest,
        },
        { ...deps(), releaseTrust }
      )
    ).rejects.toThrow(/Soul publication was reverted/);

    expect(parseYaml(stored.get("Integration:wiki:oim.yml") ?? "").metadata.version).toBe("2.1.0");
    expect(JSON.parse(stored.get("IntegrationsLock") ?? "{}").integrations.wiki.packageDigest).toBe(
      currentDigest
    );
  });

  it("does not overwrite a concurrent Soul change when update rollback loses its CAS", async () => {
    const current = knowledgeManifestFixture();
    const currentDigest = oimPackageDigest(current);
    await installIntegrationFromSource(
      { source, ref: await headOf(repo), approveDigest: currentDigest },
      deps()
    );
    installed.set("wiki", {
      slug: "wiki",
      sourceIntegration: "wiki",
      oimManifest: current,
    });
    const candidate = {
      ...current,
      metadata: { ...current.metadata, version: "2.2.0" },
    };
    await commitPackage(stringifyYaml(candidate));
    const candidateDigest = oimPackageDigest(candidate);
    const releaseTrust: OimInstallTrust = {
      authorizeInstall: async () => ({
        trustClass: "community",
        integrationId: candidate.metadata.id,
        version: candidate.metadata.version,
        packageDigest: candidateDigest,
        hooksAllowed: false,
        approvedCommunityDigest: candidateDigest,
      }),
      installedProvenance: async () => null,
      recordInstalledProvenance: async () => {
        stored.set("Integration:wiki:oim.yml", "concurrent package");
        const lock = JSON.parse(stored.get("IntegrationsLock") ?? "{}");
        lock.integrations.other = { sourceType: "git" };
        stored.set("IntegrationsLock", JSON.stringify(lock));
        currentCommit = "concurrent-commit";
        throw new Error("database unavailable");
      },
    };

    await expect(
      updateIntegrationFromSource(
        {
          name: "wiki",
          source,
          ref: await headOf(repo),
          approveDigest: candidateDigest,
        },
        { ...deps(), releaseTrust }
      )
    ).rejects.toThrow(/rollback failed/);

    expect(stored.get("Integration:wiki:oim.yml")).toBe("concurrent package");
    expect(JSON.parse(stored.get("IntegrationsLock") ?? "{}").integrations.other).toBeDefined();
  });
});

describe("direct HTTPS OIM packages", () => {
  const source = "https://packages.example/wiki/oim.yml?download_token=secret";
  const manifest = knowledgeManifestFixture();

  function http(files: Readonly<Record<string, string>>): EgressHttpPort {
    return {
      send: async (request) => {
        const body = files[request.url];
        return body === undefined
          ? { status: 404, headers: { "content-type": "text/plain" }, body: "missing" }
          : { status: 200, headers: { "content-type": "text/yaml" }, body };
      },
    };
  }

  it("inspects and installs a manifest URL with same-origin declared companions", async () => {
    const fixture = `version: 1
cases:
  - name: lists-spaces
    operationId: list-spaces
    request: {}
    response:
      status: 200
      body: { spaces: [] }
    expect:
      request:
        method: GET
        url: https://wiki.example/rest/space
      result: { spaces: [] }
`;
    const packageManifest = {
      ...manifest,
      files: [
        {
          path: "fixtures/smoke.yml",
          role: "fixture" as const,
          sha256: oimFileDigest(fixture),
        },
      ],
    };
    const transport = http({
      [source]: stringifyYaml(packageManifest),
      "https://packages.example/wiki/fixtures/smoke.yml": fixture,
    });
    const commits: SoulWriteRequest[] = [];
    let lock = "";
    const soulWriter = {
      read: () => lock || null,
      apply: async (request: SoulWriteRequest) => {
        commits.push(request);
        const lockWrite = request.changes.find(
          (change) => change.op === "put" && change.target.kind === "IntegrationsLock"
        );
        if (lockWrite?.op === "put") lock = lockWrite.content;
        return { commit: "abc" };
      },
    } as unknown as SoulWriter;
    const deps = {
      soulLoader: {
        integrations: new Map(),
        reload: async () => undefined,
      } as unknown as SoulLoader,
      soulWriter,
      bundledSlugs: new Set<string>(),
      actorId: "u1",
      http: transport,
    };

    const reviewed = await inspectIntegrationSource(source, "u1", { http: transport });
    expect(reviewed).toMatchObject({
      source: "https://packages.example/wiki/oim.yml",
      sourceType: "https",
      ref: `sha256:${oimPackageDigest(packageManifest)}`,
    });

    const result = await installIntegrationFromSource(
      {
        source,
        name: "wiki",
        ref: reviewed.ref,
        approveDigest: oimPackageDigest(packageManifest),
      },
      deps
    );
    expect(result.source).toBe("https://packages.example/wiki/oim.yml");
    expect(commits).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(lock))).not.toContain("secret");
  });

  it("refuses a declared companion that resolves to another origin", async () => {
    const spec = "openapi: 3.1.0\ninfo: { title: Wiki, version: 1.0.0 }\npaths: {}\n";
    const packageManifest = {
      ...manifest,
      files: [
        {
          path: "spec.yml",
          role: "openapi" as const,
          sha256: oimFileDigest(spec),
        },
      ],
    };
    const transport: EgressHttpPort = {
      send: async (request) =>
        request.url === source
          ? {
              status: 200,
              headers: { "content-type": "text/yaml", location: "" },
              body: stringifyYaml(packageManifest),
            }
          : {
              status: 302,
              headers: {
                "content-type": "text/plain",
                location: "https://evil.example/spec.yml",
              },
              body: "",
            },
    };

    await expect(inspectIntegrationSource(source, "u1", { http: transport })).rejects.toThrow(
      /redirects to another origin/
    );
  });

  it("refuses direct package bytes that change between review and install", async () => {
    let served = manifest;
    const transport: EgressHttpPort = {
      send: async () => ({
        status: 200,
        headers: { "content-type": "text/yaml" },
        body: stringifyYaml(served),
      }),
    };
    const reviewed = await inspectIntegrationSource(source, "u1", { http: transport });
    const reviewedDigest = reviewed.integrations[0]?.packageDigest;
    if (reviewedDigest === undefined) throw new Error("review did not return a package digest");
    served = {
      ...manifest,
      metadata: { ...manifest.metadata, version: "2.2.0" },
    };
    const commits: SoulWriteRequest[] = [];
    const soulWriter = {
      read: () => null,
      apply: async (request: SoulWriteRequest) => {
        commits.push(request);
        return { commit: "abc" };
      },
    } as unknown as SoulWriter;

    await expect(
      installIntegrationFromSource(
        {
          source,
          name: "wiki",
          ref: reviewed.ref,
          approveDigest: reviewedDigest,
        },
        {
          soulLoader: {
            integrations: new Map(),
            reload: async () => undefined,
          } as unknown as SoulLoader,
          soulWriter,
          bundledSlugs: new Set(),
          actorId: "u1",
          http: transport,
        }
      )
    ).rejects.toThrow(/changed since it was reviewed/);
    expect(commits).toHaveLength(0);
  });

  it("never installs executable payloads from a direct URL", async () => {
    const script = "console.log('not run');\n";
    const packageManifest = {
      ...manifest,
      files: [{ path: "setup.js", role: "hook" as const, sha256: oimFileDigest(script) }],
    };
    const transport = http({
      [source]: stringifyYaml(packageManifest),
      "https://packages.example/wiki/setup.js": script,
    });
    const reviewed = await inspectIntegrationSource(source, "u1", { http: transport });

    expect(reviewed.integrations[0]?.issues).toContain(
      "package carries an executable payload: setup.js"
    );
  });
});

async function headOf(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
  return stdout.trim();
}
