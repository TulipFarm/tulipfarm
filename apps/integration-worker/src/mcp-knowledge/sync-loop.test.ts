import { InMemoryKnowledgeSourceStore } from "@tulipfarm/knowledge";
import {
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  MCP_KNOWLEDGE_POLL_INTERVAL_MS,
  type McpKnowledgeCheckpoint,
  type McpKnowledgeSelection,
  type McpKnowledgeSyncDeps,
} from "@tulipfarm/knowledge/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  type McpKnowledgeJob,
  type McpKnowledgeJobPort,
  type McpKnowledgeWorkerDeps,
  runMcpKnowledgeCycle,
  startMcpKnowledgeSyncLoop,
} from "./sync-loop";

const NOW = new Date("2026-09-18T09:00:00.000Z");
const binding = {
  businessId: "business-1",
  integrationId: "integration-1",
  accountId: "account-1",
  accountRevision: 1,
  ownerUserId: "user-1",
  externalAccountId: "42",
  configurationRevision: "config-1",
};

function fixture(fileCount = 1) {
  const sources = new InMemoryKnowledgeSourceStore();
  const selection: McpKnowledgeSelection = {
    id: "selection-1",
    revision: "revision-1",
    binding,
    visibility: "personal",
    enabled: true,
    files: Array.from({ length: fileCount }, (_, index) => ({
      owner: "example",
      repo: "docs",
      path: `${index}.md`,
      ref: "refs/heads/main",
    })),
  };
  const job: McpKnowledgeJob = { leaseId: "lease-1", selection };
  let checkpoint: McpKnowledgeCheckpoint | undefined;
  let dueAt = NOW;
  let leased = false;
  const finish = vi.fn<McpKnowledgeJobPort["finish"]>(async (_job, _result, next) => {
    dueAt = next;
    leased = false;
  });
  const jobs: McpKnowledgeJobPort = {
    claimDue: vi.fn(async ({ now }) => {
      if (leased || now.getTime() < dueAt.getTime()) return [];
      leased = true;
      return [job];
    }),
    finish,
    requestSync: async (input) => {
      if (
        input.businessId !== binding.businessId ||
        input.accountId !== binding.accountId ||
        input.selectionId !== selection.id
      )
        throw new Error("selection_mismatch");
      dueAt = NOW;
    },
  };
  const sync: McpKnowledgeSyncDeps = {
    sources,
    read: {
      binding,
      readerUserId: binding.ownerUserId,
      server: { distribution: "github-official-local", revision: GITHUB_KNOWLEDGE_SERVER_REVISION },
      async callTool(input) {
        if (input.name === "get_me") return { content: [{ type: "text", text: '{"id":42}' }] };
        return {
          content: [
            { type: "text", text: `successfully downloaded text file (SHA: ${"a".repeat(40)})` },
            {
              type: "resource",
              resource: {
                uri: `repo://example/docs/sha/${"b".repeat(40)}/contents/${input.arguments.path}`,
                mimeType: "text/plain",
                text: "private document",
              },
            },
          ],
        };
      },
    },
    now: () => NOW,
    assertCurrent: async () => {},
    invalidate: async () => {},
    sink: {
      emitSource: async (source) => sources.put(source),
      emitChunk: async () => {},
      removeSourceContent: async () => {},
    },
    checkpoints: {
      load: async () => checkpoint,
      save: async (_selection, value) => {
        checkpoint = value;
      },
    },
  };
  const deps: McpKnowledgeWorkerDeps = {
    jobs,
    open: async () => sync,
    now: () => NOW,
    log: { warn: vi.fn() },
  };
  return { deps, sync, job, jobs, sources, finish };
}

describe("MCP Knowledge worker scheduling", () => {
  it("runs a real selected-file batch and defaults to 15-minute polling", async () => {
    const f = fixture();
    await runMcpKnowledgeCycle(f.deps, new AbortController().signal);
    expect(await f.sources.list(binding.businessId)).toHaveLength(1);
    expect(f.finish).toHaveBeenCalledWith(
      f.job,
      {
        status: "progress",
        checkpoint: expect.objectContaining({ synced: 1, complete: true }),
      },
      new Date(NOW.getTime() + MCP_KNOWLEDGE_POLL_INTERVAL_MS)
    );
    await runMcpKnowledgeCycle(f.deps, new AbortController().signal);
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it("resumes partial progress soon instead of waiting the full poll interval", async () => {
    const f = fixture(21);
    await runMcpKnowledgeCycle(f.deps, new AbortController().signal);
    expect(f.finish).toHaveBeenCalledWith(
      f.job,
      {
        status: "progress",
        checkpoint: expect.objectContaining({ synced: 20, complete: false }),
      },
      new Date(NOW.getTime() + 1000)
    );
    await runMcpKnowledgeCycle(
      { ...f.deps, now: () => new Date(NOW.getTime() + 1000) },
      new AbortController().signal
    );
    expect(f.finish).toHaveBeenLastCalledWith(
      f.job,
      {
        status: "progress",
        checkpoint: expect.objectContaining({ synced: 21, complete: true }),
      },
      new Date(NOW.getTime() + 1000 + MCP_KNOWLEDGE_POLL_INTERVAL_MS)
    );
  });

  it.each(["manual", "notification"] as const)(
    "allows %s requests to accelerate durable due work",
    async (reason) => {
      const f = fixture();
      await runMcpKnowledgeCycle(f.deps, new AbortController().signal);
      await f.jobs.requestSync({
        businessId: binding.businessId,
        accountId: binding.accountId,
        selectionId: f.job.selection.id,
        reason,
      });
      await runMcpKnowledgeCycle(f.deps, new AbortController().signal);
      expect(f.finish).toHaveBeenCalledTimes(2);
    }
  );

  it("records actionable failure without private exception data and drains on abort", async () => {
    const f = fixture();
    const controller = new AbortController();
    const loop = startMcpKnowledgeSyncLoop(controller.signal, {
      ...f.deps,
      open: async () => {
        throw new Error("private document token");
      },
      wait: async () => {
        controller.abort();
      },
    });
    await loop.settled;
    expect(f.finish).toHaveBeenCalledWith(
      f.job,
      { status: "failed", code: "sync_failed" },
      expect.any(Date)
    );
    expect(f.deps.log.warn).toHaveBeenCalledWith("MCP Knowledge sync batch failed");
    expect(JSON.stringify(f.finish.mock.calls)).not.toContain("private document token");
  });
});
