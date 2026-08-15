import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmConfig } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { deleteLlmConfigFromSoulYaml, writeLlmConfigToSoulYaml } from "./soul-yaml-io";

let TMP: string;

const validConfig: LlmConfig = {
  tiers: {
    quick: { providers: [{ provider: "azure", model: "gpt-4o" }] },
    standard: { providers: [{ provider: "azure", model: "gpt-4o" }] },
    complex: { providers: [{ provider: "azure", model: "gpt-4o" }] },
  },
};

beforeEach(async () => {
  TMP = await mkdtemp(join(tmpdir(), "soul-yaml-io-test-"));
});
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("writeLlmConfigToSoulYaml", () => {
  it("writes a valid llm config under the top-level llm: key", async () => {
    await writeLlmConfigToSoulYaml(TMP, validConfig);
    const manifest = parseYaml(await readFile(join(TMP, "soul.yaml"), "utf8"));
    expect(manifest.llm).toEqual(validConfig);
  });

  it("preserves other known top-level keys already in soul.yaml", async () => {
    await writeFile(join(TMP, "soul.yaml"), "businessName: Acme\nsetupComplete: true\n", "utf8");
    await writeLlmConfigToSoulYaml(TMP, validConfig);
    const manifest = parseYaml(await readFile(join(TMP, "soul.yaml"), "utf8"));
    expect(manifest.businessName).toBe("Acme");
    expect(manifest.setupComplete).toBe(true);
    expect(manifest.llm).toEqual(validConfig);
  });

  it("preserves unknown top-level keys (open schema)", async () => {
    await writeFile(join(TMP, "soul.yaml"), "someFutureKey: hello\n", "utf8");
    await writeLlmConfigToSoulYaml(TMP, validConfig);
    const manifest = parseYaml(await readFile(join(TMP, "soul.yaml"), "utf8"));
    expect(manifest.someFutureKey).toBe("hello");
  });

  it("rejects a structurally invalid llm config", async () => {
    await expect(writeLlmConfigToSoulYaml(TMP, { tiers: {} })).rejects.toThrow();
  });

  it("rejects a soul.yaml whose existing known field has the wrong type", async () => {
    await writeFile(join(TMP, "soul.yaml"), "setupComplete: not-a-boolean\n", "utf8");
    await expect(writeLlmConfigToSoulYaml(TMP, validConfig)).rejects.toThrow();
  });
});

describe("deleteLlmConfigFromSoulYaml", () => {
  it("removes the llm: key, preserving other keys", async () => {
    await writeFile(
      join(TMP, "soul.yaml"),
      "businessName: Acme\nllm:\n  tiers:\n    quick:\n      providers:\n        - provider: azure\n          model: gpt-4o\n    standard:\n      providers:\n        - provider: azure\n          model: gpt-4o\n    complex:\n      providers:\n        - provider: azure\n          model: gpt-4o\n",
      "utf8"
    );
    await deleteLlmConfigFromSoulYaml(TMP);
    const manifest = parseYaml(await readFile(join(TMP, "soul.yaml"), "utf8"));
    expect(manifest.llm).toBeUndefined();
    expect(manifest.businessName).toBe("Acme");
  });

  it("is a no-op when soul.yaml has no llm: key", async () => {
    await expect(deleteLlmConfigFromSoulYaml(TMP)).resolves.toBeUndefined();
  });

  it("is a no-op when soul.yaml does not exist", async () => {
    await expect(deleteLlmConfigFromSoulYaml(join(TMP, "missing"))).resolves.toBeUndefined();
  });
});
