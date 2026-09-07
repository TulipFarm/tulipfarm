import { canonicalHash, type OimManifest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type { OimHookPhaseRunner } from "../oim-hooks";
import { OimKnowledgeRetryRequiredError } from "./oim-errors";
import { knowledgeManifestFixture } from "./oim-manifest.fixture";
import type { ProviderAccountPort, ProviderIdentityLinkPort } from "./oim-mapping";
import { compileKnowledgeProfile } from "./oim-profile";
import {
  type OimKnowledgeApiPort,
  type OimKnowledgeCheckpoint,
  type OimKnowledgeCheckpointStore,
  type OimKnowledgeSyncDeps,
  syncOimKnowledge,
} from "./oim-sync";
import type { KnowledgeEmissionSink } from "./source";

const plan = compileKnowledgeProfile(knowledgeManifestFixture());

function listPage(ids: readonly string[], extra: Record<string, unknown> = {}) {
  return {
    results: ids.map((id) => ({
      id,
      version: { number: 1 },
      title: `Page ${id}`,
      archived: false,
    })),
    ...extra,
  };
}

const ACL_OK = { results: [{ type: "known", accountId: "u1" }] };
const CONTENT_OK = { body: { storage: { value: "text" } }, version: { number: 1 } };

interface Harness {
  readonly deps: OimKnowledgeSyncDeps;
  readonly sink: {
    emitSource: ReturnType<typeof vi.fn>;
    emitChunk: ReturnType<typeof vi.fn>;
    removeSourceContent: ReturnType<typeof vi.fn>;
    removeChunk: ReturnType<typeof vi.fn>;
  };
  readonly saved: OimKnowledgeCheckpoint[];
  readonly calls: {
    operationId: string;
    parameters: Record<string, unknown>;
    pageToken?: string;
  }[];
}

function harness(
  responses: (input: {
    operationId: string;
    parameters: Record<string, unknown>;
    pageToken?: string;
  }) => { body: unknown; nextPageToken?: string },
  stored?: OimKnowledgeCheckpoint,
  hookRunner?: OimHookPhaseRunner
): Harness {
  const calls: Harness["calls"] = [];
  const api: OimKnowledgeApiPort = {
    execute: async (input) => {
      calls.push({
        operationId: input.operationId,
        parameters: { ...input.parameters },
        pageToken: input.pageToken,
      });
      return responses({
        operationId: input.operationId,
        parameters: input.parameters as Record<string, unknown>,
        pageToken: input.pageToken,
      });
    },
  };
  const saved: OimKnowledgeCheckpoint[] = [];
  const checkpoints: OimKnowledgeCheckpointStore = {
    load: async () => stored,
    save: async (checkpoint) => {
      saved.push(checkpoint);
    },
  };
  const sink = {
    emitSource: vi.fn(async () => {}),
    emitChunk: vi.fn(async () => {}),
    removeSourceContent: vi.fn(async () => {}),
    removeChunk: vi.fn(async () => {}),
  };
  const links: ProviderIdentityLinkPort = {
    linkedPrincipal: async ({ providerId }) =>
      providerId === "u1" ? { kind: "user", id: "muskan" } : undefined,
  };
  const accounts: ProviderAccountPort = {
    account: async () => undefined,
    groupMembers: async () => ["u1"],
  };
  return {
    deps: {
      api,
      checkpoints,
      sink: sink as unknown as KnowledgeEmissionSink,
      identity: { links, accounts, policy: { verifiedEmailDomains: [] } },
      ...(hookRunner === undefined ? {} : { hookRunner }),
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    },
    sink,
    saved,
    calls,
  };
}

const options = {
  businessId: "b1",
  integrationId: "int-1",
  connectionId: "conn-1",
  sourceKindId: "space",
  scopes: ["ENG"],
};

describe("syncOimKnowledge", () => {
  it("keeps two Connections indexing the same item id apart", async () => {
    const respond = ({ operationId }: { operationId: string }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    };
    const first = harness(respond);
    await syncOimKnowledge(plan, first.deps, options);
    const second = harness(respond);
    await syncOimKnowledge(plan, second.deps, { ...options, connectionId: "conn-2" });

    expect(first.sink.emitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "wiki:conn-1/1",
        locator: expect.objectContaining({ connectionId: "conn-1", integrationMajorVersion: 2 }),
        provenance: expect.objectContaining({ connectionId: "conn-1" }),
      })
    );
    expect(second.sink.emitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "wiki:conn-2/1",
        locator: expect.objectContaining({ connectionId: "conn-2" }),
        provenance: expect.objectContaining({ connectionId: "conn-2" }),
      })
    );
    expect(first.saved[0]?.integrationId).toBe("int-1@2:conn-1");
    expect(second.saved[0]?.integrationId).toBe("int-1@2:conn-2");
  });

  it("indexes an item with the readers the provider reports", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });

    const result = await syncOimKnowledge(plan, h.deps, options);
    expect(result).toMatchObject({ itemsProcessed: 1, emitted: 1, indexed: 1, failures: [] });
    expect(h.sink.emitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "wiki:conn-1/1",
        status: "active",
        verification: "verified",
        acl: expect.objectContaining({ principals: [{ kind: "user", id: "muskan" }] }),
      })
    );
    expect(h.sink.emitChunk).toHaveBeenCalledWith(
      expect.objectContaining({ chunkId: "wiki:conn-1/1#content", text: "text" })
    );
  });

  it("runs declared ACL and content Hooks before authoritative mappings", async () => {
    const manifest = knowledgeManifestFixture();
    const hooked = compileKnowledgeProfile({
      ...manifest,
      profiles: { ...manifest.profiles, hooks: "1.0" },
      hooks: [
        { kind: "acl_map", file: "hooks/map.js", export: "mapAcl" },
        { kind: "content_map", file: "hooks/map.js", export: "mapContent" },
      ],
    });
    const run = vi.fn(async (hook: { kind: string }) =>
      hook.kind === "acl_map" ? ACL_OK : CONTENT_OK
    );
    const h = harness(
      ({ operationId }) =>
        operationId === "list-pages"
          ? { body: listPage(["1"]) }
          : { body: { providerSpecific: true } },
      undefined,
      { run } as unknown as OimHookPhaseRunner
    );

    const result = await syncOimKnowledge(hooked, h.deps, options);

    expect(result).toMatchObject({ indexed: 1, failures: [] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([hook]) => hook.kind)).toEqual(["acl_map", "content_map"]);
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "acl_map" }),
      expect.objectContaining({
        operationId: "get-restrictions",
        itemId: "1",
        scopeId: "ENG",
        payload: { providerSpecific: true },
      })
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "content_map" }),
      expect.objectContaining({
        operationId: "get-page",
        itemId: "1",
        payload: { providerSpecific: true },
      })
    );
    expect(h.sink.emitChunk).toHaveBeenCalledWith(expect.objectContaining({ text: "text" }));
  });

  it("writes nothing when a content Hook fails", async () => {
    const manifest = knowledgeManifestFixture();
    const hooked = compileKnowledgeProfile({
      ...manifest,
      profiles: { ...manifest.profiles, hooks: "1.0" },
      hooks: [{ kind: "content_map", file: "hooks/map.js", export: "mapContent" }],
    });
    const run = vi.fn(async () => {
      throw new Error("Hook failed");
    });
    const h = harness(
      ({ operationId }) => {
        if (operationId === "list-pages") return { body: listPage(["1"]) };
        if (operationId === "get-restrictions") return { body: ACL_OK };
        return { body: CONTENT_OK };
      },
      undefined,
      { run } as unknown as OimHookPhaseRunner
    );

    const result = await syncOimKnowledge(hooked, h.deps, options);

    expect(result.failures).toEqual([{ code: "content_failed", scope: "ENG", itemId: "1" }]);
    expect(h.sink.emitSource).not.toHaveBeenCalled();
    expect(h.sink.emitChunk).not.toHaveBeenCalled();
  });

  it("writes nothing when a declared ACL Hook has no verified runner", async () => {
    const manifest = knowledgeManifestFixture();
    const hooked = compileKnowledgeProfile({
      ...manifest,
      profiles: { ...manifest.profiles, hooks: "1.0" },
      hooks: [{ kind: "acl_map", file: "hooks/map.js", export: "mapAcl" }],
    });
    const h = harness(({ operationId }) =>
      operationId === "list-pages" ? { body: listPage(["1"]) } : { body: ACL_OK }
    );

    const result = await syncOimKnowledge(hooked, h.deps, options);

    expect(result.failures).toEqual([{ code: "acl_failed", scope: "ENG", itemId: "1" }]);
    expect(h.sink.emitSource).not.toHaveBeenCalled();
    expect(h.sink.emitChunk).not.toHaveBeenCalled();
  });

  it("passes the selected scope to the list operation", async () => {
    const h = harness(({ operationId }) =>
      operationId === "list-pages"
        ? { body: listPage([]) }
        : { body: operationId === "get-restrictions" ? ACL_OK : CONTENT_OK }
    );
    await syncOimKnowledge(plan, h.deps, options);
    expect(h.calls[0]).toMatchObject({
      operationId: "list-pages",
      parameters: { spaceKey: "ENG" },
    });
  });

  it("binds scope context to item reads and indexes scope-local ids without collisions", async () => {
    const manifest = knowledgeManifestFixture();
    const portablePlan = compileKnowledgeProfile({
      ...manifest,
      profiles: { ...manifest.profiles, knowledge: "1.1" },
      knowledge: {
        ...manifest.knowledge,
        list: {
          ...manifest.knowledge?.list,
          mapping: {
            itemFields: {
              channel: { source: "scope" },
              timestamp: { source: "item", pointer: "/id" },
            },
            itemIdentity: ["channel", "timestamp"],
            revision: "/version/number",
            title: "/title",
            sourceUrl: "/_links/webui",
            updatedAt: "/version/when",
            deleted: "/archived",
          },
        },
        content: {
          operationId: "get-page",
          parameters: { id: "timestamp", channel: "channel" },
          mapping: {
            content: {
              itemsPointer: "/messages",
              itemPointer: "/text",
              separator: "\n",
            },
          },
        },
        acl: {
          mode: "item",
          operationId: "get-restrictions",
          parameters: { id: "timestamp", channel: "channel" },
          entriesPointer: "/members",
          entry: { defaultKind: "user", providerUserId: "" },
        },
      },
    } as OimManifest);
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: { members: ["u1"] } };
      return { body: { messages: [{ text: "first" }, { text: "second" }] } };
    });

    const result = await syncOimKnowledge(portablePlan, h.deps, options);

    expect(result).toMatchObject({ indexed: 1, failures: [] });
    expect(h.calls).toEqual([
      expect.objectContaining({
        operationId: "list-pages",
        parameters: { spaceKey: "ENG" },
      }),
      expect.objectContaining({
        operationId: "get-restrictions",
        parameters: { id: "1", channel: "ENG" },
      }),
      expect.objectContaining({
        operationId: "get-page",
        parameters: { id: "1", channel: "ENG" },
      }),
    ]);
    const itemId = canonicalHash({
      identity: [
        ["channel", "ENG"],
        ["timestamp", "1"],
      ],
    });
    expect(h.sink.emitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: `wiki:conn-1/${itemId}`,
        locator: expect.objectContaining({
          itemId,
          fields: { channel: "ENG", timestamp: "1" },
        }),
      })
    );
    expect(h.sink.emitChunk).toHaveBeenCalledWith(
      expect.objectContaining({ text: "first\nsecond" })
    );
  });

  it("fails closed without advancing when a declared item field is missing", async () => {
    const manifest = knowledgeManifestFixture();
    const strictPlan = compileKnowledgeProfile({
      ...manifest,
      profiles: { ...manifest.profiles, knowledge: "1.1" },
      knowledge: {
        ...manifest.knowledge,
        list: {
          ...manifest.knowledge?.list,
          mapping: {
            ...manifest.knowledge?.list.mapping,
            itemFields: { timestamp: { source: "item", pointer: "/missing" } },
            itemIdentity: ["timestamp"],
          },
        },
      },
    } as OimManifest);
    const h = harness(({ operationId }) =>
      operationId === "list-pages" ? { body: listPage(["1"]) } : { body: ACL_OK }
    );

    const result = await syncOimKnowledge(strictPlan, h.deps, options);

    expect(result.failures).toEqual([{ code: "mapping_failed", scope: "ENG" }]);
    expect(h.saved).toEqual([]);
    expect(h.sink.emitSource).not.toHaveBeenCalled();
  });

  // An item indexed with unknown readers is an item the index may show to somebody the provider
  // would refuse, so it keeps its record and loses its content.
  it("records an item without content when its ACL is unverifiable", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: { results: [] } };
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(plan, h.deps, options);
    expect(result).toMatchObject({ unverifiable: 1, indexed: 0 });
    expect(h.sink.emitSource).toHaveBeenCalledWith(
      expect.objectContaining({ verification: "unverifiable" })
    );
    expect(h.sink.removeSourceContent).toHaveBeenCalledWith("b1", "wiki:conn-1/1");
    expect(h.sink.emitChunk).not.toHaveBeenCalled();
  });

  it("never fetches content it could not authorize", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: { results: [] } };
      return { body: CONTENT_OK };
    });
    await syncOimKnowledge(plan, h.deps, options);
    expect(h.calls.map((call) => call.operationId)).not.toContain("get-page");
  });

  it("isolates one item's failure from the rest of the scope", async () => {
    const h = harness(({ operationId, parameters }) => {
      if (operationId === "list-pages") return { body: listPage(["1", "2"]) };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      if (parameters.id === "1") throw new Error("provider refused");
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(plan, h.deps, options);
    expect(result.indexed).toBe(1);
    expect(result.failures).toEqual([{ code: "content_failed", scope: "ENG", itemId: "1" }]);
  });

  // Advancing first is how a crash skips content permanently; re-reading a page is only wasteful.
  it("leaves the checkpoint alone when any item in the run failed", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") throw new Error("nope");
      return { body: CONTENT_OK };
    });
    await syncOimKnowledge(plan, h.deps, options);
    expect(h.saved).toEqual([]);
  });

  it("advances the checkpoint after a clean walk", async () => {
    const h = harness(({ operationId, pageToken }) => {
      if (operationId === "list-pages") {
        return pageToken === undefined
          ? { body: listPage(["1"]), nextPageToken: "p2" }
          : { body: listPage(["2"]) };
      }
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(plan, h.deps, options);
    expect(result.itemsProcessed).toBe(2);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ scopeKey: "space:ENG", cursor: undefined });
  });

  it("stops at the manifest's page bound and keeps the token for the next Run", async () => {
    const bounded = compileKnowledgeProfile(
      knowledgeManifestFixture({
        list: { ...knowledgeManifestFixture().knowledge?.list, maxPagesPerRun: 2 },
      })
    );
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]), nextPageToken: "more" };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(bounded, h.deps, options);
    expect(result.itemsProcessed).toBe(2);
    expect(h.saved[0]?.cursor).toBe("more");
  });

  it("resumes a response-pointer cursor by feeding the saved watermark back", async () => {
    const watermarked = compileKnowledgeProfile(
      knowledgeManifestFixture({
        list: {
          ...knowledgeManifestFixture().knowledge?.list,
          cursor: {
            kind: "response_pointer",
            pointer: "/lastModified",
            requestParameter: "since",
          },
        },
      })
    );
    const h = harness(
      ({ operationId }) => {
        if (operationId === "list-pages") {
          return { body: listPage(["1"], { lastModified: "2026-01-31T00:00:00.000Z" }) };
        }
        if (operationId === "get-restrictions") return { body: ACL_OK };
        return { body: CONTENT_OK };
      },
      {
        integrationId: "int-1",
        scopeKey: "space:ENG",
        cursor: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }
    );
    await syncOimKnowledge(watermarked, h.deps, options);
    expect(h.calls[0]?.parameters).toMatchObject({ since: "2026-01-01T00:00:00.000Z" });
    expect(h.saved[0]?.cursor).toBe("2026-01-31T00:00:00.000Z");
  });

  it("propagates a provider deletion flag into a removal", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") {
        return {
          body: { results: [{ id: "1", version: { number: 2 }, archived: true }] },
        };
      }
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(plan, h.deps, options);
    expect(result.removed).toBe(1);
    expect(h.sink.emitSource).toHaveBeenCalledWith(expect.objectContaining({ status: "deleted" }));
    expect(h.sink.removeSourceContent).toHaveBeenCalledWith("b1", "wiki:conn-1/1");
  });

  it("removes what a full walk no longer sees", async () => {
    const fullWalk = compileKnowledgeProfile(
      knowledgeManifestFixture({
        list: { ...knowledgeManifestFixture().knowledge?.list, cursor: { kind: "none" } },
        deletion: { kind: "absent_from_full_list" },
      })
    );
    const h = harness(
      ({ operationId }) => {
        if (operationId === "list-pages") return { body: listPage(["1"]) };
        if (operationId === "get-restrictions") return { body: ACL_OK };
        return { body: CONTENT_OK };
      },
      {
        integrationId: "int-1",
        scopeKey: "space:ENG",
        seenItemIds: ["1", "2"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }
    );
    const result = await syncOimKnowledge(fullWalk, h.deps, options);
    expect(result.removed).toBe(1);
    expect(h.sink.removeSourceContent).toHaveBeenCalledWith("b1", "wiki:conn-1/2");
    expect(h.saved[0]?.seenItemIds).toEqual(["1"]);
  });

  // Half a walk is half the ids, and deleting the difference then empties the index of everything
  // the provider paginated past.
  it("never removes by absence after a walk that did not finish", async () => {
    const fullWalk = compileKnowledgeProfile(
      knowledgeManifestFixture({
        list: {
          ...knowledgeManifestFixture().knowledge?.list,
          cursor: { kind: "none" },
          maxPagesPerRun: 1,
        },
        deletion: { kind: "absent_from_full_list" },
      })
    );
    const h = harness(
      ({ operationId }) => {
        if (operationId === "list-pages") return { body: listPage(["1"]), nextPageToken: "more" };
        if (operationId === "get-restrictions") return { body: ACL_OK };
        return { body: CONTENT_OK };
      },
      {
        integrationId: "int-1",
        scopeKey: "space:ENG",
        seenItemIds: ["1", "2"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }
    );
    const result = await syncOimKnowledge(fullWalk, h.deps, options);
    expect(result.removed).toBe(0);
    expect(h.saved[0]?.seenItemIds).toEqual(["1", "2"]);
  });

  it("runs a declared deletion sweep after a complete walk", async () => {
    const swept = compileKnowledgeProfile(
      knowledgeManifestFixture({
        deletion: {
          kind: "operation",
          operationId: "list-spaces",
          itemsPointer: "/removed",
          itemIdPointer: "/id",
        },
      })
    );
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      if (operationId === "list-spaces") return { body: { removed: [{ id: "9" }] } };
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(swept, h.deps, options);
    expect(result.removed).toBe(1);
    expect(h.sink.removeSourceContent).toHaveBeenCalledWith("b1", "wiki:conn-1/9");
  });

  it("binds declared scope fields into a deletion sweep", async () => {
    const manifest = knowledgeManifestFixture();
    const swept = compileKnowledgeProfile({
      ...manifest,
      profiles: { ...manifest.profiles, knowledge: "1.1" },
      knowledge: {
        ...manifest.knowledge,
        list: {
          ...manifest.knowledge?.list,
          mapping: {
            ...manifest.knowledge?.list.mapping,
            itemFields: { space: { source: "scope" } },
          },
        },
        deletion: {
          kind: "operation",
          operationId: "list-spaces",
          parameters: { spaceKey: "space" },
          itemsPointer: "/removed",
          itemIdPointer: "/id",
        },
      },
    } as OimManifest);
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage([]) };
      if (operationId === "list-spaces") return { body: { removed: [] } };
      return { body: CONTENT_OK };
    });

    await syncOimKnowledge(swept, h.deps, options);

    expect(h.calls).toContainEqual(
      expect.objectContaining({
        operationId: "list-spaces",
        parameters: { spaceKey: "ENG" },
      })
    );
  });

  it("reports a failed sweep instead of treating it as nothing deleted", async () => {
    const swept = compileKnowledgeProfile(
      knowledgeManifestFixture({
        deletion: {
          kind: "operation",
          operationId: "list-spaces",
          itemsPointer: "/removed",
          itemIdPointer: "/id",
        },
      })
    );
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage([]) };
      if (operationId === "list-spaces") throw new Error("sweep failed");
      return { body: CONTENT_OK };
    });
    const result = await syncOimKnowledge(swept, h.deps, options);
    expect(result.failures).toEqual([{ code: "deletion_sweep_failed", scope: "ENG" }]);
  });

  it("keeps one failing scope from stopping the others", async () => {
    const h = harness(({ operationId, parameters }) => {
      if (operationId === "list-pages") {
        if (parameters.spaceKey === "BAD") throw new Error("no such space");
        return { body: listPage(["1"]) };
      }
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });

    const result = await syncOimKnowledge(plan, h.deps, {
      ...options,
      scopes: ["BAD", "ENG"],
    });
    expect(result.scopesProcessed).toBe(2);
    expect(result.indexed).toBe(1);
    expect(result.failures).toEqual([{ code: "list_failed", scope: "BAD" }]);
  });

  it("reports a retry-needed scope failure without advancing its checkpoint", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") {
        throw new OimKnowledgeRetryRequiredError(operationId);
      }
      return { body: CONTENT_OK };
    });

    const result = await syncOimKnowledge(plan, h.deps, options);

    expect(result.failures).toEqual([{ code: "retry_required", scope: "ENG" }]);
    expect(h.saved).toHaveLength(0);
    expect(h.sink.emitSource).not.toHaveBeenCalled();
  });

  it("reads a scope-level ACL once rather than once per item", async () => {
    const scoped = compileKnowledgeProfile(
      knowledgeManifestFixture({
        acl: {
          mode: "scope",
          operationId: "get-restrictions",
          scopeParameter: "id",
          entriesPointer: "/results",
          entry: {
            kindPointer: "/type",
            kindValues: { user: ["known"] },
            providerUserId: "/accountId",
          },
        },
        identity: undefined,
      })
    );
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1", "2"]) };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });
    await syncOimKnowledge(scoped, h.deps, options);
    expect(h.calls.filter((call) => call.operationId === "get-restrictions")).toHaveLength(1);
  });

  it("serves sensitive content live rather than from a captured snapshot", async () => {
    const manifest = knowledgeManifestFixture();
    const operations = manifest.operations.map((operation) =>
      operation.id === "get-page" ? { ...operation, effect: "sensitive_read" as const } : operation
    );
    const sensitive = compileKnowledgeProfile({ ...manifest, operations });
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") return { body: ACL_OK };
      return { body: CONTENT_OK };
    });
    await syncOimKnowledge(sensitive, h.deps, options);
    expect(h.sink.emitSource).toHaveBeenCalledWith(
      expect.objectContaining({ accessControl: { mode: "live", maximumAgeSeconds: 60 } })
    );
  });

  it("records an item without content when a group grant cannot be expanded", async () => {
    const h = harness(({ operationId }) => {
      if (operationId === "list-pages") return { body: listPage(["1"]) };
      if (operationId === "get-restrictions") {
        return { body: { results: [{ type: "group", groupId: "g1" }] } };
      }
      return { body: CONTENT_OK };
    });
    const deps: OimKnowledgeSyncDeps = {
      ...h.deps,
      identity: {
        ...h.deps.identity,
        accounts: { account: async () => undefined, groupMembers: async () => undefined },
      },
    };
    const result = await syncOimKnowledge(plan, deps, options);
    expect(result.unverifiable).toBe(1);
    expect(h.sink.emitChunk).not.toHaveBeenCalled();
  });
});
