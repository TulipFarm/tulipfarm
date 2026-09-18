import { McpIntegrationError, mcpServerRevision, mcpToolContract } from "@tulipfarm/integrations";
import { routineStateDefinitionRef } from "@tulipfarm/run-kernel";
import {
  canonicalHash,
  type McpExecutionBinding,
  type McpIntegrationDefinition,
  type routine,
} from "@tulipfarm/schema";
import type { BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { InternalRoutineMcpToolHost } from "./routine-mcp-tool-host";

const businessId = "business-1";
const runId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const claim = { leaseOwner: "worker-1", leaseGeneration: 1 };

function setup() {
  const definition: McpIntegrationDefinition = {
    server: {
      id: "example",
      label: "Example",
      transport: { type: "streamable-http", url: "https://mcp.example.com" },
    },
    enabled: true,
    reviewed: {
      tools: [
        {
          name: "search",
          digest: "b".repeat(64),
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          mutating: false,
          requiresApproval: false,
        },
      ],
      resources: [],
      prompts: [],
    },
  };
  const contract = mcpToolContract(
    "example",
    mcpServerRevision(definition),
    definition.reviewed.tools[0]
  );
  const document: routine.RoutineDefinition = {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: routineId,
      slug: "search",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      owner: "muskan",
      start: "Search",
      states: [
        {
          name: "Search",
          type: "tool",
          end: true,
          toolRef: { name: contract.spec.toolId, version: contract.spec.toolVersion },
          action: contract.spec.action,
        },
      ],
    },
  };
  const definitions: BundleDefinition[] = [document, contract].map((entry) => ({
    kind: entry.kind,
    id: entry.metadata.id,
    slug: entry.metadata.slug,
    authoredVersion: 1,
    hash: canonicalHash(entry),
    document: entry,
    references: [],
  }));
  const content = stringify(definition);
  const bundle: RuntimeBundle = {
    digest: "a".repeat(64),
    businessId,
    changesetId: "change-1",
    commitSha: "commit-1",
    definitions,
    assets: [
      {
        ownerDefinitionId: "Integration:example",
        path: "mcp.yaml",
        digest: canonicalHash(content),
        content,
      },
    ],
    get: (kind, slug) => definitions.find((entry) => entry.kind === kind && entry.slug === slug),
    getById: (id) => definitions.find((entry) => entry.id === id),
    asset: (id, path) =>
      bundle.assets.find((entry) => entry.ownerDefinitionId === id && entry.path === path),
  };
  const runBundle = { digest: bundle.digest, routineId, routineVersion: "1" };
  const binding: McpExecutionBinding = {
    serverId: "example",
    serverRevision: mcpServerRevision(definition),
    accountId: "account-1",
    accountRevision: "1",
    subjectId: "muskan",
    authorizationId: "grant-1",
  };
  const service = {
    bind: vi.fn(async () => binding),
    callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "found" }] })),
  };
  const authorize = { authorize: vi.fn(async () => true) };
  const activeBundle = vi.fn(async (): Promise<RuntimeBundle | undefined> => bundle);
  const runs = {
    claim: vi.fn(async () => ({
      authority: {
        businessId,
        runId,
        source: "routine",
        routineId,
        bundleDigest: bundle.digest,
        subject: { kind: "user", id: "muskan" },
      },
      bundle: runBundle,
      state: {
        key: "Search",
        definitionRef: routineStateDefinitionRef(runBundle, "Search"),
        status: "running" as const,
      },
    })),
  };
  const host = new InternalRoutineMcpToolHost({
    businessId,
    runs,
    bundles: { load: async () => bundle },
    activeBundle,
    service,
    effects: new MemoryEffectStore(),
    authorize,
    mutationGuard: { assertAllowed: async () => {} },
    dispatchFence: { claim: async () => true },
  });
  return { host, service, authorize, activeBundle, binding, bundle, document };
}

describe("Routine MCP Tool host", () => {
  it("binds the exact account using pinned State and server, not Worker tool arguments", async () => {
    const { host, service, binding } = setup();
    await expect(
      host.prepare(runId, { stateKey: "Search", arguments: { query: "ticket" }, claim, binding })
    ).resolves.toMatchObject({ kind: "ready", mcp: binding });
    expect(service.bind).toHaveBeenCalledWith(
      "example",
      { principal: { kind: "user", id: "muskan" }, runId, routineId },
      { kind: "tool", name: "search" },
      binding
    );
  });
  it("refuses changed published Routine material rather than running live replacement code", async () => {
    const { host, activeBundle, bundle, document } = setup();
    const changed = { ...document, spec: { ...document.spec, owner: "different-owner" } };
    activeBundle.mockResolvedValue({
      ...bundle,
      getById: (id) =>
        id === routineId ? { ...bundle.definitions[0], document: changed } : bundle.getById(id),
    });
    await expect(
      host.prepare(runId, { stateKey: "Search", arguments: { query: "ticket" }, claim })
    ).resolves.toEqual({ kind: "failed", reason: "routine_configuration_changed" });
  });
  it("checks live Tool authority before acquiring account credentials", async () => {
    const { host, authorize, service } = setup();
    authorize.authorize.mockResolvedValue(false);
    await expect(
      host.prepare(runId, { stateKey: "Search", arguments: { query: "ticket" }, claim })
    ).resolves.toEqual({ kind: "failed", reason: "authorization_revoked" });
    expect(service.bind).not.toHaveBeenCalled();
  });
  it("rejects a revoked pinned account and cannot replay an unrelated completed effect", async () => {
    const { host, service, binding } = setup();
    service.bind.mockRejectedValue(new McpIntegrationError("forbidden", "revoked"));
    await expect(
      host.prepare(runId, { stateKey: "Search", arguments: { query: "ticket" }, claim, binding })
    ).resolves.toEqual({ kind: "failed", reason: "forbidden" });
    await expect(host.reauthorize(runId, { stateKey: "Search", claim, binding })).resolves.toEqual({
      kind: "failed",
      reason: "effect_binding_mismatch",
    });
  });
});
