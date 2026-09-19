import { canonicalHash, type McpIntegrationDefinition } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import type { SoulGitStore } from "../git-store";
import type { SoulIntegration } from "../types";
import { SoulWriter } from "../writer";
import { createSoulMcpDefinitionStore } from "./mcp-store";

const actor = { principalId: "user", name: "Muskan Vijayvargiya", email: "operator@example.com" };
const definition: McpIntegrationDefinition = {
  server: {
    id: "weather",
    label: "Weather",
    transport: { type: "streamable-http", url: "https://example.com/mcp" },
    authentication: { type: "none" },
  },
  enabled: true,
  reviewPolicy: "initial",
  reviewed: { tools: [], resources: [], prompts: [] },
};

function fixture() {
  const files = new Map<string, string>();
  const loader = { integrations: new Map<string, SoulIntegration>() };
  const commit = vi.fn(
    async ({ files: changes }: { files: { path: string; content?: string }[] }) => {
      let filesChanged = 0;
      for (const change of changes) {
        if (change.content !== files.get(change.path)) filesChanged++;
        if (change.content !== undefined) files.set(change.path, change.content);
      }
      return { commitSha: "a".repeat(40), filesChanged };
    }
  );
  const gitStore = {
    baseCommit: async () => "a".repeat(40),
    lastCommitForPath: async (path: string) => (files.has(path) ? "a".repeat(40) : null),
    readFile: (path: string) => files.get(path) ?? null,
    commitChangeset: commit,
  } as unknown as SoulGitStore;
  const publish = vi.fn(async () => {
    const content = files.get("integrations/weather/mcp.yaml");
    if (content)
      loader.integrations.set("weather", {
        slug: "weather",
        sourceIntegration: "weather",
        mcp: parse(content),
      });
  });
  const writer = new SoulWriter(
    gitStore,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    undefined,
    undefined,
    { publishCommittedTree: publish }
  );
  const store = createSoulMcpDefinitionStore({
    loader,
    soulWriter: writer,
    businessId: "business",
  });
  return { files, loader, commit, publish, store };
}

describe("durable setup publication recovery", () => {
  it("retries actual publication of exact committed bytes even when Git reports no changes", async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error("Synthetic publication outage"));
    await expect(f.store.resumePut(definition, actor, null)).rejects.toMatchObject({
      code: "ACTIVATION_FAILED",
    });
    expect(f.store.get("weather")).toBeUndefined();
    expect(f.files.has("integrations/weather/mcp.yaml")).toBe(true);
    await f.store.resumePut(definition, actor, null);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(await f.commit.mock.results[1]?.value).toMatchObject({ filesChanged: 0 });
    expect(f.store.get("weather")).toEqual(definition);
  });
  it("keeps normal writes strict and refuses a concurrently edited authored target", async () => {
    const f = fixture();
    f.files.set("integrations/weather/mcp.yaml", stringify(definition));
    await expect(f.store.put(definition, actor, null)).rejects.toMatchObject({ code: "CONFLICT" });
    f.files.set(
      "integrations/weather/mcp.yaml",
      stringify({ ...definition, reviewPolicy: "custom" })
    );
    await expect(f.store.resumePut(definition, actor, null)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("never calls a no-op retry successful while its publisher is still failing", async () => {
    const f = fixture();
    f.files.set("integrations/weather/mcp.yaml", stringify(definition));
    f.publish.mockRejectedValue(new Error("Synthetic publication outage"));
    await expect(
      f.store.resumePut(definition, actor, canonicalHash({ ...definition, enabled: false }))
    ).rejects.toMatchObject({ code: "ACTIVATION_FAILED" });
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.store.get("weather")).toBeUndefined();
  });
});
