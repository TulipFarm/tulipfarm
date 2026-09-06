import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import type { RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import { createRegistryKnowledgeApiPort, OimKnowledgeApiError } from "./oim-knowledge-api";

const manifest = knowledgeManifestFixture();
const ctx = { userId: "u1", runId: "run1" } as RequestContext;

function registryWith(
  name: string,
  execute: (args: Record<string, unknown>, callCtx: RequestContext) => unknown
): ToolRegistry {
  const registry = new ToolRegistry({ defaultDeny: true });
  registry.register({
    name,
    tier: "integration",
    mutating: false,
    description: name,
    inputSchema: { type: "object" },
    execute: async (args: unknown, callCtx: RequestContext) =>
      execute((args ?? {}) as Record<string, unknown>, callCtx) as never,
  });
  return registry;
}

function port(registry: ToolRegistry, newCallId?: () => string) {
  return createRegistryKnowledgeApiPort({
    slug: "wiki",
    manifest,
    registry,
    ctx,
    ...(newCallId === undefined ? {} : { newCallId }),
  });
}

describe("createRegistryKnowledgeApiPort", () => {
  it("dispatches through the Integration's own registered Tool", async () => {
    const seen: Record<string, unknown>[] = [];
    const api = port(
      registryWith("wiki_list_pages", (args) => {
        seen.push(args);
        return { success: true, data: { results: [] } };
      })
    );
    await api.execute({ operationId: "list-pages", parameters: { spaceKey: "ENG" } });
    expect(seen).toEqual([{ spaceKey: "ENG" }]);
  });

  it("passes a page token in and reports the next one out", async () => {
    const api = port(
      registryWith("wiki_list_pages", (args) => ({
        success: true,
        data: {
          results: [],
          next_page_token: args.page_token === "p1" ? undefined : "p1",
        },
      }))
    );
    const first = await api.execute({ operationId: "list-pages", parameters: {} });
    expect(first.nextPageToken).toBe("p1");
    const second = await api.execute({
      operationId: "list-pages",
      parameters: {},
      pageToken: "p1",
    });
    expect(second.nextPageToken).toBeUndefined();
  });

  it("gives each call its own id so a second page is never read as a replay", async () => {
    const ids: (string | undefined)[] = [];
    const api = port(
      registryWith("wiki_list_pages", (_args, callCtx) => {
        ids.push(callCtx.toolCallId);
        return { success: true, data: {} };
      })
    );
    await api.execute({ operationId: "list-pages", parameters: {} });
    await api.execute({ operationId: "list-pages", parameters: {} });
    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("refuses an operation the manifest does not declare", async () => {
    const api = port(registryWith("wiki_list_pages", () => ({ success: true, data: {} })));
    await expect(api.execute({ operationId: "nope", parameters: {} })).rejects.toMatchObject({
      code: "operation_unknown",
    });
  });

  it("reports an unregistered Tool rather than returning an empty page", async () => {
    const api = port(new ToolRegistry({ defaultDeny: true }) as ToolRegistry);
    await expect(api.execute({ operationId: "list-pages", parameters: {} })).rejects.toBeInstanceOf(
      OimKnowledgeApiError
    );
  });

  it("turns a failed Tool call into a raised error the sync records", async () => {
    const api = port(
      registryWith("wiki_list_pages", () => ({
        success: false,
        error: { code: "credential_required", message: "connect first" },
      }))
    );
    await expect(api.execute({ operationId: "list-pages", parameters: {} })).rejects.toMatchObject({
      code: "call_failed",
    });
  });

  it("treats a parked call as a failure, never as a page", async () => {
    const api = port(
      registryWith("wiki_list_pages", () => ({ parked: { reason: "approval_required" } }))
    );
    await expect(api.execute({ operationId: "list-pages", parameters: {} })).rejects.toMatchObject({
      code: "parked",
    });
  });

  it("passes a non-object page through untouched", async () => {
    const api = port(registryWith("wiki_list_pages", () => ({ success: true, data: [1, 2] })));
    expect(await api.execute({ operationId: "list-pages", parameters: {} })).toEqual({
      body: [1, 2],
    });
  });
});
