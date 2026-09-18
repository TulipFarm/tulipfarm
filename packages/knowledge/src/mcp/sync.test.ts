import { describe, expect, it, vi } from "vitest";
import { decideSourceAccess } from "../acl";
import { InMemoryKnowledgeIndex } from "../indexing";
import {
  enqueueInvalidation,
  INVALIDATION_TARGET_KINDS,
  InMemoryInvalidationQueue,
  runInvalidation,
} from "../invalidate";
import { retrieve } from "../retrieve";
import { InMemoryKnowledgeSourceStore, type KnowledgeSourceRecord } from "../source";
import { evaluateStaleness } from "../staleness";
import { mcpKnowledgeSourceId, readGithubKnowledgeFile } from "./github-file";
import { createMcpKnowledgeLiveAccess, mcpKnowledgeFreshness } from "./live";
import { removeMcpKnowledgeSource, syncMcpKnowledgeBatch } from "./sync";
import {
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  MCP_KNOWLEDGE_MAX_FILE_BYTES,
  MCP_KNOWLEDGE_MAX_STALE_MS,
  type McpKnowledgeCheckpoint,
  type McpKnowledgeReadPort,
  type McpKnowledgeSelection,
  type McpKnowledgeSyncDeps,
} from "./types";

const NOW = new Date("2026-09-18T09:00:00.000Z");
const SHA = "a".repeat(40);
const COMMIT = "b".repeat(40);
const binding = {
  businessId: "business-1",
  integrationId: "integration-1",
  accountId: "account-1",
  accountRevision: 1,
  ownerUserId: "user-1",
  externalAccountId: "42",
  configurationRevision: "config-1",
};
const file = { owner: "example", repo: "docs", path: "Guide.md", ref: "refs/heads/main" };
const selection: McpKnowledgeSelection = {
  id: "selection-1",
  revision: "selection-rev-1",
  binding,
  visibility: "personal",
  enabled: true,
  files: [file, { ...file, path: "Other.md" }],
};

function fixture() {
  const sources = new InMemoryKnowledgeSourceStore();
  const index = new InMemoryKnowledgeIndex();
  const queue = new InMemoryInvalidationQueue();
  const summaries = new Set<string>();
  let checkpoint: McpKnowledgeCheckpoint | undefined;
  const callTool = vi.fn<McpKnowledgeReadPort["callTool"]>(async (input) => {
    if (input.name === "get_me")
      return { content: [{ type: "text", text: JSON.stringify({ id: 42, login: "muskan" }) }] };
    return {
      content: [
        { type: "text", text: `successfully downloaded text file (SHA: ${SHA})` },
        {
          type: "resource",
          resource: {
            uri: `repo://example/docs/sha/${COMMIT}/contents/${input.arguments.path}`,
            mimeType: "text/plain; charset=utf-8",
            text: "The private release checklist",
          },
        },
      ],
    };
  });
  const read: McpKnowledgeReadPort = {
    binding,
    readerUserId: binding.ownerUserId,
    server: { distribution: "github-official-local", revision: GITHUB_KNOWLEDGE_SERVER_REVISION },
    callTool,
  };
  let invalidationId = 0;
  const invalidate = async (source: KnowledgeSourceRecord) => {
    const invalidation = {
      queue,
      now: () => NOW,
      newId: () => `invalidation-${invalidationId++}`,
      targets: INVALIDATION_TARGET_KINDS.map((kind) => ({
        kind,
        async purge(businessId: string, sourceId: string) {
          if (kind === "keyword_index") return index.removeSource(businessId, sourceId);
          if (kind === "summary") summaries.delete(sourceId);
          return 0;
        },
      })),
    };
    const job = await enqueueInvalidation(invalidation, {
      businessId: source.businessId,
      sourceId: source.sourceId,
      trigger: "revision_change",
    });
    const result = await runInvalidation(invalidation, job.jobId);
    expect(result.status).toBe("complete");
  };
  const deps: McpKnowledgeSyncDeps = {
    sources,
    read,
    now: () => NOW,
    assertCurrent: vi.fn(async () => {}),
    invalidate,
    sink: {
      emitSource: async (source) => sources.put(source),
      emitChunk: async (chunk) => index.upsert(chunk),
      removeSourceContent: async (businessId, sourceId) => {
        await index.removeSource(businessId, sourceId);
      },
    },
    checkpoints: {
      load: async () => checkpoint,
      save: async (_selection, value) => {
        checkpoint = value;
      },
    },
  };
  return { deps, sources, index, summaries, callTool, read, checkpoint: () => checkpoint };
}

async function firstSource(f: ReturnType<typeof fixture>): Promise<KnowledgeSourceRecord> {
  const source = await f.sources.get(
    binding.businessId,
    mcpKnowledgeSourceId(binding, file, selection.id)
  );
  if (!source) throw new Error("missing_fixture_source");
  return source;
}

