import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHash, type McpIntegrationDefinition } from "@tulipfarm/schema";
import simpleGit from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { computeBundleDigest, createRuntimeBundle } from "../bundle";
import { compileExecutionBundle } from "../compiler";
import { parseSoulFile } from "../parse";
import { SoulLoader } from "../published-loader";
import { makeSoulWriterDouble } from "../soul-writer-double";
import { GitSoulTreeReader } from "../tree-reader";
import type { SoulIntegration } from "../types";
import { mcpIntegrationsFromBundle } from "./mcp-definition";
import { createSoulMcpDefinitionStore } from "./mcp-store";

const actor = {
  principalId: "user:operator",
  name: "Muskan Vijayvargiya",
  email: "operator@example.com",
};

function definition(): McpIntegrationDefinition {
  return {
    server: {
      id: "weather",
      label: "Weather",
      transport: { type: "streamable-http", url: "https://weather.example.com/mcp" },
    },
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  };
}

function fixture() {
  const double = makeSoulWriterDouble();
  const loader = { integrations: new Map<string, SoulIntegration>() };
  const store = createSoulMcpDefinitionStore({
    loader,
    soulWriter: double.writer,
    businessId: "business-1",
  });
  return { ...double, loader, store };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP Soul configuration", () => {
  it("writes typed configuration through the publication gateway", async () => {
    const { store, applied } = fixture();
    await store.put(definition(), actor, null);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      actor,
      businessId: "business-1",
      source: "api",
      expectedBaseCommit: "0".repeat(40),
      changes: [
        {
          op: "put",
          target: { kind: "Integration", slug: "weather", companion: "mcp.yaml" },
          content: stringifyYaml(definition()),
        },
      ],
    });
  });

  it("guards an update by its reviewed digest and exact artifact revision", async () => {
    const { store, putCompanion, applied } = fixture();
    const previous = definition();
    putCompanion("Integration", "weather", "mcp.yaml", stringifyYaml(previous));
    await store.put({ ...previous, enabled: true }, actor, canonicalHash(previous));
    expect(applied[0]?.expectedRevisions).toEqual([
      {
        target: { kind: "Integration", slug: "weather", companion: "mcp.yaml" },
        revision: "0".repeat(40),
      },
    ]);
    expect(applied[0]?.expectedBaseCommit).toBeUndefined();
    await expect(store.put(previous, actor, canonicalHash(previous))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(applied).toHaveLength(1);
  });

  it("refuses native channel collisions and stale deletes", async () => {
    const { store, putCompanion, applied } = fixture();
    const native = { ...definition(), server: { ...definition().server, id: "slack" } };
    await expect(store.put(native, actor, null)).rejects.toMatchObject({ code: "CONFLICT" });
    putCompanion("Integration", "weather", "manifest.yml", "name: weather\n");
    await expect(store.put(definition(), actor, null)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    putCompanion("Integration", "weather", "mcp.yaml", stringifyYaml(definition()));
    await expect(store.remove("weather", actor, "changed")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(applied).toEqual([]);
  });

  it("removes only the selected MCP definition through the gateway", async () => {
    const { store, putCompanion, applied } = fixture();
    putCompanion("Integration", "weather", "mcp.yaml", stringifyYaml(definition()));
    await store.remove("weather", actor, canonicalHash(definition()));
    expect(applied[0]?.changes).toEqual([
      {
        op: "delete",
        target: { kind: "Integration", slug: "weather", companion: "mcp.yaml" },
      },
    ]);
  });

  it("never reports a committed but unpublished configuration as successful", async () => {
    const { store, writer } = fixture();
    vi.spyOn(writer, "apply").mockResolvedValue({
      commitSha: "1".repeat(40),
      filesChanged: 1,
      paths: ["integrations/weather/mcp.yaml"],
      pushed: true,
      published: false,
      publicationError: "unavailable",
    });
    await expect(store.put(definition(), actor, null)).rejects.toMatchObject({
      code: "ACTIVATION_FAILED",
    });
  });

  it("does not expose mutable references to the reviewed definition", () => {
    const { loader, store } = fixture();
    loader.integrations.set("weather", {
      slug: "weather",
      sourceIntegration: "weather",
      mcp: definition(),
    });
    const snapshot = store.get("weather");
    if (!snapshot) throw new Error("missing fixture");
    snapshot.enabled = true;
    expect(store.get("weather")?.enabled).toBe(false);
    expect(store.list()).toEqual([definition()]);
  });

  it("validates the companion at the generic Soul write boundary", () => {
    const path = "integrations/weather/mcp.yaml";
    expect(
      parseSoulFile({ operation: "upsert", path, content: stringifyYaml(definition()) }).issue
    ).toBeUndefined();
    for (const content of [
      "server: {}\n",
      stringifyYaml({ ...definition(), extra: "unknown" }),
      stringifyYaml({
        ...definition(),
        server: { ...definition().server, id: "another-server" },
      }),
    ]) {
      expect(parseSoulFile({ operation: "upsert", path, content }).issue?.code).toBe(
        "SCHEMA_VALIDATION_FAILED"
      );
    }
    for (const slug of ["slack", "github"]) {
      expect(
        parseSoulFile({
          operation: "upsert",
          path: `integrations/${slug}/mcp.yaml`,
          content: stringifyYaml({
            ...definition(),
            server: { ...definition().server, id: slug },
          }),
        }).issue?.code
      ).toBe("SCHEMA_VALIDATION_FAILED");
    }
  });

  it("loads MCP definitions alongside native channel connection state", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-soul-"));
    roots.push(root);
    await mkdir(join(root, "integrations/weather"), { recursive: true });
    await mkdir(join(root, "integrations/github"), { recursive: true });
    await writeFile(join(root, "integrations/weather/mcp.yaml"), stringifyYaml(definition()));
    await writeFile(join(root, "integrations/github/connection.yaml"), "enabled: true\n");
    const loader = new SoulLoader(root, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await loader.load();
    expect(loader.integrations.get("weather")?.mcp).toEqual(definition());
    expect(loader.integrations.get("github")?.connection).toEqual({ enabled: true });
    await writeFile(
      join(root, "integrations/weather/manifest.yml"),
      "name: weather\negress:\n  type: none\n"
    );
    await expect(loader.load()).rejects.toThrow("must use different slugs");
  });

  it("pins MCP configuration bytes and validates remote tree content before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-soul-tree-"));
    roots.push(root);
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", actor.email);
    await git.addConfig("user.name", actor.name);
    await mkdir(join(root, "integrations/weather"), { recursive: true });
    const content = stringifyYaml(definition());
    await writeFile(join(root, "integrations/weather/mcp.yaml"), content);
    await git.add(["integrations/weather/mcp.yaml"]);
    await git.commit("fixture: reviewed MCP server");
    const commitSha = (await git.revparse(["HEAD"])).trim();
    const reader = new GitSoulTreeReader(root);
    const files = await reader.readFiles(commitSha);
    const bundle = compileExecutionBundle({
      businessId: "business-1",
      changesetId: commitSha,
      commitSha,
      documents: await reader.readDefinitions(commitSha),
      files,
    });
    expect(bundle.assets).toEqual([
      expect.objectContaining({
        ownerDefinitionId: "Integration:weather",
        path: "mcp.yaml",
        content,
      }),
    ]);
    const runtimeBundle = createRuntimeBundle(bundle, computeBundleDigest(bundle));
    expect(mcpIntegrationsFromBundle(runtimeBundle).get("weather")?.mcp).toEqual(definition());

    await writeFile(join(root, "integrations/weather/mcp.yaml"), "server: {}\n");
    await git.add(["integrations/weather/mcp.yaml"]);
    await git.commit("fixture: invalid remote definition");
    await expect(reader.readFiles((await git.revparse(["HEAD"])).trim())).rejects.toThrow();
  });
});
