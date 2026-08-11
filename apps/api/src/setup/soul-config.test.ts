import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { patchSoulConfig, readSoulConfig } from "./soul-config";

const roots: string[] = [];

async function soulRoot(contents?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "soul-config-"));
  roots.push(root);
  if (contents !== undefined) await fs.writeFile(path.join(root, "soul.yaml"), contents, "utf8");
  return root;
}

const readYaml = async (root: string) =>
  parse(await fs.readFile(path.join(root, "soul.yaml"), "utf8")) as Record<string, unknown>;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("patchSoulConfig", () => {
  it("merges into an existing config without dropping unrelated keys", async () => {
    const root = await soulRoot("businessName: Acme\ngitRemoteUrl: git@example.com:acme.git\n");

    await patchSoulConfig(root, { setupComplete: true });

    expect(await readYaml(root)).toMatchObject({
      businessName: "Acme",
      gitRemoteUrl: "git@example.com:acme.git",
      setupComplete: true,
    });
  });

  it("creates the file when the soul has no config yet", async () => {
    const root = await soulRoot();

    await patchSoulConfig(root, { businessName: "Acme" });

    expect(await readYaml(root)).toEqual({ businessName: "Acme" });
  });

  // The regression: readSoulConfig swallowed every failure and resolved to {}, so a patch merged
  // onto nothing and rewrote soul.yaml with the patch alone — silently destroying the operator's
  // business profile, LLM config and git remote.
  it("refuses to patch over a soul.yaml it cannot parse, rather than truncating it", async () => {
    const corrupt = "businessName: Acme\nllm: [unclosed\n";
    const root = await soulRoot(corrupt);

    await expect(patchSoulConfig(root, { setupComplete: true })).rejects.toThrow();

    expect(await fs.readFile(path.join(root, "soul.yaml"), "utf8")).toBe(corrupt);
  });

  it("refuses to patch over a soul.yaml that violates the schema", async () => {
    const invalid = "businessName: Acme\nsoulFormatVersion: not-a-number\n";
    const root = await soulRoot(invalid);

    await expect(patchSoulConfig(root, { setupComplete: true })).rejects.toThrow();

    expect(await fs.readFile(path.join(root, "soul.yaml"), "utf8")).toBe(invalid);
  });
});

describe("readSoulConfig", () => {
  // Boot reads gitRemoteUrl through this path; a corrupt file must degrade, never crash (S3).
  it("degrades to an empty config instead of throwing", async () => {
    expect(await readSoulConfig(await soulRoot("llm: [unclosed\n"))).toEqual({});
    expect(await readSoulConfig(await soulRoot())).toEqual({});
  });

  it("returns the parsed config when it is valid", async () => {
    const root = await soulRoot("businessName: Acme\nsetupComplete: true\n");

    expect(await readSoulConfig(root)).toMatchObject({
      businessName: "Acme",
      setupComplete: true,
    });
  });
});