describe("MCP selected-file sync through Knowledge ports", () => {
  it("resumes bounded partial scans, never deletes unseen files, and reports durable progress", async () => {
    const f = fixture();
    const first = await syncMcpKnowledgeBatch(selection, f.deps, { maxItems: 1 });
    expect(first).toMatchObject({ nextIndex: 1, synced: 1, complete: false, failed: 0 });
    const source = await firstSource(f);
    expect(source.sourceLocator).toMatchObject({ accountId: "account-1", visibility: "personal" });
    expect(source.lastSyncedAt).toBe(NOW.toISOString());
    const second = await syncMcpKnowledgeBatch(selection, f.deps, { maxItems: 1 });
    expect(second).toMatchObject({ nextIndex: 2, synced: 2, complete: true });
    expect(await f.sources.list(binding.businessId)).toHaveLength(2);
    f.callTool.mockRejectedValue(new Error("network outage"));
    const partial = await syncMcpKnowledgeBatch(selection, f.deps, { maxItems: 1 });
    expect(partial).toMatchObject({ complete: false, failed: 1, synced: 0 });
    expect(
      (await f.sources.list(binding.businessId)).every((item) => item.status === "active")
    ).toBe(true);
    expect((await firstSource(f)).lastSyncedAt).toBe(source.lastSyncedAt);
  });

  it("does not checkpoint failed durable publication and keeps incomplete content hidden", async () => {
    const f = fixture();
    const deps: McpKnowledgeSyncDeps = {
      ...f.deps,
      sink: {
        ...f.deps.sink,
        emitChunk: async () => {
          throw new Error("disk full");
        },
      },
    };
    await expect(syncMcpKnowledgeBatch(selection, deps)).rejects.toThrow("disk full");
    expect(f.checkpoint()).toBeUndefined();
    expect((await firstSource(f)).verification).toBe("unverifiable");
    await syncMcpKnowledgeBatch(selection, f.deps);
    expect((await firstSource(f)).verification).toBe("verified");
  });

  it("uses the existing live gate and index for private retrieval, never a saved ACL", async () => {
    const f = fixture();
    await syncMcpKnowledgeBatch(selection, f.deps);
    const live = createMcpKnowledgeLiveAccess({
      sources: f.sources,
      readerUserId: "user-1",
      now: () => NOW,
      open: async () => f.read,
    });
    const request = {
      businessId: binding.businessId,
      principalId: "user-1",
      principals: [{ kind: "user", id: "user-1" }],
      query: "release",
      limit: 5,
      guardrailEpoch: "1",
      contextEpoch: "1",
      correlationId: "correlation-1",
    };
    const allowed = await retrieve(
      { sources: f.sources, index: f.index, live, now: () => NOW },
      request
    );
    expect(allowed.candidates.length).toBeGreaterThan(0);
    f.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "provider failure" }],
    });
    const denied = await retrieve(
      { sources: f.sources, index: f.index, live, now: () => NOW },
      request
    );
    expect(denied.candidates).toEqual([]);
    expect((await firstSource(f)).status).toBe("active");
  });

  it("allows at most 24 hours of stale content only with successful live source reads", async () => {
    const f = fixture();
    await syncMcpKnowledgeBatch(selection, f.deps);
    const source = await firstSource(f);
    expect(evaluateStaleness(source, new Date(NOW.getTime() + 15 * 60 * 1000)).stale).toBe(false);
    expect(
      evaluateStaleness(source, new Date(NOW.getTime() + MCP_KNOWLEDGE_MAX_STALE_MS + 1000)).stale
    ).toBe(true);
    const request = {
      businessId: binding.businessId,
      principals: [{ kind: "user", id: "user-1" }],
    };
    for (const [offset, allowed] of [
      [MCP_KNOWLEDGE_MAX_STALE_MS, true],
      [MCP_KNOWLEDGE_MAX_STALE_MS + 1, false],
    ] as const) {
      const now = new Date(NOW.getTime() + offset);
      const live = createMcpKnowledgeLiveAccess({
        sources: f.sources,
        readerUserId: "user-1",
        now: () => now,
        open: async () => f.read,
      });
      expect((await decideSourceAccess(source, request, { live }, now)).allowed).toBe(allowed);
    }
    const live = createMcpKnowledgeLiveAccess({
      sources: f.sources,
      readerUserId: "user-1",
      now: () => NOW,
      open: async () => undefined,
    });
    expect((await decideSourceAccess(source, request, { live }, NOW)).allowed).toBe(false);
  });

  it("denies another reader, account, configuration or upstream identity", async () => {
    const f = fixture();
    await syncMcpKnowledgeBatch(selection, f.deps);
    const source = await firstSource(f);
    const wrongReader = createMcpKnowledgeLiveAccess({
      sources: f.sources,
      readerUserId: "user-2",
      now: () => NOW,
      open: async () => f.read,
    });
    expect(
      (
        await decideSourceAccess(
          source,
          {
            businessId: binding.businessId,
            principals: [
              { kind: "user", id: "user-1" },
              { kind: "user", id: "user-2" },
            ],
          },
          { live: wrongReader },
          NOW
        )
      ).allowed
    ).toBe(false);
    for (const changed of [
      { accountId: "account-2" },
      { accountRevision: 2 },
      { configurationRevision: "config-2" },
    ]) {
      await expect(
        readGithubKnowledgeFile({ ...f.read, binding: { ...binding, ...changed } }, binding, file)
      ).rejects.toMatchObject({ code: "identity_mismatch" });
      const live = createMcpKnowledgeLiveAccess({
        sources: f.sources,
        readerUserId: "user-1",
        now: () => NOW,
        open: async () => ({ ...f.read, binding: { ...binding, ...changed } }),
      });
      expect(
        (
          await decideSourceAccess(
            source,
            { businessId: binding.businessId, principals: [{ kind: "user", id: "user-1" }] },
            { live },
            NOW
          )
        ).allowed
      ).toBe(false);
    }
    f.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: '{"id":43}' }] });
    await expect(readGithubKnowledgeFile(f.read, binding, file)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("does not trust an old permission success after the selection is revoked", async () => {
    const f = fixture();
    await syncMcpKnowledgeBatch(selection, f.deps);
    const source = await firstSource(f);
    let enabled = true;
    const live = createMcpKnowledgeLiveAccess({
      sources: f.sources,
      readerUserId: "user-1",
      now: () => NOW,
      open: async () => (enabled ? f.read : undefined),
    });
    const request = {
      businessId: binding.businessId,
      principals: [{ kind: "user", id: "user-1" }],
    };
    expect((await decideSourceAccess(source, request, { live }, NOW)).allowed).toBe(true);
    enabled = false;
    expect((await decideSourceAccess(source, request, { live }, NOW)).allowed).toBe(false);
  });

  it("marks failed refreshes stale, refuses malformed time and stays hidden when purge fails", async () => {
    const f = fixture();
    await syncMcpKnowledgeBatch(selection, f.deps);
    const source = await firstSource(f);
    expect(mcpKnowledgeFreshness(source, NOW, undefined, true)).toMatchObject({
      usable: true,
      stale: true,
    });
    for (const lastSyncedAt of ["invalid", new Date(NOW.getTime() + 1).toISOString()]) {
      expect(mcpKnowledgeFreshness({ ...source, lastSyncedAt }, NOW).usable).toBe(false);
    }
    await expect(
      removeMcpKnowledgeSource(
        {
          ...f.deps,
          invalidate: async () => {
            throw new Error("purge unavailable");
          },
        },
        {
          businessId: binding.businessId,
          sourceId: source.sourceId,
          accountId: binding.accountId,
          reason: "disconnected",
        }
      )
    ).rejects.toThrow("purge unavailable");
    expect((await firstSource(f)).status).toBe("revoked");
  });

  it("hides revoked copies before purge, invalidates derived summaries and leaves authored notes alone", async () => {
    const f = fixture();
    await syncMcpKnowledgeBatch(selection, f.deps);
    const source = await firstSource(f);
    f.summaries.add(source.sourceId);
    const note: KnowledgeSourceRecord = {
      ...source,
      sourceId: "authored-note",
      provider: "tulipfarm",
      sourceLocator: undefined,
    };
    await f.sources.put(note);
    await removeMcpKnowledgeSource(f.deps, {
      businessId: binding.businessId,
      sourceId: source.sourceId,
      accountId: binding.accountId,
      reason: "source_access_lost",
    });
    expect((await firstSource(f)).status).toBe("revoked");
    expect(f.summaries.has(source.sourceId)).toBe(false);
    expect(
      await f.index.search({
        businessId: binding.businessId,
        query: "release",
        limit: 5,
        allowedSourceIds: new Set([source.sourceId]),
      })
    ).toEqual([]);
    expect(await f.sources.get(binding.businessId, "authored-note")).toEqual(note);
    await expect(
      removeMcpKnowledgeSource(f.deps, {
        businessId: binding.businessId,
        sourceId: note.sourceId,
        accountId: binding.accountId,
        reason: "removed",
      })
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("rejects unsupported shared sources, disabled opt-in, fuzzy results, and oversized content", async () => {
    const f = fixture();
    await expect(
      syncMcpKnowledgeBatch({ ...selection, visibility: "shared" }, f.deps)
    ).rejects.toMatchObject({ code: "unsupported_shared_sync" });
    await expect(
      syncMcpKnowledgeBatch({ ...selection, enabled: false }, f.deps)
    ).rejects.toMatchObject({ code: "invalid_selection" });
    f.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: '{"id":42}' }] });
    f.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "matched other file" }] });
    await expect(readGithubKnowledgeFile(f.read, binding, file)).rejects.toMatchObject({
      code: "source_response_invalid",
    });
    f.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: '{"id":42}' }] });
    f.callTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: `successfully downloaded text file (SHA: ${SHA})` },
        {
          type: "resource",
          resource: {
            uri: `repo://example/docs/sha/${COMMIT}/contents/Guide.md`,
            mimeType: "text/plain",
            text: "x".repeat(MCP_KNOWLEDGE_MAX_FILE_BYTES + 1),
          },
        },
      ],
    });
    await expect(readGithubKnowledgeFile(f.read, binding, file)).rejects.toMatchObject({
      code: "source_too_large",
    });
  });
});
