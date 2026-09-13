import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { oimFileDigest } from "@tulipfarm/schema";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOimReleasePackages } from "./package-source";
import { verifyOimReleasePackage } from "./package-verifier";
import { releasePackageFixture } from "./test-fixtures";

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".oim-release-source-"));
  roots.push(root);
  return root;
}

async function writePackage(
  root: string,
  name: string,
  files: Readonly<Record<string, string>>
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const package_ = releasePackageFixture({ integrationId: name, files });
  await writeFile(join(dir, "oim.yml"), `${JSON.stringify(package_.manifest, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("inspectOimReleasePackages", () => {
  it("captures every package byte so undeclared companions cannot bypass verification", async () => {
    const root = await testRoot();
    await writePackage(root, "weather", { "setup-guide.md": "# Guide\n" });
    await writeFile(join(root, "weather", "undeclared.json"), "{}\n");

    const [candidate] = await inspectOimReleasePackages(root);

    expect(candidate?.package.files).toEqual(
      new Map([
        ["setup-guide.md", new Uint8Array(Buffer.from("# Guide\n"))],
        ["undeclared.json", new Uint8Array(Buffer.from("{}\n"))],
      ])
    );
    expect(() => verifyOimReleasePackage(candidate?.package)).toThrow(
      "undeclared.json is present but not declared"
    );
  });

  it("records symlinked declared companions as unsafe without following them", async () => {
    const root = await testRoot();
    const dir = await writePackage(root, "weather", {});
    const manifest = releasePackageFixture().manifest;
    manifest.files = [
      {
        path: "setup-guide.md",
        role: "guide",
        sha256: oimFileDigest("# Outside\n"),
      },
    ];
    await writeFile(join(dir, "oim.yml"), `${JSON.stringify(manifest, null, 2)}\n`);
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside\n");
    await symlink(outside, join(dir, "setup-guide.md"));

    const [candidate] = await inspectOimReleasePackages(root);

    expect(candidate?.sourceIssues).toContain("setup-guide.md is a symbolic link");
    expect(candidate?.package.files.has("setup-guide.md")).toBe(false);
  });

  it("keeps candidate directories separate and preserves nested companion paths", async () => {
    const root = await testRoot();
    await writePackage(root, "calendar", { "fixtures/events.json": '{"ok":true}\n' });
    await writePackage(root, "weather", { "setup-guide.md": "# Weather\n" });

    const candidates = await inspectOimReleasePackages(root);

    expect(candidates.map((candidate) => candidate.package.manifest.metadata.id)).toEqual([
      "calendar",
      "weather",
    ]);
    expect(candidates[0]?.package.files.has("fixtures/events.json")).toBe(true);
  });

  it("does not let an unrelated malformed package invalidate a valid candidate", async () => {
    const root = await testRoot();
    await writePackage(root, "weather", { "setup-guide.md": "# Weather\n" });
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", "oim.yml"), "not: [valid");

    const candidates = await inspectOimReleasePackages(root);

    expect(candidates.map((candidate) => candidate.package.manifest.metadata.id)).toEqual([
      "weather",
    ]);
  });
});
