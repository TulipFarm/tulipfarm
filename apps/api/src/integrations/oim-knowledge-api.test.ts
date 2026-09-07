import { OimKnowledgeRetryRequiredError } from "@tulipfarm/integrations";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import type { RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import { createRegistryKnowledgeApiPort, OimKnowledgeApiError } from "./oim-knowledge-api";

const manifest = knowledgeManifestFixture();
const ctx = { userId: "u1", runId: "run1", toolCallId: "outer-call" } as RequestContext;

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
    connectionId: "connection-b",
    ...(newCallId === undefined ? {} : { newCallId }),
  });
}

describe("createRegistryKnowledgeApiPort", () => {
  it("dispatches through the Integration's own registered Tool with the exact Connection", async () => {
    const seen: Record<string, unknown>[] = [];
    const retryPolicies: (RequestContext["retryWaitPolicy"] | undefined)[] = [];
    const api = port(
      registryWith("wiki_list_pages", (args, callCtx) => {
        seen.push(args);
        retryPolicies.push(callCtx.retryWaitPolicy);
        return { success: true, data: { results: [] } };
      })
    );
    await api.execute({ operationId: "list-pages", parameters: { spaceKey: "ENG" } });
    expect(seen).toEqual([{ spaceKey: "ENG", connection_id: "connection-b" }]);
    expect(retryPolicies).toEqual(["refuse"]);
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

  it("gives each nested call a distinct id that is stable when the outer call replays", async () => {
    const ids: (string | undefined)[] = [];
    const registry = registryWith("wiki_list_pages", (_args, callCtx) => {
      ids.push(callCtx.toolCallId);
      return { success: true, data: {} };
    });
    const api = port(registry);
    await api.execute({ operationId: "list-pages", parameters: {} });
    await api.execute({ operationId: "list-pages", parameters: {} });
    const replay = port(registry);
    await replay.execute({ operationId: "list-pages", parameters: {} });

    expect(ids[0]).toMatch(/^outer-call:knowledge:0:[a-f0-9]{16}$/);
    expect(ids[1]).toMatch(/^outer-call:knowledge:1:[a-f0-9]{16}$/);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("does not reuse an effect id when another operation occupies the same replay ordinal", async () => {
    const ids: (string | undefined)[] = [];
    const registry = new ToolRegistry({ defaultDeny: true });
    for (const name of ["wiki_list_pages", "wiki_get_page"]) {
      registry.register({
        name,
        tier: "integration",
        mutating: false,
        description: name,
        inputSchema: { type: "object" },
        execute: async (_args, callCtx) => {
          ids.push(callCtx.toolCallId);
          return { success: true, data: {} };
        },
      });
    }

    await port(registry).execute({
      operationId: "list-pages",
      parameters: { spaceKey: "ENG" },
    });
    await port(registry).execute({ operationId: "get-page", parameters: { id: "1" } });

    expect(ids[0]).toMatch(/^outer-call:knowledge:0:[a-f0-9]{16}$/);
    expect(ids[1]).toMatch(/^outer-call:knowledge:0:[a-f0-9]{16}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("creates one stable outer identity when the caller has no Tool call id", async () => {
    const ids: (string | undefined)[] = [];
    const api = createRegistryKnowledgeApiPort({
      slug: "wiki",
      manifest,
      registry: registryWith("wiki_list_pages", (_args, callCtx) => {
        ids.push(callCtx.toolCallId);
        return { success: true, data: {} };
      }),
      ctx: { userId: "u1", runId: "run1" },
      connectionId: "connection-b",
      newCallId: () => "generated-outer",
    });
    await api.execute({ operationId: "list-pages", parameters: {} });
    await api.execute({ operationId: "list-pages", parameters: {} });

    expect(ids[0]).toMatch(/^generated-outer:knowledge:0:[a-f0-9]{16}$/);
    expect(ids[1]).toMatch(/^generated-outer:knowledge:1:[a-f0-9]{16}$/);
  });

  it("overrides any caller-supplied Connection with the host selection", async () => {
    const selections: unknown[] = [];
    const api = port(
      registryWith("wiki_list_pages", (args) => {
        selections.push(args.connection_id);
        return { success: true, data: {} };
      })
    );

    await api.execute({
      operationId: "list-pages",
      parameters: { connection_id: "connection-a" },
    });

    expect(selections).toEqual(["connection-b"]);
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

  it("surfaces a refused Retry-After without accepting a parked result", async () => {
    const api = port(
      registryWith("wiki_list_pages", () => ({
        success: false,
        error: {
          code: "retry_wait_unavailable",
          message: "provider requested a delayed retry",
        },
      }))
    );

    await expect(api.execute({ operationId: "list-pages", parameters: {} })).rejects.toBeInstanceOf(
      OimKnowledgeRetryRequiredError
    );
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
